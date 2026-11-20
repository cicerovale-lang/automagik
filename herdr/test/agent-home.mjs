// Shared by the pack and am. The CLI writes only to scratch projects.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { agentHomeFor, agentHomeVar } from "../mods/am-sidebar/logins.js";
import { checkBots, parseBots } from "../mods/am-sidebar/model.js";
import { runChangesAgentHome } from "../mods/am-sidebar/models.js";
import { readLedger, startRow } from "../mods/am-sidebar/workers.js";
import { scratchProject, scratchRoot } from "./scratch-project.mjs";

const BOT = "b-aaaaaaaaaa";
const roster = (worker) => ({
  version: 1, categories: [],
  bots: [{ id: BOT, name: "Genie", kind: "main", agent: "claude-code", role: "", instructions: "",
    look: { character: "star", colour: "blue" }, worker }],
});
const io = { isDir: (p) => statSync(p).isDirectory(), mode: (p) => statSync(p).mode, realpath: realpathSync };
const cliExec = promisify(execFile);

export function agentHomeTests(cli) {
  test("agentHomeFor accepts exactly 0700, checks the vendor and returns the realpath", (t) => {
    const root = scratchRoot(t, "agent-home-");
    const dir = join(root, "login"), alias = join(root, "alias"), file = join(root, "file");
    mkdirSync(dir, { mode: 0o700 });
    symlinkSync(dir, alias);
    writeFileSync(file, "");
    for (const [agent, variable] of [["claude", "CLAUDE_CONFIG_DIR"], ["codex", "CODEX_HOME"]]) {
      assert.equal(agentHomeVar(agent), variable);
      assert.deepEqual(agentHomeFor(agent, alias, io), { dir, words: [variable + "=" + dir] });
    }
    assert.match(agentHomeFor("dsh-tui", dir, io).error, /no vendor config folder/);
    assert.match(agentHomeFor("claude", "relative", io).error, /not an absolute path/);
    assert.match(agentHomeFor("claude", "/", io).error, /not a login home/);
    assert.match(agentHomeFor("claude", file, io).error, /is not a folder/);
    assert.match(agentHomeFor("claude", join(root, "missing"), io).error, /is not a folder/);
    for (const [mode, label] of [[0o755, "0755"], [0o777, "0777"], [0o1700, "1700"], [0o2700, "2700"]]) {
      chmodSync(dir, mode);
      assert.match(agentHomeFor("claude", dir, io).error, new RegExp("mode " + label + ".*must be 0700"));
      assert.equal(statSync(dir).mode & 0o7777, mode);
    }
  });

  test("checkBots validates the worker home while parseBots retains malformed input", () => {
    for (const agentHome of [null, {}, 17, "", "relative", "/", "/a\nb", "/a\u0085b"]) {
      const raw = roster({ agentHome });
      assert.ok(checkBots(raw).some((line) => line.includes("worker.agentHome")));
      const parsed = parseBots(JSON.stringify(raw));
      assert.deepEqual(parsed.file.bots[0].worker.agentHome, agentHome);
      assert.ok(parsed.warnings.some((line) => line.includes("worker.agentHome")));
    }
    assert.deepEqual(checkBots(roster({ agentHome: "/may/not/exist" })), []);
    assert.ok(checkBots(roster({ agent: "omp", agentHome: "/private" })).some((line) => /vendor config folder/.test(line)));
  });

  test("create and edit set, retain, clear and drop a home with its effective worker agent", async (t) => {
    const root = scratchRoot(t, "agent-home-");
    const project = scratchProject(root, "project", { isGit: false });
    const app = join(root, "app"), home = join(root, "home"), bin = join(root, "bin"), runtime = join(root, "runtime");
    mkdirSync(app);
    mkdirSync(home);
    mkdirSync(bin);
    mkdirSync(runtime, { mode: 0o700 });
    for (const program of ["hc", "herdr-app"]) writeFileSync(join(bin, program), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const env = { ...process.env, HOME: home, HERDR_APP_HOME: app, XDG_RUNTIME_DIR: runtime,
      PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      AUTOMAGIK_HERDR_NO_UPDATE: "1", AUTOMAGIK_HERDR_TEST_ROOTS: root, GIT_CEILING_DIRECTORIES: root };
    const run = (...args) => cliExec(process.execPath, [cli, ...args, "--project", project], { cwd: project, env });
    const ok = async (...args) => { await run(...args); };
    const row = () => JSON.parse(readFileSync(join(project, ".herdr/bots.json"), "utf8")).bots[0];
    const edit = (...args) => ok("edit", "Genie", ...args);
    await ok("create", "--name", "Genie", "--kind", "main", "--agent", "claude", "--worker-agent-home", "/absent");
    assert.equal(row().worker.agentHome, "/absent", "save checks the shape only");
    await edit("--role", "Lead");
    assert.equal(row().worker.agentHome, "/absent");
    await edit("--worker-agent", "claude-code");
    assert.equal(row().worker.agentHome, "/absent");
    await edit("--agent", "codex");
    assert.equal(row().worker.agentHome, "/absent", "an explicit worker agent keeps its home");
    await edit("--worker-agent=");
    assert.equal(row().worker?.agentHome, undefined);
    await edit("--worker-agent-home", "/codex");
    await edit("--agent", "claude");
    assert.equal(row().worker?.agentHome, undefined);
    await edit("--worker-agent-home", "/shared");
    await edit("--agent", "codex", "--worker-agent-home", "/shared");
    assert.equal(row().worker.agentHome, "/shared", "an explicit selection is kept on an agent change");
    await edit("--worker-agent-home=");
    assert.equal(row().worker?.agentHome, undefined);
    for (const args of [["--worker-agent-home", "relative"], ["--worker-agent", "omp", "--worker-agent-home", "/private"]]) {
      await assert.rejects(run("edit", "Genie", ...args), { code: 2 });
      assert.equal(row().worker?.agentHome, undefined);
    }
    const open = join(root, "open-home");
    mkdirSync(open, { mode: 0o755 });
    await assert.rejects(run("worker", "task", "--branch", "feat/private", "--agent-home", open), { code: 2 });
    for (const args of [["restart", "Genie"], ["revive"]]) {
      await assert.rejects(run(...args, "--agent-home", open), { code: 2 });
    }
  });

  test("the configured prefix checks nested env and leaves vendor arguments alone", () => {
    const variable = "CODEX_HOME";
    for (const argv of [
      ["env", "CODEX_HOME=/other", "codex"],
      ["nice", "-n", "5", "/usr/bin/env", "--unset", variable, "codex"],
      ["time", "--", "env", "-uCODEX_HOME", "codex"],
      ["env", "--unset=CODEX_HOME", "codex"],
      ["env", "--", "CODEX_HOME=/elsewhere", "codex"],
      ...["-i", "--ignore-environment", "-", "-S", "--some-option"].map((word) => ["env", word, "codex"]),
    ]) assert.equal(runChangesAgentHome(argv, variable), true, JSON.stringify(argv));
    for (const argv of [
      ["nice", "env", "--unset", "OTHER", "env", "KEEP=1", "codex"],
      ["node", "--require", "some-hook", "codex.js", "--never-executed", "CODEX_HOME=/somewhere"],
    ]) assert.equal(runChangesAgentHome(argv, variable), false, JSON.stringify(argv));
  });

  test("worker ledger rows without a selected home read as null", () => {
    assert.equal(startRow({ kind: "worker" }).agentHome, null);
    assert.equal(readLedger('{"event":"start","kind":"worker","terminal":"t1"}\n')[0].agentHome, null);
  });
}
