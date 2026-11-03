// A stand-in for herdr-core's `hc`, for the CLI tests: every call is appended to
// $HC_FAKE_LOG as one JSON argv line, and answers come from the terminals in
// $HC_FAKE_STATE ({ terminals: [hc get objects], next: number }), which `label` and `run`
// change. Only the calls automagik-herdr makes: ls [--label k=v], get, read, label, run,
// server status (state.core), kill (the terminal finishes), templates (state.templates:
// [{ name, command }]), machine ls and exec --on (state.machines: [{ name, state, uname, home,
// path?, temporary? }]: a linked machine is a scratch home folder; its `uname -sm` is `uname`,
// anything else runs here with HOME=home and `path` (a folder of fakes) first on PATH, in
// --cwd or its home), and file read|edit --on (its files are paths here; hc's answers: exit 3
// not_found, 1 edit_failed or unavailable, 4 machine_unknown, errors as JSON on stderr).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.HC_FAKE_LOG, `${JSON.stringify(args)}\n`);
const state = JSON.parse(readFileSync(process.env.HC_FAKE_STATE, "utf8"));
const save = () => writeFileSync(process.env.HC_FAKE_STATE, JSON.stringify(state, null, 2));
const out = (x) => process.stdout.write(`${JSON.stringify(x)}\n`);
const fail = (msg, code = 1) => { process.stderr.write(`${msg}\n`); process.exit(code); };
const words = args.filter((a) => a !== "--json");
const find = (t) => state.terminals.find((x) => x.address === t || x.name === t);
// state.fail: commands that fail as a server that is down would (exit 1).
if ((state.fail ?? []).includes(words[0])) fail(`hc: can't reach the server (${words[0]})`);
// A linked machine's terminal ("vm/t8") on a machine that isn't connected: unavailable, as hc says.
if (["get", "label", "kill", "read", "send", "keys", "interrupt"].includes(words[0]) && words[1]?.includes("/")) {
  const m = (state.machines ?? []).find((x) => x.name === words[1].split("/")[0]);
  if (!m || m.state !== "connected") fail(JSON.stringify({ error: { kind: m ? "unavailable" : "machine_unknown", message: `${words[1].split("/")[0]} isn't connected` } }), m ? 1 : 4);
}

switch (words[0]) {
  case "ls": {
    const want = [];
    for (let i = 1; i < words.length; i += 1) if (words[i] === "--label") want.push(words[++i]);
    const rows = state.terminals.filter((t) => t.state !== "finished" && want.every((kv) => {
      const [k, v] = [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)];
      return (t.labels ?? {})[k] === v;
    }));
    // Like the real one: rows carry no labels and no created_ms.
    out({ terminals: rows.map(({ address, name, cwd, state: s, parent, status }) => ({ address, name, cwd, state: s, parent, status: status?.state, agent: status?.app })) });
    break;
  }
  case "get": {
    const t = find(words[1]);
    // Like the real one: exit 3 and a not_found error on stderr.
    if (!t) fail(JSON.stringify({ error: { kind: "not_found", message: `no terminal "${words[1]}"` } }), 3);
    // exitAfterGets: answered live that many times, then the program exits (a failed resume).
    if (typeof t.exitAfterGets === "number") {
      if (t.exitAfterGets <= 0) { t.state = "finished"; delete t.exitAfterGets; } else t.exitAfterGets -= 1;
      save();
    }
    out(t);
    break;
  }
  case "read": {
    const t = find(words[1]);
    if (!t) fail(`no terminal ${words[1]}`);
    out({ text: t.screen ?? "" });
    break;
  }
  case "label": {
    const t = find(words[1]);
    if (!t) fail(`no terminal ${words[1]}`);
    if (state.failLabel === words[1]) fail(`label refused on ${words[1]}`);
    t.labels ??= {};
    for (const kv of words.slice(2)) {
      const eq = kv.indexOf("=");
      const [k, v] = [kv.slice(0, eq), kv.slice(eq + 1)];
      if (v === "") delete t.labels[k]; else t.labels[k] = v;
    }
    save();
    out({ address: t.address, labels: t.labels });
    break;
  }
  case "run": {
    const labels = {};
    let name = null, cwd = null, parent = null, outlive = false, on = null;
    let i = 1;
    // Options, then argv: after `--`, or from the first word that isn't an option (a template).
    for (; i < words.length && words[i] !== "--" && words[i].startsWith("--"); i += 1) {
      if (words[i] === "--label") { const kv = words[++i]; labels[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1); }
      else if (words[i] === "--name") name = words[++i];
      else if (words[i] === "--cwd") cwd = words[++i];
      else if (words[i] === "--parent") parent = words[++i];
      else if (words[i] === "--on") on = words[++i];
      else if (words[i] === "--outlive-parent") outlive = true;
    }
    const argv = words.slice(words[i] === "--" ? i + 1 : i);
    // `env K=V … program …`: the program is the first word after the assignments.
    const program = /(^|\/)env$/.test(argv[0] ?? "") ? argv.slice(1).find((a) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) : argv[0];
    // --on M: a linked machine's terminal, addressed "M/tN" (refused when M isn't connected).
    if (on) {
      const m = (state.machines ?? []).find((x) => x.name === on);
      if (!m) fail(JSON.stringify({ error: { kind: "machine_unknown", message: `unknown machine "${on}"` } }), 4);
      if (m.state !== "connected") fail(JSON.stringify({ error: { kind: "unavailable", message: `${on} isn't connected` } }));
    }
    const n = state.next ?? 100;
    const address = on ? `${on}/t${n}` : `t${n}`;
    state.next = n + 1;
    // state.runAs: "shell" (the agent never comes in front), "exit" (it ends at once) or
    // "flaky" (its agent is in front for one hc get, then it exits).
    const shell = state.runAs === "shell";
    state.terminals.push({ address, name, cwd, labels, parent, die_with_parent: Boolean(parent) && !outlive, state: state.runAs === "exit" ? "finished" : "live", created_ms: Date.now(),
      pid: 9000 + n, foreground: { argv: shell ? ["zsh"] : argv, cwd, pid: 5000 + n }, // state.noStatus: programs that report no status to hc (hermes): status null.
      status: (state.noStatus ?? []).includes(program) ? null : { app: program === "claude" ? "claude-code" : program, state: "working" },
      ...(state.runAs === "flaky" ? { exitAfterGets: 1 } : {}) });
    // state.onRunWrite: { path, text }: a file edit that lands while this run happens.
    if (state.onRunWrite) writeFileSync(state.onRunWrite.path, state.onRunWrite.text);
    save();
    out({ address });
    break;
  }
  case "kill": {
    const t = find(words[1]);
    if (!t) fail(`no terminal ${words[1]}`);
    if (state.failKill === words[1]) fail(`kill refused on ${words[1]}`);
    t.state = "finished";
    save();
    out({ address: t.address, state: t.state });
    // Killing the caller's own terminal ends the caller (this fake runs exec'd by the wrapper,
    // so its parent is the program that called hc).
    if (process.env.HC_TERMINAL_ID && [t.address, t.name].includes(process.env.HC_TERMINAL_ID)) process.kill(process.ppid, "SIGKILL");
    break;
  }
  case "server": {
    // `hc server status`: the core's permanent id (state.core, else a fixed one).
    if (words[1] !== "status") fail(`fake hc: no server ${words[1]}`, 2);
    out({ core: state.core ?? { id: "fakecore0000", name: "fake" }, live: state.terminals.filter((t) => t.state === "live").length });
    break;
  }
  case "templates": {
    if (!state.templates) fail("hc: no templates folder");
    out({ templates: state.templates });
    break;
  }
  case "machine": {
    if (words[1] !== "ls") fail(`fake hc: no machine ${words[1]}`, 2);
    out({ machines: (state.machines ?? []).map(({ name, id, state: s, temporary = false }) => ({ name, id: id ?? `core-${name}`, host: name, state: s, temporary, target: name })) });
    break;
  }
  case "exec": {
    // hc exec [--json] [--timeout N] [--on M] -- argv… (argv as given: not filtered for --json).
    let i = args.indexOf("exec") + 1, on = null, cwd = null;
    for (; i < args.length && args[i] !== "--"; i += 1) {
      if (args[i] === "--on") on = args[++i]; else if (args[i] === "--cwd") cwd = args[++i]; else if (args[i] === "--timeout") i += 1;
    }
    const argv = args.slice(i + 1);
    const m = (state.machines ?? []).find((x) => x.name === on);
    if (!m) fail(JSON.stringify({ error: { kind: "not_found", message: `no machine "${on}"` } }), 3);
    if (m.state !== "connected") fail(`hc: ${on} is not connected`);
    const b64 = (s) => Buffer.from(s ?? "").toString("base64");
    if (argv[0] === "uname") { out({ code: 0, stdout: b64(`${m.uname}\n`), stderr: "", timed_out: false }); break; }
    const r = spawnSync(argv[0], argv.slice(1), { cwd: cwd ?? m.home, encoding: "utf8",
      env: { ...process.env, HOME: m.home, PATH: `${m.path ? `${m.path}:` : ""}/usr/bin:/bin:/usr/sbin:/sbin` } });
    out({ code: r.status ?? -1, stdout: b64(r.stdout), stderr: b64(r.stderr), timed_out: false });
    break;
  }
  case "file": {
    // hc file read|edit --json --on M [--old=X --new=Y] <path>
    const err = (code, kind, message) => fail(JSON.stringify({ error: { kind, message } }), code);
    const on = args.includes("--on") ? args[args.indexOf("--on") + 1] : null;
    const m = (state.machines ?? []).find((x) => x.name === on);
    if (on && !m) err(4, "machine_unknown", `unknown machine "${on}"`);
    if (m && m.state !== "connected") err(1, "unavailable", `${on} is not connected`);
    const path = args.at(-1);
    if (!existsSync(path)) err(3, "not_found", `no file ${path}`);
    const text = readFileSync(path, "utf8");
    if (words[1] === "read") {
      const lines = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
      out({ first: 1, last: lines, lines, text });
      break;
    }
    if (words[1] !== "edit") err(2, "invalid_params", `fake hc: no file ${words[1]}`);
    const old = args.find((a) => a.startsWith("--old=")).slice(6), now = args.find((a) => a.startsWith("--new=")).slice(6);
    // state.editRace: someone's edit lands between the CLI's read and this edit.
    if (state.editRace) { writeFileSync(path, state.editRace); delete state.editRace; save(); }
    const current = readFileSync(path, "utf8");
    const at = current.indexOf(old);
    if (at < 0 || current.indexOf(old, at + 1) >= 0) err(1, "edit_failed", "the old text is not in the file");
    writeFileSync(path, current.slice(0, at) + now + current.slice(at + old.length));
    out({ bytes: now.length, path });
    break;
  }
  default:
    fail(`fake hc: no ${words[0]}`, 2);
}
