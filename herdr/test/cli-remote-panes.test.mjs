// automagik-herdr's pane commands on a linked machine (automagik#206 part b): start, attach,
// detach, restart and whois with --machine, against fake-hc's linked machine "vm" (a scratch
// home; its terminals are "vm/tN"). Shaped on the Atlas bot on g10: a Hermes pane under hc's
// keep wrapper, reporting no status. The ledger rows keep the bare terminal, `machine` and that
// machine's core id (bots.attach-ledger@1); whois keeps its shape (bots.whois-json@1). No call
// ever sends a pane keys. The real hc and window are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attachPath, readAttach } from "../mods/am-sidebar/attach.js";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const CORE = "core-of-vm";
const ATLAS = "b-atlasaaaaa", HEDGE = "b-hedgeaaaaa";
const KEEP = ["sh", "-c", "\"$@\"; exec \"${SHELL:-sh}\" -i", "sh", "hermes", "--tui"];
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };

function scene(t, { terminals = [], tui = true } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-panes-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), home = join(root, "home"), app = join(root, "app"), vm = join(root, "vm"), vmBin = join(root, "vm-bin");
  for (const d of [bin, home, app, vm, vmBin]) mkdirSync(d, { recursive: true });
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  // On vm: hermes and claude are installed (what `command -v` finds there).
  exe(join(vmBin, "hermes"), "#!/bin/sh\nexit 0\n");
  exe(join(vmBin, "claude"), "#!/bin/sh\nexit 0\n");
  // The owner's override, as programs.json holds it: Atlas runs the TUI.
  if (tui) writeFileSync(join(app, "programs.json"), JSON.stringify({ programs: { hermes: { run: ["hermes", "--tui"] } } }));
  const project = join(vm, "atlas");
  mkdirSync(project);
  execFileSync("git", ["init", "-q", project]);
  const look = { character: "star", colour: "blue" };
  mkdirSync(join(project, ".herdr"));
  writeFileSync(join(project, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [], bots: [
    { id: ATLAS, name: "Atlas", kind: "main", look, role: "incident agent", instructions: "", agent: "hermes" },
    { id: HEDGE, name: "Hedge", kind: "member", look, role: "r", instructions: "", agent: "claude" },
  ] }, null, 2)}\n`);
  const statePath = join(root, "hc.json"), logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ next: 100, noStatus: ["hermes"], terminals: terminals.map((x) => ({ cwd: project, ...x })),
    machines: [{ name: "vm", id: CORE, state: "connected", uname: "Linux x86_64", home: vm, path: vmBin }] }));
  writeFileSync(logPath, "");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath,
    AUTOMAGIK_HERDR_RESTART_STABLE_MS: "300", AUTOMAGIK_HERDR_RESTART_WAIT_MS: "4000" };
  delete env.HC_TERMINAL_ID;
  const cli = (args) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: root, env, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  const on = ["--machine", "vm", "--project", project];
  const calls = () => readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const hcState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const setState = (fn) => { const s = hcState(); fn(s); writeFileSync(statePath, JSON.stringify(s)); };
  const rows = () => (existsSync(attachPath(app)) ? readAttach(readFileSync(attachPath(app), "utf8")).rows : []);
  return { root, project, app, home, cli, on, calls, hcState, setState, rows };
}

// The Atlas pane as g10/t8 is: live, under the keep wrapper, no status reported.
const atlasPane = (extra = {}) => ({ address: "vm/t8", name: null, state: "live", created_ms: 1793316831846, parent: null, labels: {},
  foreground: { argv: KEEP, name: "sh" }, status: null, ...extra });
const keysSent = (calls) => calls.filter((c) => ["send", "keys", "interrupt"].includes(c[0]));

test("start --machine: hc run --on there with the Mac's agent table (programs.json's hermes --tui); the row keeps tN, machine and its core", (t) => {
  const s = scene(t);
  const r = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  assert.equal(out.terminal, "t100");
  assert.equal(out.machine, "vm");
  assert.deepEqual(out.argv, ["hermes", "--tui"], "the override, read on this computer, builds the command there");
  const run = s.calls().find((c) => c[0] === "run");
  assert.deepEqual(run.slice(0, 3), ["run", "--on", "vm"]);
  assert.ok(run.includes(`bot=${ATLAS}`) && run.includes(s.project));
  const [row] = s.rows();
  assert.deepEqual([row.event, row.terminal, row.machine, row.core, row.by], ["attach", "t100", "vm", CORE, "start"]);
  // A second start: already running, by its address.
  assert.match(s.cli(["start", "Atlas", ...s.on]).out, /Atlas is already running in vm\/t100/);
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 1);
  // ls: its status from the pane there.
  const ls = s.cli(["ls", ...s.on, "--json"]).json().projects[0].bots.find((b) => b.id === ATLAS);
  assert.deepEqual([ls.terminal, ls.machine, ls.status], ["t100", "vm", "running"]);
  assert.deepEqual(keysSent(s.calls()), []);
});

test("start --machine: an agent not installed there is refused before anything runs; without the override, plain hermes", (t) => {
  const s = scene(t, { tui: false });
  const plain = s.cli(["start", "Atlas", ...s.on, "--json"]);
  assert.equal(plain.code, 0, plain.err);
  assert.deepEqual(plain.json().argv, ["hermes"]);
  s.setState((st) => { st.machines[0].path = null; });
  const r = s.cli(["start", "Hedge", ...s.on]);
  assert.equal(r.code, 1);
  assert.match(r.err, /isn't installed on vm/);
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 1);
});

test("start --machine of a Claude bot: started with a warning and no briefing hook anywhere (part b2 installs it)", (t) => {
  const s = scene(t);
  const r = s.cli(["start", "Hedge", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /Hedge runs on vm without its per-turn briefing/);
  assert.match(r.json().warnings.join(" "), /automagik-herdr machine install vm/);
  assert.equal(existsSync(join(s.project, ".claude")), false, "no hook there pointing at a missing briefing.mjs");
  assert.equal(existsSync(join(s.home, ".claude")), false);
});

test("attach --machine vm/t8 as it is: labels only, the row's terminal is t8; whois keeps its shape, no '/' in it", (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  const r = s.cli(["attach", "Atlas", "vm/t8", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().terminal, r.json().machine], ["t8", "vm"]);
  const [row] = s.rows();
  assert.deepEqual([row.terminal, row.machine, row.core, row.by, row.created_ms], ["t8", "vm", CORE, "attach", 1793316831846]);
  assert.ok(s.calls().some((c) => c[0] === "label" && c[1] === "vm/t8" && c.includes(`bot=${ATLAS}`)));
  // The bare id with --machine names the same pane.
  assert.match(s.cli(["attach", "Atlas", "t8", ...s.on]).out, /Atlas is already vm\/t8/);
  for (const args of [["whois", "vm/t8", "--json"], ["whois", "--bot", ATLAS, "--json"]]) {
    const w = s.cli(args);
    assert.equal(w.code, 0, w.err);
    const out = w.json();
    assert.deepEqual(Object.keys(out).sort(), ["bot", "core", "created_ms", "project", "since", "terminal"], "bots.whois-json@1's keys");
    assert.deepEqual([out.terminal, out.core, out.bot], ["t8", CORE, ATLAS]);
    assert.ok(!Object.entries(out).some(([k, v]) => k !== "project" && typeof v === "string" && v.includes("/")), "no machine address in whois");
  }
  // Its status: the agent under the keep wrapper is in front, though it reports none.
  const ls = s.cli(["ls", ...s.on, "--json"]).json().projects[0].bots.find((b) => b.id === ATLAS);
  assert.deepEqual([ls.terminal, ls.status], ["t8", "running"]);
  assert.deepEqual(keysSent(s.calls()), []);
});

test("attach: a machine's terminal with another project, or this computer's, is refused", (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  assert.match(s.cli(["attach", "Atlas", "other/t8", ...s.on]).err, /other\/t8 is on other/);
  const here = s.cli(["attach", "Atlas", "vm/t8"]);
  assert.equal(here.code, 2);
  assert.match(here.err, /vm\/t8 is on vm; name the bot's project there/);
});

test("restart --machine of a pane that reports no status: refused in plain words; --force starts hermes --tui --continue, then ends the old one", (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  const refused = s.cli(["restart", "Atlas", ...s.on]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /vm\/t8 doesn't tell hc whether Atlas's agent is busy or waiting for an approval/);
  assert.match(refused.err, /pass --force to restart anyway \(it sends the pane no keys/);
  assert.equal(s.calls().filter((c) => c[0] === "run" || c[0] === "kill").length, 0);
  const r = s.cli(["restart", "Atlas", ...s.on, "--force", "--json"]);
  assert.equal(r.code, 0, r.err);
  const out = r.json();
  assert.deepEqual([out.terminal, out.machine, out.replaced, out.mode], ["t100", "vm", "t8", "resume"]);
  assert.deepEqual(out.argv, ["hermes", "--tui", "--continue"], "Hermes' own resume of the folder's latest conversation");
  const run = s.calls().find((c) => c[0] === "run");
  assert.ok(run.includes("--cwd") && run[run.indexOf("--cwd") + 1] === s.project);
  // The old pane ends only after the new one: run, then kill of vm/t8.
  const order = s.calls().map((c) => `${c[0]} ${c[1] ?? ""}`).filter((x) => /^(run|kill) /.test(x));
  assert.deepEqual(order.map((x) => x.split(" ")[0]), ["run", "kill"]);
  assert.ok(order[1].endsWith("vm/t8"));
  const rows = s.rows();
  assert.deepEqual(rows.slice(-2).map((x) => [x.event, x.terminal, x.machine, x.reason ?? null]), [["detach", "t8", "vm", "moved"], ["attach", "t100", "vm", null]]);
  assert.deepEqual(keysSent(s.calls()), [], "never a key to the pane, so never an approval answered");
});

test("restart --machine: --continue is refused while another bot's same agent runs in that folder there", (t) => {
  const s = scene(t, { terminals: [atlasPane({ status: { state: "idle", app: "hermes" } }), atlasPane({ address: "vm/t9", created_ms: 9 })] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  assert.equal(s.cli(["attach", "Hedge", "vm/t9", ...s.on]).code, 0);
  const r = s.cli(["restart", "Atlas", ...s.on]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Hedge/);
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 0);
});

test("detach --machine: the detach row and the labels off the pane there", (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  const r = s.cli(["detach", "Atlas", ...s.on, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().detached, r.json().machine], [["t8"], "vm"]);
  assert.deepEqual(s.rows().at(-1).event, "detach");
  assert.ok(s.calls().some((c) => c[0] === "label" && c[1] === "vm/t8" && c.includes("bot=")));
});

test("a machine away: its rows stay as saved (unknown), never ended; start and whois there are refused, not guessed", (t) => {
  const s = scene(t, { terminals: [atlasPane()] });
  assert.equal(s.cli(["attach", "Atlas", "vm/t8", ...s.on]).code, 0);
  s.setState((st) => { st.machines[0].state = "disconnected"; });
  const ls = s.cli(["ls", ...s.on, "--json"]);
  assert.equal(ls.code, 1, "the file there can't be read either");
  assert.match(ls.err, /vm/);
  const w = s.cli(["whois", "--bot", ATLAS, "--json"]);
  assert.equal(w.code, 0, w.err);
  assert.equal(w.json().terminal, null, "not confirmed: not live");
  assert.match(s.cli(["whois", "vm/t8"]).err, /vm isn't connected/);
  assert.equal(s.rows().filter((r) => r.event === "end").length, 0, "never ended while away");
  s.setState((st) => { st.machines[0].state = "connected"; });
  assert.equal(s.cli(["whois", "--bot", ATLAS, "--json"]).json().terminal, "t8", "back: as it was");
});
