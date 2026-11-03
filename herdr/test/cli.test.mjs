// automagik-herdr, the command line (A11): every subcommand run as a program against scratch git
// projects under $TMPDIR, with a fake `hc` first on PATH (test/fake-hc.mjs) that records
// each call and answers from a state file, and a fake `herdr-app` (test/fake-herdr-app.mjs; no
// window unless a test opens one). The real hc and window are never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkBots, parseBots } from "../mods/am-sidebar/model.js";
import { writeBotsFile, findBot, CliError, listProject } from "../mods/am-sidebar/bin/automagik-herdr.mjs";
import { ledgerPath, readLedger } from "../mods/am-sidebar/workers.js";
import { attachPath as attachFile, foldAttach as foldRows, readAttach as readRows } from "../mods/am-sidebar/attach.js";

const CLI = new URL("../mods/am-sidebar/bin/automagik-herdr.mjs", import.meta.url).pathname;
// AUTOMAGIK_HERDR_TEST_RUNTIME=<bun or node path> runs the CLI with that runtime instead.
const RUNTIME = process.env.AUTOMAGIK_HERDR_TEST_RUNTIME || process.execPath;
const FAKE_HC = new URL("./fake-hc.mjs", import.meta.url).pathname;
const FAKE_APP = new URL("./fake-herdr-app.mjs", import.meta.url).pathname;
const ID = { main: "b-aaaaaaaaaa", cap: "b-bbbbbbbbbb", dev: "b-cccccccccc", plan: "b-eeeeeeeeee" };

const git = (cwd, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
const exe = (path, text) => { writeFileSync(path, text); chmodSync(path, 0o755); };

/** A scratch world: a git project, a fake hc, a fake home and app home. */
function scene(t, { terminals = [], briefing = true, window = { down: true } } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-cli-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = join(root, "proj");
  mkdirSync(project);
  git(project, "init", "-q");
  git(project, "commit", "-q", "--allow-empty", "-m", "start");
  const bin = join(root, "bin");
  mkdirSync(bin);
  exe(join(bin, "hc"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_HC}" "$@"\n`);
  exe(join(bin, "herdr-app"), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_APP}" "$@"\n`);
  exe(join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  exe(join(bin, "codex"), "#!/bin/sh\nexit 0\n");
  const home = join(root, "home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(join(home, ".claude/settings.json"), JSON.stringify({ model: "sonnet" }));
  const app = join(root, "app");
  mkdirSync(join(app, "mods/am-sidebar"), { recursive: true });
  if (briefing) writeFileSync(join(app, "mods/am-sidebar/briefing.mjs"), "// stand-in\n");
  const statePath = join(root, "hc.json");
  const logPath = join(root, "hc.log");
  writeFileSync(statePath, JSON.stringify({ terminals, next: 100 }));
  writeFileSync(logPath, "");
  const appState = join(root, "herdr-app.json"), appLog = join(root, "herdr-app.log");
  writeFileSync(appState, JSON.stringify(window));
  writeFileSync(appLog, "");
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home, HERDR_APP_HOME: app, HC_FAKE_STATE: statePath, HC_FAKE_LOG: logPath,
    HERDR_APP_FAKE_STATE: appState, HERDR_APP_FAKE_LOG: appLog };
  delete env.HC_TERMINAL_ID;
  const cli = (args, { cwd = project, input, env: extra = {} } = {}) => {
    const r = spawnSync(RUNTIME, [CLI, ...args], { cwd, env: { ...env, ...extra }, input, encoding: "utf8" });
    return { code: r.status, out: r.stdout, err: r.stderr, json: () => JSON.parse(r.stdout) };
  };
  const calls = () => readFileSync(logPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const hcState = () => JSON.parse(readFileSync(statePath, "utf8"));
  const appCalls = () => readFileSync(appLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const windowNow = () => JSON.parse(readFileSync(appState, "utf8"));
  const botsPath = join(project, ".herdr/bots.json");
  const bots = () => JSON.parse(readFileSync(botsPath, "utf8"));
  const seed = (file) => { mkdirSync(join(project, ".herdr"), { recursive: true }); writeFileSync(botsPath, `${JSON.stringify(file, null, 2)}\n`); };
  return { root, project, app, home, cli, calls, hcState, appCalls, windowNow, bots, botsPath, seed };
}

const bot = (id, kind, extra = {}) => ({ id, name: `Bot ${id.slice(2, 4)}`, kind, look: { character: "star", colour: "blue" }, role: "r", instructions: "i", agent: "claude", ...extra });
const team = (extra = {}) => ({
  version: 1,
  categories: [{ id: "eng", title: "Engineering" }],
  bots: [
    bot(ID.main, "main", { name: "Genie" }),
    bot(ID.cap, "member", { name: "Captain", category: "eng" }),
    bot(ID.dev, "member", { name: "Dev", lead: ID.cap }),
    bot(ID.plan, "member", { name: "Studio", agent: undefined, planned: { wave: 3, note: "later" } }),
  ],
  ...extra,
});
/** An `hc get` answer for a terminal. */
const term = (address, { bot: b, argv = ["claude"], cwd = "/x", app = "claude-code", state = "live", created = 1, parent = null, msg, status = "idle" } = {}) => ({
  address, name: address, cwd, state, parent, created_ms: created, labels: b ? { bot: b } : {},
  foreground: { argv, cwd }, status: { app, state: status, ...(msg ? { msg } : {}) },
});
const runCall = (calls) => calls.find((c) => c[0] === "run");
const labelCalls = (calls) => calls.filter((c) => c[0] === "label");

// ---- create ----

test("create: the first bot must be main; then the main bot is written with an id, a default look and the agent", (t) => {
  const s = scene(t);
  const refused = s.cli(["create", "--name", "Dev", "--agent", "claude", "--kind", "member"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /first bot in a project must be its main bot/);
  assert.equal(existsSync(s.botsPath), false, "nothing written");
  const made = s.cli(["create", "--name", "Genie", "--agent", "claude", "--role", "runs the team"]);
  assert.equal(made.code, 0, made.err);
  const id = made.out.trim();
  assert.match(id, /^b-[a-z2-7]{10}$/);
  const file = s.bots();
  assert.deepEqual(checkBots(file), []);
  assert.equal(file.bots[0].id, id);
  assert.equal(file.bots[0].kind, "main");
  assert.equal(file.bots[0].role, "runs the team");
  assert.equal(file.bots[0].instructions, "");
  assert.ok(file.bots[0].look.character && file.bots[0].look.colour);
  // A second bot defaults to member; a second main is refused.
  assert.equal(s.cli(["create", "--name", "Two", "--agent", "codex"]).code, 0);
  assert.equal(s.bots().bots[1].kind, "member");
  const twoMains = s.cli(["create", "--name", "Three", "--agent", "claude", "--kind", "main"]);
  assert.equal(twoMains.code, 1);
  assert.match(twoMains.err, /already has a main bot, Genie/);
});

test("create from a worktree writes the main checkout's file (Decision 15); --project picks another folder", (t) => {
  const s = scene(t);
  const wt = join(s.root, "wt");
  git(s.project, "worktree", "add", "-q", wt);
  const r = s.cli(["create", "--name", "Genie", "--agent", "claude", "--json"], { cwd: wt });
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().project, s.project);
  assert.ok(existsSync(s.botsPath));
  assert.equal(existsSync(join(wt, ".herdr/bots.json")), false);
  const other = join(s.root, "plain");
  mkdirSync(other);
  assert.equal(s.cli(["create", "--name", "Solo", "--agent", "claude", "--project", other]).code, 0);
  assert.ok(existsSync(join(other, ".herdr/bots.json")));
});

test("create --project names the project itself outside git, never the parent project above it", (t) => {
  const s = scene(t);
  // The owner's case: repos (no git) holds another project's bots.json; child under it has none.
  const repos = join(s.root, "repos");
  const child = join(repos, "child");
  mkdirSync(join(repos, ".herdr"), { recursive: true });
  mkdirSync(child);
  const parentText = `${JSON.stringify(team(), null, 2)}\n`;
  writeFileSync(join(repos, ".herdr/bots.json"), parentText);
  const r = s.cli(["create", "--name", "Child", "--agent", "claude", "--project", child, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().project, child);
  const own = JSON.parse(readFileSync(join(child, ".herdr/bots.json"), "utf8"));
  assert.deepEqual(own.bots.map((b) => [b.name, b.kind]), [["Child", "main"]]);
  assert.equal(readFileSync(join(repos, ".herdr/bots.json"), "utf8"), parentText, "the parent's file is untouched");
  // Run from inside child with no --project, the walk-up now finds child's own file first.
  assert.equal(s.cli(["ls", "--json"], { cwd: child }).json().projects[0].project, child);
  // A folder that isn't there is refused, not made.
  const gone = s.cli(["create", "--name", "X", "--agent", "claude", "--project", join(repos, "nope")]);
  assert.equal(gone.code, 2);
  assert.match(gone.err, /is not a folder/);
  assert.equal(existsSync(join(repos, "nope")), false);
});

test("create refuses instructions over 4,000 characters, from the flag, a file or stdin", (t) => {
  const s = scene(t);
  const long = "x".repeat(4001);
  const r = s.cli(["create", "--name", "Genie", "--agent", "claude", "--instructions", long]);
  assert.equal(r.code, 1);
  assert.match(r.err, /4001 characters; the limit is 4000/);
  assert.equal(existsSync(s.botsPath), false);
  assert.equal(s.cli(["create", "--name", "Genie", "--agent", "claude", "--instructions-file", "-"], { input: long }).code, 1);
  const ok = s.cli(["create", "--name", "Genie", "--agent", "claude", "--instructions-file", "-"], { input: `${"y".repeat(4000)}\n` });
  assert.equal(ok.code, 0, ok.err);
  assert.equal(s.bots().bots[0].instructions.length, 4000);
});

test("create: lead, category, planned, look, model pin from the agent's list only", (t) => {
  const s = scene(t);
  s.seed(team());
  const bad = s.cli(["create", "--name", "Tess", "--agent", "claude", "--model", "gpt-free-text"]);
  assert.equal(bad.code, 1);
  assert.match(bad.err, /isn't a known claude model. Pick one of: .*claude-opus-5-5/);
  const unknownAgent = s.cli(["create", "--name", "Tess", "--agent", "nope"]);
  assert.match(unknownAgent.err, /isn't a coding agent Herdr knows/);
  const catUnderCaptain = s.cli(["create", "--name", "Tess", "--agent", "claude", "--lead", "Captain", "--category", "eng"]);
  assert.match(catUnderCaptain.err, /category goes only on a member that reports to the main bot/);
  const leadPlanned = s.cli(["create", "--name", "Tess", "--agent", "claude", "--lead", "Studio"]);
  assert.match(leadPlanned.err, /Studio is planned/);
  const dupName = s.cli(["create", "--name", "dev", "--agent", "claude"]);
  assert.match(dupName.err, /already named "Dev"/);

  const r = s.cli(["create", "--name", "Tess", "--agent", "claude", "--lead", "Captain", "--model", "claude-opus-5-5", "--character", "gem", "--colour", "rose", "--json"]);
  assert.equal(r.code, 0, r.err);
  const made = s.bots().bots.find((b) => b.id === r.json().id);
  assert.equal(made.lead, ID.cap);
  assert.equal(made.model, "claude-opus-5-5");
  assert.deepEqual(made.look, { character: "gem", colour: "rose" });
  const omni = s.cli(["create", "--name", "Octo", "--agent", "codex", "--category", "Engineering", "--omni", "--json"]);
  const o = s.bots().bots.find((b) => b.id === omni.json().id);
  assert.deepEqual(o.look, { character: "octopus", colour: "deepseek" });
  assert.equal(o.category, "eng");
  assert.equal(o.lead, undefined);
  const planned = s.cli(["create", "--name", "Later", "--planned-wave", "2", "--planned-note", "after auth", "--json"]);
  assert.equal(planned.code, 0, planned.err);
  const p = s.bots().bots.find((b) => b.id === planned.json().id);
  assert.deepEqual(p.planned, { wave: 2, note: "after auth" });
  assert.equal(p.agent, undefined);
  assert.equal(s.cli(["create", "--name", "Nobody"]).code, 2, "no agent and not planned");
  assert.deepEqual(checkBots(s.bots()), []);
});

// ---- edit, rm, category ----

test("edit: partial changes keep the rest; --unplanned, --no-model; a lead cycle is refused", (t) => {
  const s = scene(t);
  const f = team();
  f.bots[1].model = "opus";
  f.bots[1].extra = "kept";
  s.seed(f);
  assert.equal(s.cli(["edit", "Captain", "--role", "leads eng", "--no-model"]).code, 0);
  let cap = s.bots().bots.find((b) => b.id === ID.cap);
  assert.equal(cap.role, "leads eng");
  assert.equal(cap.model, undefined);
  assert.equal(cap.extra, "kept");
  assert.equal(cap.category, "eng");
  assert.equal(cap.instructions, "i");
  const cycle = s.cli(["edit", "Captain", "--lead", "Dev"]);
  assert.equal(cycle.code, 1);
  assert.match(cycle.err, /Dev reports to Captain, so it can't be its lead/);
  const unplan = s.cli(["edit", ID.plan, "--unplanned"]);
  assert.match(unplan.err, /needs a coding agent/);
  assert.equal(s.cli(["edit", ID.plan, "--unplanned", "--agent", "codex"]).code, 0);
  assert.equal(s.bots().bots.find((b) => b.id === ID.plan).planned, undefined);
  assert.equal(s.cli(["edit", "Dev", "--lead", "Genie"]).code, 0);
  assert.equal(s.bots().bots.find((b) => b.id === ID.dev).lead, undefined, "the main bot as lead is stored as no lead");
  const json = s.cli(["edit", "Dev", "--name", "Developer", "--json"]).json();
  assert.equal(json.id, ID.dev);
  assert.equal(json.bot.name, "Developer");
  cap = s.bots().bots.find((b) => b.id === ID.cap);
  assert.equal(cap.name, "Captain");
});

test("rm: a main bot with members and a lead with members are refused; a member goes; the last bot deletes the file", (t) => {
  const s = scene(t);
  s.seed(team());
  const main = s.cli(["rm", "Genie"]);
  assert.equal(main.code, 1);
  assert.match(main.err, /main bot and its project still has 3 other bots/);
  const lead = s.cli(["rm", "Captain"]);
  assert.equal(lead.code, 1);
  assert.match(lead.err, /Captain leads Dev/);
  assert.equal(s.bots().bots.length, 4, "nothing written");
  for (const b of ["Dev", "Captain", "Studio"]) assert.equal(s.cli(["rm", b]).code, 0);
  const last = s.cli(["rm", "Genie", "--json"]);
  assert.equal(last.code, 0, last.err);
  assert.equal(last.json().deletedFile, true);
  assert.equal(existsSync(s.botsPath), false);
});

test("category add, edit, order, rm (refused while used); ls --json lists them", (t) => {
  const s = scene(t);
  s.seed(team());
  assert.equal(s.cli(["category", "add", "--title", "Quality", "--sub", "tests"]).out.trim(), "quality");
  assert.equal(s.cli(["category", "add", "--title", "Shared"]).out.trim(), "shared");
  assert.equal(s.cli(["category", "edit", "quality", "--sub", ""]).code, 0);
  assert.equal(s.bots().categories.find((c) => c.id === "quality").sub, undefined);
  assert.equal(s.cli(["category", "order", "shared", "quality"]).code, 0);
  assert.deepEqual(s.bots().categories.map((c) => c.id), ["shared", "quality", "eng"]);
  const used = s.cli(["category", "rm", "eng"]);
  assert.equal(used.code, 1);
  assert.match(used.err, /Captain is in eng/);
  assert.equal(s.cli(["category", "rm", "Shared"]).code, 0);
  const ls = s.cli(["category", "ls", "--json"]).json();
  assert.deepEqual(ls.categories.map((c) => [c.id, c.bots]), [["quality", []], ["eng", [ID.cap]]]);
});

// ---- the stale-snapshot rule ----

test("writeBotsFile refuses a stale snapshot and a file that appeared, writing nothing", (t) => {
  const s = scene(t);
  s.seed(team());
  const read = readFileSync(s.botsPath, "utf8");
  const raw = parseBots(read).raw;
  raw.bots[0].role = "changed";
  // Someone else's edit lands between the read and the write.
  const theirs = read.replace('"role": "r"', '"role": "theirs"');
  writeFileSync(s.botsPath, theirs);
  assert.throws(() => writeBotsFile(s.project, raw, read), (e) => e instanceof CliError && /changed since it was read/.test(e.message));
  assert.equal(readFileSync(s.botsPath, "utf8"), theirs);
  // A new file written by someone else after we saw none.
  const fresh = join(s.root, "fresh");
  mkdirSync(join(fresh, ".herdr"), { recursive: true });
  writeFileSync(join(fresh, ".herdr/bots.json"), "{}");
  assert.throws(() => writeBotsFile(fresh, team(), null), /changed since it was read/);
  // A write that would break the schema is refused before any read.
  assert.throws(() => writeBotsFile(s.project, { version: 1, categories: [], bots: [] }, theirs), /0 main bots/);
  // Through the injected file access: the re-read differs, so neither write runs.
  const io = { read: () => "y", mkdir() { throw new Error("no"); }, create() { throw new Error("no"); }, replace() { throw new Error("no"); } };
  assert.throws(() => writeBotsFile(s.project, team(), "x", io), /changed since/);
});

// ---- ls, show, model ----

test("ls --json: kind, lead, category, planned, agent, model detected → pinned → default, terminal, status", (t) => {
  const f = team();
  f.bots[2].model = "claude-opus-5-5";
  const s = scene(t, { terminals: [term("t5", { bot: ID.cap, argv: ["claude", "--dangerously-skip-permissions", "--model", "claude-opus-5-5"], status: "working" })] });
  s.seed(f);
  const r = s.cli(["ls", "--json"]);
  assert.equal(r.code, 0, r.err);
  const [p] = r.json().projects;
  assert.equal(p.project, s.project);
  assert.deepEqual(p.categories, [{ id: "eng", title: "Engineering" }]);
  const by = Object.fromEntries(p.bots.map((b) => [b.name, b]));
  assert.deepEqual(Object.keys(by), ["Genie", "Captain", "Dev", "Studio"]);
  assert.equal(by.Genie.kind, "main");
  assert.equal(by.Genie.lead, null);
  assert.deepEqual([by.Genie.model, by.Genie.modelSource, by.Genie.status, by.Genie.terminal], ["sonnet", "default", "not running", null]);
  assert.deepEqual([by.Captain.lead, by.Captain.category, by.Captain.model, by.Captain.modelSource, by.Captain.terminal, by.Captain.status],
    [ID.main, "eng", "claude-opus-5-5", "detected", "t5", "working"]);
  assert.deepEqual([by.Dev.lead, by.Dev.leadName, by.Dev.model, by.Dev.modelSource], [ID.cap, "Captain", "claude-opus-5-5", "pinned"]);
  assert.deepEqual(by.Studio.planned, { wave: 3, note: "later" });
  assert.equal(by.Studio.status, "planned");
  for (const key of ["id", "name", "kind", "lead", "category", "planned", "agent", "model", "modelSource", "terminal", "status", "duplicate"]) assert.ok(key in by.Dev, key);
  const text = s.cli(["ls"]);
  assert.match(text.out, /Captain .* claude-opus-5-5 \(detected\) {2}working in t5/);
  const show = s.cli(["show", "dev", "--json"]).json();
  assert.equal(show.id, ID.dev);
  assert.equal(show.instructions, "i");
  assert.match(s.cli(["show", "Captain"]).out, /model {8}claude-opus-5-5 \(detected\)/);
  assert.match(s.cli(["show", "nobody"]).err, /No bot "nobody"/);
});

test("ls by the ledger: a shell pane shows no agent in front; the import takes the newest agent pane; --all adds remembered projects", (t) => {
  const s = scene(t, { terminals: [
    term("t1", { bot: ID.main, argv: ["zsh"] }),
    term("t2", { bot: ID.cap, created: 5 }), term("t3", { bot: ID.cap, created: 9, argv: ["claude", "--model", "opus"] }),
  ] });
  s.seed(team());
  const other = join(s.root, "other");
  mkdirSync(join(other, ".herdr"), { recursive: true });
  writeFileSync(join(other, ".herdr/bots.json"), JSON.stringify({ version: 1, categories: [], bots: [bot("b-dddddddddd", "main", { name: "Solo" })] }));
  writeFileSync(join(s.app, "shared.json"), JSON.stringify({ "spaces-agents.projects": [{ key: other, machine: null }, { key: join(s.root, "gone"), machine: null }, { key: "/r", machine: "vps" }] }));
  const by = Object.fromEntries(s.cli(["ls", "--json"]).json().projects[0].bots.map((b) => [b.name, b]));
  // The first run imports the labels: Genie's only pane, though a shell is in front; of
  // Captain's two, the newest with an agent in front. The ledger then ties one pane each.
  assert.deepEqual([by.Genie.terminal, by.Genie.status], ["t1", "no agent in front"]);
  assert.deepEqual([by.Captain.terminal, by.Captain.duplicate, by.Captain.model], ["t3", false, "opus"]);
  const all = s.cli(["ls", "--all", "--json"]).json().projects;
  assert.deepEqual(all.map((p) => p.project), [s.project, other]);
});

test("create, edit, category, start and attach list their project for the sidebar; ls --all reads the list", (t) => {
  const s = scene(t, { terminals: [term("t9", { cwd: "/x" })] });
  const list = join(s.app, "am-sidebar-projects.json");
  const listed = () => JSON.parse(readFileSync(list, "utf8"));
  // A folder that is there: start, attach and create take a gone one off the list (tidy).
  const elsewhere = join(s.root, "elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(list, JSON.stringify([elsewhere]));
  assert.equal(s.cli(["create", "--name", "Genie", "--agent", "claude"]).code, 0);
  assert.deepEqual(listed(), [elsewhere, s.project]);
  // Once each, the newest last.
  writeFileSync(list, JSON.stringify([s.project, elsewhere]));
  assert.equal(s.cli(["edit", "Genie", "--role", "lead"]).code, 0);
  assert.deepEqual(listed(), [elsewhere, s.project]);
  writeFileSync(list, "[]");
  assert.equal(s.cli(["category", "add", "--title", "Eng"]).code, 0);
  assert.deepEqual(listed(), [s.project]);
  writeFileSync(list, "[]");
  assert.equal(s.cli(["start", "Genie"]).code, 0);
  assert.deepEqual(listed(), [s.project]);
  // ls --all adds a listed project the sidebar never remembered.
  const other = join(s.root, "other");
  mkdirSync(join(other, ".herdr"), { recursive: true });
  writeFileSync(join(other, ".herdr/bots.json"), JSON.stringify({ version: 1, categories: [], bots: [bot("b-dddddddddd", "main", { name: "Solo" })] }));
  writeFileSync(list, JSON.stringify([other]));
  assert.deepEqual(s.cli(["ls", "--all", "--json"]).json().projects.map((p) => p.project), [s.project, other]);
  // Reading leaves the list alone; a read-only command adds nothing.
  assert.equal(s.cli(["show", "Genie"]).code, 0);
  assert.deepEqual(listed(), [other]);
});

test("twenty CLIs listing projects at once lose none of them", async (t) => {
  const app = realpathSync(mkdtempSync(join(tmpdir(), "hb-list-")));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  const writer = `import { listProject } from ${JSON.stringify(CLI)};\nprocess.exitCode = listProject(process.argv[1], process.argv[2]) ? 0 : 1;`;
  const keys = Array.from({ length: 20 }, (_, i) => `/p/${i}`);
  const codes = await Promise.all(keys.map((key) => new Promise((done) => {
    execFile(process.execPath, ["--input-type=module", "-e", writer, key, app], (err) => done(err ? err.code ?? 1 : 0));
  })));
  assert.deepEqual(codes, keys.map(() => 0));
  const listed = JSON.parse(readFileSync(join(app, "am-sidebar-projects.json"), "utf8"));
  assert.deepEqual([...listed].sort(), [...keys].sort());
  assert.equal(existsSync(join(app, "am-sidebar-projects.json.lock")), false);
});

test("a stale project-list lock (a CLI killed mid-write) is taken over, and nothing is left behind", (t) => {
  const app = realpathSync(mkdtempSync(join(tmpdir(), "hb-lock-")));
  t.after(() => rmSync(app, { recursive: true, force: true }));
  const lock = join(app, "am-sidebar-projects.json.lock");
  writeFileSync(lock, "999999 someone-else");
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(listProject("/p/a", app), true);
  assert.deepEqual(JSON.parse(readFileSync(join(app, "am-sidebar-projects.json"), "utf8")), ["/p/a"]);
  assert.deepEqual(readdirSync(app), ["am-sidebar-projects.json"]);
});

test("with no app home, nothing is listed and the command still succeeds; an unwritable list only warns", (t) => {
  const s = scene(t);
  rmSync(s.app, { recursive: true, force: true });
  assert.equal(s.cli(["create", "--name", "Genie", "--agent", "claude"]).code, 0);
  assert.equal(existsSync(s.app), false);
  mkdirSync(join(s.app, "am-sidebar-projects.json"), { recursive: true }); // a folder where the file goes
  const r = s.cli(["edit", "Genie", "--role", "lead"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /couldn't list .* so the sidebar shows it only once a space is open on it/);
});

// ---- start ----

test("start a main bot: hc run --bg with the label, name, cwd, --no-parent, the pinned model; never --no-notify; the hook written and excluded", (t) => {
  const f = team();
  f.bots[0].model = "claude-opus-5-5";
  const s = scene(t);
  s.seed(f);
  const r = s.cli(["start", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.json().terminal, "t100");
  const run = runCall(s.calls());
  // A claude needs no interpreter: PATH isn't changed, so the seat isn't wrapped in /usr/bin/env PATH=… (#56).
  assert.deepEqual(run, ["run", "--bg", "--json", "--name", "genie", "--cwd", s.project, "--label", `bot=${ID.main}`, "--label", "role=main", "--no-parent",
    "--", "claude", "--model", "claude-opus-5-5"]);
  assert.equal(run.some((a) => a === "/usr/bin/env" || a.startsWith("PATH=")), false);
  assert.equal(run.includes("--no-notify"), false);
  assert.equal(run.some((a) => a.startsWith("herdr.space=") || a.startsWith("herdr.tab=")), false, "no placement labels unless asked");
  const settings = JSON.parse(readFileSync(join(s.project, ".claude/settings.local.json"), "utf8"));
  assert.match(settings.hooks.UserPromptSubmit[0].hooks[0].command, new RegExp(`${s.app}/mods/am-sidebar/briefing.mjs`));
  assert.match(readFileSync(join(s.project, ".git/info/exclude"), "utf8"), /\*\*\/\.claude\/settings\.local\.json/);
  assert.equal(git(s.project, "status", "--porcelain", "--", ".claude"), "");
  // Started: the next start reports the running pane and runs nothing.
  const again = s.cli(["start", "Genie"]);
  assert.equal(again.code, 0);
  assert.match(again.out, /already running in t100/);
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 1);
});

test("start (#56) lands in the project's space: a project terminal's tab only when its space shows the project", (t) => {
  // The window: the caller's space on another folder, and the project's, its second tab selected.
  const startIn = (callerLabels, { projectSpace = true } = {}) => {
    const s = scene(t);
    const spaces = [{ id: "sp-caller", folder: "/", machine: null, active: true, tabs: [{ id: "tb-c", active: true, terminals: [] }] }];
    if (projectSpace) {
      spaces.push({ id: "sp-proj", folder: s.project, machine: null, active: false,
        tabs: [{ id: "tb-a", active: false, terminals: [] }, { id: "tb-b", active: true, terminals: [] }] });
    }
    writeFileSync(join(s.root, "herdr-app.json"), JSON.stringify({ spaces }));
    s.seed(team());
    const caller = term("t20", { cwd: s.project, argv: ["claude"] }); // e.g. an orchestrator working in the project
    caller.labels = callerLabels;
    writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals: [caller], next: 100 }));
    const r = s.cli(["start", "Genie", "--json"]);
    assert.equal(r.code, 0, r.err);
    r.appCalls = s.appCalls();
    return r;
  };
  // The caller's tab is in another space: the bot goes to the project's space, in its selected tab,
  // with one herdr-app ls for the whole start (placementOf and windowPlace share it).
  const away = startIn({ "herdr.space": "sp-caller", "herdr.tab": "tb-c" });
  assert.deepEqual([away.json().space, away.json().tab], ["sp-proj", "tb-b"]);
  assert.deepEqual(away.appCalls, [["ls"]]);
  // The caller's tab is in the project's space: it takes the bot.
  const home = startIn({ "herdr.space": "sp-proj", "herdr.tab": "tb-a" });
  assert.deepEqual([home.json().space, home.json().tab], ["sp-proj", "tb-a"]);
  // No space shows the project: never the caller's tab; a new space on the project is opened (#71).
  const none = startIn({ "herdr.space": "sp-caller", "herdr.tab": "tb-c" }, { projectSpace: false });
  assert.deepEqual([none.json().space, none.json().tab], ["sp-new1", "tb-new1"]);
  assert.deepEqual(none.appCalls.map((c) => c.slice(0, 2)), [["ls"], ["do", "space.new"], ["ls"]]);
});

test("start a member: parent is its lead's live terminal, outliving it; else --no-parent; --space/--tab add placement labels", (t) => {
  const s = scene(t, { terminals: [term("t7", { bot: ID.cap, cwd: "/p" }), term("t8", { bot: ID.main, argv: ["bash"] })] });
  s.seed(team());
  assert.equal(s.cli(["start", "Dev", "--space", "sp1", "--tab", "tb2"]).code, 0);
  const run = runCall(s.calls());
  assert.deepEqual(run.slice(run.indexOf("--parent"), run.indexOf("--")), ["--parent", "t7", "--outlive-parent"]);
  assert.ok(run.includes("herdr.space=sp1") && run.includes("herdr.tab=tb2"));
  // Captain is attached to t7 (imported from its label): reported, not started twice. So is
  // Genie in t8, a shell in front or not: the ledger ties it. Detached, Genie starts, with no parent.
  assert.match(s.cli(["start", "Captain"]).out, /already running in t7/);
  assert.match(s.cli(["start", "Genie"]).out, /already running in t8/);
  assert.equal(s.cli(["detach", "Genie"]).code, 0);
  assert.equal(s.cli(["start", "Genie"]).code, 0);
  const runs = s.calls().filter((c) => c[0] === "run");
  assert.equal(runs.length, 2);
  assert.ok(runs[1].includes("--no-parent"));
});

test("start: --tab without --space is a usage mistake (exit 2), nothing started", (t) => {
  const s = scene(t);
  s.seed(team());
  const r = s.cli(["start", "Genie", "--tab", "tb2"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--tab needs --space/);
  assert.equal(runCall(s.calls()), undefined);
});

test("start: the main bot not live gives --no-parent; planned and agentless bots are refused; a missing briefing script only warns", (t) => {
  const s = scene(t, { briefing: false });
  s.seed(team());
  const r = s.cli(["start", "Captain"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /gets no per-turn briefing: .*briefing\.mjs isn't there/);
  assert.equal(existsSync(join(s.project, ".claude/settings.local.json")), false);
  const run = runCall(s.calls());
  assert.ok(run.includes("--no-parent"));
  assert.equal(run.includes("--parent"), false);
  const planned = s.cli(["start", "Studio"]);
  assert.equal(planned.code, 1);
  assert.match(planned.err, /Studio is planned \(wave 3\)/);
  assert.equal(s.calls().filter((c) => c[0] === "run").length, 1);
});

// ---- attach, detach ----

test("attach refuses a Claude pane whose session runs outside the project, naming both folders; nothing written", (t) => {
  const s = scene(t, { terminals: [term("t9", { cwd: "/elsewhere" })] });
  s.seed(team());
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "hb-out-")));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const st = s.hcState();
  st.terminals[0].foreground.cwd = outside;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["attach", "Genie", "t9"]);
  assert.equal(r.code, 1);
  assert.match(r.err, new RegExp(`runs in ${outside}.*not to Genie's project ${s.project}`));
  assert.deepEqual(labelCalls(s.calls()), []);
  assert.equal(existsSync(join(outside, ".claude")), false);
  assert.deepEqual(s.hcState().terminals[0].labels, {});
});

test("attach refuses another bot's pane and a pane that isn't live; a planned bot is refused", (t) => {
  const s = scene(t, { terminals: [term("t4", { bot: ID.cap }), term("t5", { state: "finished" })] });
  s.seed(team());
  assert.match(s.cli(["attach", "Genie", "t4"]).err, /t4 already plays Captain \(b-bbbbbbbbbb\)/);
  assert.match(s.cli(["attach", "Genie", "t5"]).err, /t5 isn't a live terminal/);
  assert.match(s.cli(["attach", "Studio", "t4"]).err, /Studio is planned/);
  assert.match(s.cli(["attach", "Genie", "vps/t4"]).err, /vps\/t4 is on vps; name the bot's project there: --machine vps/);
  assert.deepEqual(labelCalls(s.calls()), []);
});

test("attach of a bot attached elsewhere is refused, naming the holder; --move moves it, labels following", (t) => {
  const s = scene(t);
  const sub = join(s.project, "pkg");
  mkdirSync(sub);
  const st = { terminals: [term("t1", { bot: ID.main, cwd: s.project }), term("t2", { cwd: sub })], next: 100 };
  st.terminals[1].foreground.cwd = sub;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  s.seed(team());
  const bare = s.cli(["attach", "Genie", "t2"]);
  assert.equal(bare.code, 1);
  assert.match(bare.err, /Genie \(b-aaaaaaaaaa\) is attached to t1 \(since .*\); nothing was attached\. Move it with: automagik-herdr attach b-aaaaaaaaaa t2 --move/);
  assert.deepEqual(labelCalls(s.calls()), []);
  const r = s.cli(["attach", "Genie", "t2", "--move", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().movedFrom, ["t1"]);
  assert.deepEqual(labelCalls(s.calls()), [["label", "t1", "bot="], ["label", "t2", `bot=${ID.main}`], ["label", "t2", "role=main"]]);
  const labels = Object.fromEntries(s.hcState().terminals.map((x) => [x.address, x.labels]));
  assert.deepEqual(labels, { t1: {}, t2: { bot: ID.main, role: "main" } });
  assert.ok(existsSync(join(sub, ".claude/settings.local.json")));
  assert.match(r.err, /no briefing, restart the bot: automagik-herdr restart b-[a-z2-7]{10} \(or the bot row's Restart\)/);
});

test("attach: a label write that fails only warns: the ledger has the move", (t) => {
  const s = scene(t);
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals: [term("t1", { bot: ID.dev, app: "codex", argv: ["codex"] }), term("t2", { app: "codex", argv: ["codex"] })], failLabel: "t2" }));
  s.seed(team());
  const r = s.cli(["attach", "Dev", "t2", "--move"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /the ledger has it, but hc label t2 bot=b-cccccccccc failed/);
  assert.equal(s.cli(["whois", "t2", "--json"]).json().bot, ID.dev);
  assert.equal(s.cli(["whois", "t1", "--json"]).json().bot, null);
});

test("detach unties the bot from its ledger pane and takes the label off every local pane carrying it", (t) => {
  const s = scene(t, { terminals: [term("t1", { bot: ID.cap }), term("t2", { bot: ID.cap, argv: ["zsh"] })] });
  s.seed(team());
  const r = s.cli(["detach", "Captain", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json(), { id: ID.cap, defined: true, detached: ["t1"], labelsCleared: ["t1", "t2"] });
  assert.deepEqual(s.hcState().terminals.map((x) => x.labels), [{}, {}]);
  assert.match(s.cli(["detach", "Captain"]).out, /no pane on this computer/);
});

// ---- brief, errors ----

test("brief prints the bot's briefing: a lead sees its members' status and reports; planned bots get none", (t) => {
  const s = scene(t, { terminals: [term("t3", { bot: ID.dev, status: "blocked", msg: "waiting on the schema" }), term("t2", { bot: ID.cap })] });
  s.seed(team());
  const r = s.cli(["brief", "Captain"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Captain/);
  assert.match(r.out, /Dev/);
  assert.match(r.out, /waiting on the schema/);
  const dev = s.cli(["brief", "Dev", "--json"]).json();
  assert.match(dev.briefing, /t2/, "a member is told its lead's terminal");
  assert.equal(s.cli(["brief", "Studio", "--json"]).json().briefing, null);
});

test("errors: stderr and a non-zero exit; unknown commands and options are usage errors; names must be unique", (t) => {
  const s = scene(t);
  s.seed(team());
  const unknown = s.cli(["frob"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown command "frob"/);
  assert.equal(s.cli(["ls", "--bogus"]).code, 2);
  assert.equal(s.cli(["show"]).code, 2);
  assert.equal(s.cli(["--help"]).code, 0);
  const f = team();
  assert.throws(() => findBot({ ...f, bots: [...f.bots, bot("b-ffffffffff", "member", { name: "Dev" })] }, "Dev"), /2 bots are named "Dev"/);
  assert.equal(findBot(f, "genie").id, ID.main);
  const broken = s.botsPath;
  writeFileSync(broken, "{nope");
  const r = s.cli(["ls"]);
  assert.match(r.out, /not valid JSON|Unexpected token|Expected property name|JSON Parse error/);
});

// ---- review fixes ----

test("rm never deletes a file that still holds bots: members with no main bot are refused, file intact", (t) => {
  const s = scene(t);
  const f = team();
  f.bots = f.bots.filter((b) => b.kind !== "main"); // parseBots only warns about this
  s.seed(f);
  const before = readFileSync(s.botsPath, "utf8");
  const r = s.cli(["rm", "Studio"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Not saved: .*0 main bots/);
  assert.equal(readFileSync(s.botsPath, "utf8"), before);
});

test("rm of the main bot counts entries parseBots left out as other bots", (t) => {
  const s = scene(t);
  s.seed({ version: 1, categories: [], bots: [bot(ID.main, "main", { name: "Genie" }), { id: ID.dev, kind: "member" }] });
  const r = s.cli(["rm", "Genie"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /still has 1 other bot/);
  assert.ok(existsSync(s.botsPath));
});

test("start places the pane in the space of a live terminal in the project; with none it warns the pane is unseen", (t) => {
  const s = scene(t);
  s.seed(team());
  const sub = join(s.project, "pkg");
  mkdirSync(sub);
  const placed = term("t20", { cwd: sub, argv: ["zsh"], app: "zsh" });
  placed.labels = { "herdr.space": "sp9", "herdr.tab": "tb3" };
  const elsewhere = term("t21", { cwd: s.root, argv: ["zsh"], app: "zsh" });
  elsewhere.labels = { "herdr.space": "sp-other" };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals: [elsewhere, placed], next: 100 }));
  const r = s.cli(["start", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().space, r.json().tab], ["sp9", "tb3"]);
  const run = runCall(s.calls());
  assert.ok(run.includes("herdr.space=sp9") && run.includes("herdr.tab=tb3"));
  assert.doesNotMatch(r.err, /unseen/);
  // No terminal of the project carries a space and no window answers: started, with the warning.
  const s2 = scene(t);
  s2.seed(team());
  const r2 = s2.cli(["start", "Genie"]);
  assert.equal(r2.code, 0, r2.err);
  assert.match(r2.err, /No open Herdr space shows .*, so Herdr gives t100 no pane: it runs, unseen\. Watch it with hc attach t100/);
});

test("start with no space showing the project opens one on its folder and starts the bot in it; an open one is used", (t) => {
  const s = scene(t, { window: { spaces: [{ id: "sp1", name: "Other", folder: "/elsewhere", machine: null, active: true,
    tabs: [{ id: "tb1", name: "1", active: true, terminals: [] }] }] } });
  s.seed(team());
  const r = s.cli(["start", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  const made = s.appCalls().find((c) => c[0] === "do");
  assert.deepEqual(made && [made[1], JSON.parse(made[2])], ["space.new", { name: "proj", folder: s.project, machine: "" }]);
  assert.deepEqual([r.json().space, r.json().tab], ["sp-new1", "tb-new1"]);
  const run = runCall(s.calls());
  assert.ok(run.includes("herdr.space=sp-new1") && run.includes("herdr.tab=tb-new1"));
  assert.doesNotMatch(r.err, /unseen/);
  // That space is open now: the next bot starts in it, and no second space is made.
  assert.equal(s.cli(["start", "Captain"]).code, 0);
  assert.equal(s.appCalls().filter((c) => c[0] === "do").length, 1);
  assert.equal(s.windowNow().spaces.length, 2);
  assert.ok(runCall(s.calls().filter((c) => c.includes("bot=" + ID.cap))).includes("herdr.space=sp-new1"));
  // A project terminal still labelled with a space the window no longer shows (its last
  // pane closed): that label is passed over and a space is opened.
  const s3 = scene(t, { window: { spaces: [] } });
  s3.seed(team());
  const stale = term("t20", { cwd: s3.project, argv: ["zsh"], app: "zsh" });
  stale.labels = { "herdr.space": "sp9", "herdr.tab": "tb3" };
  writeFileSync(join(s3.root, "hc.json"), JSON.stringify({ terminals: [stale], next: 100 }));
  const r3 = s3.cli(["start", "Genie", "--json"]);
  assert.equal(r3.code, 0, r3.err);
  assert.deepEqual([r3.json().space, r3.json().tab], ["sp-new1", "tb-new1"]);
  // Another start opened a space on the folder at the same time: the first one is used and
  // the space this start opened is closed, so one space shows the project.
  const s4 = scene(t, { window: { spaces: [], rival: true } });
  s4.seed(team());
  const r4 = s4.cli(["start", "Genie", "--json"]);
  assert.equal(r4.code, 0, r4.err);
  assert.equal(r4.json().space, "sp-rival");
  assert.deepEqual(s4.appCalls().filter((c) => c[0] === "do").map((c) => [c[1], JSON.parse(c[2]).id ?? null]),
    [["space.new", null], ["space.close", "sp-new1"]]);
  assert.deepEqual(s4.windowNow().spaces.map((x) => x.id), ["sp-rival"]);
  // --space still picks the place: the window isn't asked.
  const s2 = scene(t, { window: { spaces: [] } });
  s2.seed(team());
  assert.equal(s2.cli(["start", "Genie", "--space", "sp7"]).code, 0);
  assert.deepEqual(s2.appCalls(), []);
});

test("start refuses an old free-text model pin, naming the fix; a pane started under a minute ago counts as running", (t) => {
  const f = team();
  f.bots[0].model = "Opus 5.5";
  const s = scene(t, { terminals: [term("t30", { bot: ID.cap, argv: ["sh", "-c", "claude"], app: "sh", created: Date.now() })] });
  s.seed(f);
  const r = s.cli(["start", "Genie"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /pinned to "Opus 5\.5", which isn't a claude model this computer lists\. Pick one with automagik-herdr edit b-aaaaaaaaaa --model/);
  const young = s.cli(["start", "Captain"]);
  assert.equal(young.code, 0);
  assert.match(young.out, /already running in t30/);
  assert.equal(s.calls().some((c) => c[0] === "run"), false);
});

test("a failing hc never reads as 'no pane': start, attach and detach refuse; ls and show say hc is unavailable", (t) => {
  const s = scene(t);
  s.seed(team());
  const st = { terminals: [term("t1", { bot: ID.main, cwd: s.project })], fail: ["server"] };
  st.terminals[0].foreground.cwd = s.project;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  for (const args of [["start", "Genie"], ["attach", "Genie", "t1"], ["detach", "Genie"]]) {
    const r = s.cli(args);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.err, /hc server status failed: hc: can't reach the server/);
  }
  assert.equal(s.calls().some((c) => c[0] === "run" || c[0] === "label"), false);
  const ls = s.cli(["ls", "--json"]);
  assert.equal(ls.code, 0, ls.err);
  const genie = ls.json().projects[0].bots[0];
  assert.equal(genie.status, "hc unavailable");
  assert.match(genie.hcError, /can't reach the server/);
  assert.match(s.cli(["ls"]).out, /panes unknown: hc server status/);
  assert.equal(s.cli(["show", "Genie", "--json"]).json().status, "hc unavailable");
  assert.equal(s.cli(["brief", "Genie"]).code, 0, "the briefing still prints, members unreachable");
});

test("an attached pane with a shell in front stays the bot's: shown as no agent in front, never as another's", (t) => {
  const s = scene(t, { terminals: [term("t1", { bot: ID.main, argv: ["zsh"], app: "zsh" }), term("t2", { bot: ID.cap })] });
  s.seed(team());
  const bots = s.cli(["ls", "--json"]).json().projects[0].bots;
  const gets = s.calls().filter((c) => c[0] === "get").map((c) => c[1]);
  assert.ok(gets.includes("t2") && gets.includes("t1"));
  assert.deepEqual([bots.find((b) => b.id === ID.main).terminal, bots.find((b) => b.id === ID.main).status], ["t1", "no agent in front"]);
  assert.equal(bots.find((b) => b.id === ID.cap).terminal, "t2");
});

test("attach: a terminal argument that looks like an option is refused; a claude wrapper counts as a Claude pane", (t) => {
  const s = scene(t, { terminals: [term("t9", { argv: ["node", "/opt/claude.js"], app: "agent", cwd: "/elsewhere" })] });
  s.seed(team());
  const opt = s.cli(["attach", "Genie", "--", "--all"]);
  assert.equal(opt.code, 2);
  assert.match(opt.err, /"--all" isn't a terminal/);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "hb-out-")));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const st = s.hcState();
  st.terminals[0].foreground.cwd = outside;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["attach", "Genie", "t9"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Not attached: this Claude session runs in/);
  assert.deepEqual(labelCalls(s.calls()), []);
});

test("ls over more bots than the eight-process cap completes, each live pane found", (t) => {
  const ids = Array.from({ length: 12 }, (_, i) => `b-${"abcdefghijkl"[i].repeat(10)}`);
  const s = scene(t, { terminals: ids.map((id, i) => term(`t${i + 1}`, { bot: id })) });
  s.seed({ version: 1, categories: [], bots: ids.map((id, i) => bot(id, i === 0 ? "main" : "member", { name: `B${i}` })) });
  const r = s.cli(["ls", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().projects[0].bots.map((b) => b.terminal), ids.map((_, i) => `t${i + 1}`));
});

test("detach takes a removed bot's label off by its bare id; an unknown name is still refused", (t) => {
  const s = scene(t, { terminals: [term("t1", { bot: ID.dev }), term("t2", { bot: ID.dev, argv: ["zsh"], app: "zsh" })] });
  s.seed(team());
  const rm = s.cli(["rm", "Dev"]);
  assert.equal(rm.code, 0, rm.err);
  assert.match(rm.err, new RegExp(`t1 is still attached to it; detach it with: automagik-herdr detach ${ID.dev}`));
  const r = s.cli(["detach", ID.dev, "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json(), { id: ID.dev, defined: false, detached: ["t1"], labelsCleared: ["t1", "t2"] });
  assert.deepEqual(s.hcState().terminals.map((x) => x.labels), [{}, {}]);
  assert.match(s.cli(["detach", "Ghost"]).err, /No bot "Ghost"/);
  // No bots.json at all: a bare id still works.
  rmSync(s.botsPath);
  assert.equal(s.cli(["detach", ID.dev]).code, 0);
});

// ---- A16: pane labels ----

const labelsIn = (s) => Object.fromEntries(s.hcState().terminals.map((x) => [x.address, x.labels]));

test("--rank on create and edit: checked against the set, '' clears it; show and ls --json carry it", (t) => {
  const s = scene(t);
  s.seed(team());
  const bad = s.cli(["edit", "Dev", "--rank", "boss"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--rank is one of captain, dev, tester, reviewer, fixer, integrator, pm, owner/);
  assert.equal(s.cli(["create", "--name", "Ana", "--agent", "claude", "--rank", "tester"]).code, 0);
  assert.equal(s.bots().bots.find((b) => b.name === "Ana").rank, "tester");
  assert.equal(s.cli(["edit", "Dev", "--rank", "reviewer"]).code, 0);
  assert.equal(s.cli(["show", "Dev", "--json"]).json().rank, "reviewer");
  assert.match(s.cli(["show", "Dev"]).out, /rank\s+reviewer/);
  assert.equal(s.cli(["ls", "--json"]).json().projects[0].bots.find((b) => b.name === "Dev").rank, "reviewer");
  assert.equal(s.cli(["edit", "Dev", "--rank", ""]).code, 0);
  assert.equal("rank" in s.bots().bots.find((b) => b.name === "Dev"), false);
  assert.equal(s.cli(["show", "Dev", "--json"]).json().rank, null);
});

test("start labels the pane: role from rank or captaincy, category, and the lead pane's squad, marked", (t) => {
  const lead = term("t7", { bot: ID.cap });
  lead.labels.squad = "memory";
  const s = scene(t, { terminals: [lead] });
  const f = team();
  f.bots.find((b) => b.id === ID.dev).rank = "dev";
  s.seed(f);
  assert.equal(s.cli(["start", "Dev"]).code, 0);
  const run = runCall(s.calls());
  const labels = run.flatMap((w, i) => (run[i - 1] === "--label" ? [w] : []));
  assert.deepEqual(labels, [`bot=${ID.dev}`, "role=dev", "category=eng", "squad=memory", "automagik-herdr.squad=memory"]);
});

test("attach labels the pane and keeps its own squad; detach takes off bot, role, category and only a copied squad", (t) => {
  const lead = term("t7", { bot: ID.cap });
  lead.labels.squad = "memory";
  const own = term("t8", { cwd: "/x" });
  own.labels.squad = "infra";
  const s = scene(t, { terminals: [lead, own, term("t9", { cwd: "/x" })] });
  const f = team();
  f.bots.find((b) => b.id === ID.dev).rank = "tester";
  s.seed(f);
  for (const [address] of [["t8"], ["t9"]]) {
    const st = s.hcState();
    st.terminals.find((x) => x.address === address).foreground.cwd = s.project;
    writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  }
  assert.equal(s.cli(["attach", "Dev", "t8"]).code, 0);
  assert.deepEqual(labelsIn(s).t8, { squad: "infra", bot: ID.dev, role: "tester", category: "eng" });
  // Moved to t9: t8 loses what Detach takes off, keeping its own squad; t9 copies the lead's.
  assert.equal(s.cli(["attach", "Dev", "t9", "--move"]).code, 0);
  assert.deepEqual(labelsIn(s).t8, { squad: "infra" });
  assert.deepEqual(labelsIn(s).t9, { bot: ID.dev, role: "tester", category: "eng", squad: "memory", "automagik-herdr.squad": "memory" });
  assert.equal(s.cli(["detach", "Dev"]).code, 0);
  assert.deepEqual(labelsIn(s).t9, {});
  // The captain's own squad stays on detach: this pack didn't put it there.
  assert.equal(s.cli(["detach", "Captain"]).code, 0);
  assert.deepEqual(labelsIn(s).t7, { squad: "memory" });
});

test("an edit relabels the live local panes it changes, the old and new leads included; a remote pane is never touched", (t) => {
  const s = scene(t, { terminals: [
    term("t1", { bot: ID.main }), term("t7", { bot: ID.cap }), term("t8", { bot: ID.dev }), term("far/t9", { bot: ID.dev }),
  ] });
  const f = team();
  f.bots.find((b) => b.id === ID.cap).rank = "integrator";
  s.seed(f);
  // Labels as Start would have set them.
  const st = s.hcState();
  Object.assign(st.terminals.find((x) => x.address === "t7").labels, { role: "captain", category: "eng" });
  Object.assign(st.terminals.find((x) => x.address === "t8").labels, { category: "eng" });
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  // Dev moves to the main bot, no category, rank dev: the captain leads nobody now.
  const r = s.cli(["edit", "Dev", "--lead", "Genie", "--rank", "dev", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(r.json().relabelled.sort(), ["t7", "t8"]);
  const labels = labelsIn(s);
  assert.deepEqual(labels.t7, { bot: ID.cap, role: "integrator", category: "eng" });
  assert.deepEqual(labels.t8, { bot: ID.dev, role: "dev" });
  assert.deepEqual(labels["far/t9"], { bot: ID.dev });
  assert.equal(labelCalls(s.calls()).some((c) => c[1].includes("/")), false);
  // A change that moves no label: no label call.
  const before = labelCalls(s.calls()).length;
  assert.equal(s.cli(["edit", "Dev", "--role", "writes code"]).code, 0);
  assert.equal(labelCalls(s.calls()).length, before);
});

test("category add --id takes slug ids only; a hand-written non-slug id stays usable, with no category label", (t) => {
  const s = scene(t, { terminals: [term("t8", { bot: ID.dev })] });
  s.seed(team());
  const bad = s.cli(["category", "add", "--title", "Quality", "--id", "Quality Gate"]);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--id "Quality Gate" isn't a category id: a lowercase slug/);
  assert.equal(s.cli(["category", "add", "--title", "Quality Gate!"]).code, 0);
  assert.ok(s.bots().categories.some((c) => c.id === "quality-gate"));
  // brain-v3 style: "Knowledge" written by hand. Edits of the file still work.
  const f = team();
  f.categories.push({ id: "Knowledge", title: "Knowledge" });
  s.seed(f);
  const r = s.cli(["edit", "Dev", "--lead", "Genie", "--category", "Knowledge", "--rank", "dev"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(s.bots().bots.find((b) => b.id === ID.dev).category, "Knowledge");
  assert.equal(s.cli(["edit", "Captain", "--role", "still editable"]).code, 0);
  // Its pane gets a role but no category= label.
  assert.deepEqual(labelsIn(s).t8, { bot: ID.dev, role: "dev" });
});

test("a lead change moves the squad copied from the old lead, and leaves a pane's own squad", (t) => {
  const cap = term("t7", { bot: ID.cap });
  cap.labels.squad = "memory";
  const main = term("t1", { bot: ID.main });
  main.labels.squad = "core";
  const dev = term("t8", { bot: ID.dev });
  Object.assign(dev.labels, { squad: "memory", "automagik-herdr.squad": "memory" });
  const s = scene(t, { terminals: [main, cap, dev] });
  s.seed(team());
  assert.equal(s.cli(["edit", "Dev", "--lead", "Genie"]).code, 0);
  assert.deepEqual([labelsIn(s).t8.squad, labelsIn(s).t8["automagik-herdr.squad"]], ["core", "core"]);
  // Its own squad (set after the copy) stays when the lead changes again.
  const st = s.hcState();
  st.terminals.find((x) => x.address === "t8").labels.squad = "ops";
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  assert.equal(s.cli(["edit", "Dev", "--lead", "Captain"]).code, 0);
  assert.equal(labelsIn(s).t8.squad, "ops");
  // Detach keeps that squad and takes the mark off.
  assert.equal(s.cli(["detach", "Dev"]).code, 0);
  assert.deepEqual(labelsIn(s).t8, { squad: "ops" });
});

test("attach leaves the pane matching the bot: a stale role or category from its last bot comes off; an unmarked squad stays", (t) => {
  const pane = term("t8", { cwd: "/x" });
  Object.assign(pane.labels, { role: "captain", category: "old", squad: "ops" });
  const s = scene(t, { terminals: [pane] });
  s.seed(team()); // Dev: no rank, under the captain (category eng)
  const st = s.hcState();
  st.terminals[0].foreground.cwd = s.project;
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  assert.equal(s.cli(["attach", "Dev", "t8"]).code, 0);
  assert.deepEqual(labelsIn(s).t8, { squad: "ops", bot: ID.dev, category: "eng" });
});

test("start: an edit landing during hc run relabels the new pane; a failed relabel reaches stderr", (t) => {
  const s = scene(t);
  s.seed(team());
  const edited = team();
  edited.bots.find((b) => b.id === ID.dev).rank = "reviewer";
  const st = s.hcState();
  st.onRunWrite = { path: s.botsPath, text: `${JSON.stringify(edited, null, 2)}\n` };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const ok = s.cli(["start", "Dev"]);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(labelsIn(s).t100.role, "reviewer");
  // Again, with the new pane refusing the label.
  s.seed(team());
  const st2 = s.hcState();
  st2.terminals = [];
  st2.failLabel = "t101";
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st2));
  const r = s.cli(["start", "Dev"]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /t101's labels role=reviewer weren't set\./);
});

// ---- restart ----

// The replacement must keep its agent in front this long before the old pane ends (5s live).
process.env.AUTOMAGIK_HERDR_RESTART_STABLE_MS = "300";
const SID = "0f3c2a4e-1b2d-4c5e-9f60-718293a4b5c6";
const SID2 = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const ledgerOf = (s) => readLedger(existsSync(ledgerPath(s.app)) ? readFileSync(ledgerPath(s.app), "utf8") : "");
const attachOf = (s) => readRows(existsSync(attachFile(s.app)) ? readFileSync(attachFile(s.app), "utf8") : "").rows;

/** Genie's live pane t5 in the project, placed in sp9/tb3, with a Claude session and a squad. */
function restartScene(t, { status = "idle", extra = [], session = SID, runAs } = {}) {
  const s = scene(t);
  s.seed(team());
  const old = term("t5", { bot: ID.main, cwd: s.project, status });
  old.foreground.cwd = s.project;
  old.labels = { ...old.labels, role: "main", "herdr.space": "sp9", "herdr.tab": "tb3", squad: "core", ...(session ? { "agent.session": session } : {}) };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify({ terminals: [old, ...extra], next: 100, ...(runAs ? { runAs } : {}) }));
  return s;
}
const at = (calls, word, target) => calls.findIndex((c) => c[0] === word && (target === undefined || c[1] === target));

test("restart: the new pane resumes the session in the old one's space and tab, folder and labels; the old one ends only after", (t) => {
  const s = restartScene(t);
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), "t100", "prints the new terminal");
  assert.match(r.err, new RegExp(`Genie: t100 replaces t5, resuming session ${SID}\\.`));
  const calls = s.calls();
  const run = runCall(calls);
  assert.deepEqual(run.slice(run.indexOf("--")), ["--", "claude", "--resume", SID]);
  assert.ok(["herdr.space=sp9", "herdr.tab=tb3", `bot=${ID.main}`, "role=main", "squad=core", `agent.session=${SID}`].every((l) => run.includes(l)), run.join(" "));
  assert.equal(run[run.indexOf("--cwd") + 1], s.project);
  // Started, seen live at several checks (hc get of the new pane), and only then the old one killed.
  const ran = at(calls, "run"), killed = at(calls, "kill", "t5");
  assert.ok(ran >= 0 && ran < killed, JSON.stringify(calls));
  const seen = calls.slice(ran, killed).filter((c) => c[0] === "get" && c[1] === "t100").length;
  assert.ok(seen >= 2, `the new pane was checked before the kill: ${JSON.stringify(calls)}`);
  assert.equal(calls.filter((c) => c[0] === "kill").length, 1);
  const state = s.hcState();
  assert.equal(state.terminals.find((x) => x.address === "t5").state, "finished");
  assert.equal(state.terminals.find((x) => x.address === "t100").state, "live");
  // The attach ledger: t5's binding detached (by start, moved), t100 attached (by start), and
  // exactly one live binding for Genie, on t100.
  const attach = attachOf(s);
  assert.deepEqual(attach.slice(-2).map((x) => [x.event, x.terminal, x.by, x.reason ?? null]), [["detach", "t5", "start", "moved"], ["attach", "t100", "start", null]]);
  const bound = [...foldRows(attach).byKey.values()].filter((b) => b.bot === ID.main);
  assert.deepEqual(bound.map((b) => b.terminal), ["t100"]);
  assert.equal(foldRows(attach).byBot.get(ID.main).terminal, "t100");
  const whois = s.cli(["whois", "--bot", ID.main, "--json"]);
  assert.equal(whois.json().terminal, "t100", whois.err);
  // The seat row and the resumed session's row, for t100.
  const rows = ledgerOf(s).filter((x) => x.terminal === "t100");
  assert.deepEqual(rows.map((x) => [x.event, x.kind ?? x.session]), [["start", "seat"], ["session", SID]]);
  assert.equal(rows[0].project, s.project);
  // A second restart resumes the same conversation: the label went with it (t100 is mid-turn in the fake).
  const again = s.cli(["restart", "Genie", "--force"]);
  assert.equal(again.code, 0, again.err);
  assert.deepEqual(s.calls().filter((c) => c[0] === "run")[1].slice(-3), ["claude", "--resume", SID]);
});

test("restart refuses a working bot (nothing started or ended) unless --force", (t) => {
  const s = restartScene(t, { status: "working" });
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Genie is working in t5; restarting now would cut its turn in half\. Wait until it is idle, or pass --force\./);
  assert.equal(runCall(s.calls()), undefined);
  assert.equal(at(s.calls(), "kill"), -1);
  const forced = s.cli(["restart", "Genie", "--force"]);
  assert.equal(forced.code, 0, forced.err);
  assert.ok(at(s.calls(), "run") < at(s.calls(), "kill", "t5"));
});

test("restart refuses while a helper would end with the pane; a member bot that outlives it doesn't count", (t) => {
  const worker = { ...term("t7", { argv: ["codex"], app: "codex", parent: "t5" }), die_with_parent: true };
  const member = { ...term("t8", { bot: ID.cap, parent: "t5" }), die_with_parent: false };
  const s = restartScene(t, { extra: [worker, member] });
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /t5 has a helper that ends with it: t7\. Let it finish, or pass --force/);
  assert.equal(runCall(s.calls()), undefined);
});

test("restart keeps the old pane when the new one never brings its agent up, exits, or exits after coming up", (t) => {
  process.env.AUTOMAGIK_HERDR_RESTART_WAIT_MS = "400";
  t.after(() => { delete process.env.AUTOMAGIK_HERDR_RESTART_WAIT_MS; });
  const s = restartScene(t, { runAs: "shell" });
  assert.equal(s.cli(["whois", "--bot", ID.main, "--json"]).json().terminal, "t5"); // the ledger imported t5
  const before = attachOf(s);
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /t100 didn't keep an agent in front within 0\.4s, so it was ended; t5 still runs Genie, untouched\./);
  assert.deepEqual(s.calls().filter((c) => c[0] === "kill").map((c) => c[1]), ["t100"], "the abandoned pane ended, never t5");
  assert.equal(s.hcState().terminals.find((x) => x.address === "t5").state, "live");
  assert.equal(ledgerOf(s).some((x) => x.terminal === "t100"), false, "no seat row for the abandoned pane");
  assert.deepEqual(attachOf(s).filter((x) => x.event !== "end"), before, "a failed replacement writes no attach rows");
  assert.equal(foldRows(attachOf(s)).byBot.get(ID.main).terminal, "t5");
  const s2 = restartScene(t, { runAs: "exit" });
  const r2 = s2.cli(["restart", "Genie"]);
  assert.equal(r2.code, 1);
  assert.match(r2.err, /t100 exited before its agent was up .*t5 still runs Genie, untouched\. Try automagik-herdr restart b-aaaaaaaaaa --fresh\./);
  assert.equal(at(s2.calls(), "kill"), -1);
  // Its agent in front at the first check, then gone (a stale --resume id): the old pane survives.
  delete process.env.AUTOMAGIK_HERDR_RESTART_WAIT_MS;
  const s3 = restartScene(t, { runAs: "flaky" });
  const r3 = s3.cli(["restart", "Genie"]);
  assert.equal(r3.code, 1);
  assert.match(r3.err, /t100 exited before its agent was up/);
  assert.equal(at(s3.calls(), "kill"), -1);
  assert.equal(s3.hcState().terminals.find((x) => x.address === "t5").state, "live");
  assert.equal(ledgerOf(s3).some((x) => x.terminal === "t100"), false);
  assert.equal(attachOf(s3).some((x) => x.terminal === "t100"), false, "no attach row for the replacement that exited");
  assert.equal(foldRows(attachOf(s3)).byBot.get(ID.main).terminal, "t5");
});

test("restart with no session id known: claude --continue, with a warning; --fresh starts a new conversation", (t) => {
  const s = restartScene(t, { session: "-rf" }); // not a session id: never passed to --resume
  const r = s.cli(["restart", "Genie", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().mode, r.json().replaced, r.json().terminal], ["resume", "t5", "t100"]);
  assert.deepEqual(runCall(s.calls()).slice(-2), ["claude", "--continue"]);
  assert.match(r.err, /No Claude session id was known for t5, so t100 resumes the latest conversation in .* \(--continue\)/);
  const s2 = restartScene(t);
  const fresh = s2.cli(["restart", "Genie", "--fresh", "--json"]);
  assert.equal(fresh.code, 0, fresh.err);
  assert.equal(fresh.json().mode, "fresh");
  assert.deepEqual(runCall(s2.calls()).slice(-2), ["--", "claude"]);
});

test("restart --agent swaps fresh without touching bots.json; --save writes the agent and drops the old pin; --save alone is a usage mistake", (t) => {
  const s = restartScene(t);
  const before = readFileSync(s.botsPath, "utf8");
  const r = s.cli(["restart", "Genie", "--agent", "codex", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual([r.json().mode, r.json().agent, r.json().saved], ["swap", "codex", false]);
  assert.deepEqual(runCall(s.calls()).slice(-2), ["--", "codex"]);
  assert.equal(readFileSync(s.botsPath, "utf8"), before, "bots.json untouched");
  // Again from the claude pin, written down this time (t100 is mid-turn in the fake: --force).
  const f = team();
  f.bots[0].model = "claude-opus-5-5";
  s.seed(f);
  const saved = s.cli(["restart", "Genie", "--agent", "codex", "--save", "--force"]);
  assert.equal(saved.code, 0, saved.err);
  assert.equal(s.bots().bots[0].agent, "codex");
  assert.equal("model" in s.bots().bots[0], false, "the claude pin is dropped");
  assert.match(saved.err, /bots\.json now says codex/);
  const lone = s.cli(["restart", "Genie", "--save"]);
  assert.equal(lone.code, 2);
  assert.match(lone.err, /--save keeps a swap/);
});

test("restart a codex bot resumes with codex resume --last; a bot not running is started as start does", (t) => {
  const s = scene(t, { terminals: [term("t6", { bot: ID.cap, argv: ["codex"], app: "codex", cwd: "/p" })] });
  const f = team();
  f.bots[1].agent = "codex";
  s.seed(f);
  const r = s.cli(["restart", "Captain", "--json"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(runCall(s.calls()).slice(-3), ["codex", "resume", "--last"]);
  assert.equal(r.json().replaced, "t6");
  // Genie isn't running: a plain start, nothing killed but t6.
  const started = s.cli(["restart", "Genie", "--json"]);
  assert.equal(started.code, 0, started.err);
  assert.deepEqual([started.json().mode, started.json().replaced], ["start", null]);
  assert.deepEqual(s.calls().filter((c) => c[0] === "run")[1].slice(-2), ["--", "claude"]);
  assert.deepEqual(s.calls().filter((c) => c[0] === "kill").map((c) => c[1]), ["t6"]);
});

test("restart: the ledger's session row for the old pane stands in for a missing label; --continue is refused beside another bot's Claude", (t) => {
  const s = restartScene(t, { session: null });
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  writeFileSync(ledgerPath(s.app), [{ event: "session", terminal: "t5", session: SID2, transcript: "/x.jsonl" }, { event: "session", terminal: "t6", session: SID }]
    .map((x) => `${JSON.stringify(x)}\n`).join(""));
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(runCall(s.calls()).slice(-3), ["claude", "--resume", SID2]);
  assert.deepEqual(ledgerOf(s).filter((x) => x.terminal === "t100" && x.event === "session").map((x) => [x.session, x.transcript]), [[SID2, "/x.jsonl"]]);
  // No label, no ledger row, and Captain's Claude in the same folder: refused, nothing started.
  const mate = term("t9", { bot: ID.cap, cwd: "" });
  const s2 = restartScene(t, { session: null, extra: [mate] });
  const st = s2.hcState();
  st.terminals.find((x) => x.address === "t9").cwd = s2.project;
  st.terminals.find((x) => x.address === "t9").foreground.cwd = s2.project;
  writeFileSync(join(s2.root, "hc.json"), JSON.stringify(st));
  const refused = s2.cli(["restart", "Genie"]);
  assert.equal(refused.code, 1);
  assert.match(refused.err, /Genie has no recorded Claude session .* and Captain \(t9\) also runs Claude in .*, so --continue could resume theirs\. Nothing was started; restart with --fresh/);
  assert.equal(runCall(s2.calls()), undefined);
  assert.equal(s2.cli(["restart", "Genie", "--fresh"]).code, 0);
});

test("a bot restarting itself writes and prints everything before the kill that ends its own pane", (t) => {
  const s = restartScene(t);
  const r = s.cli(["restart", "Genie", "--agent", "codex", "--save", "--json"], { env: { HC_TERMINAL_ID: "t5" } });
  // The fake hc ends the CLI as the real kill of its own pane would: what it printed first stands.
  assert.equal(r.json().terminal, "t100", r.err);
  assert.deepEqual([r.json().replaced, r.json().mode, r.json().saved], ["t5", "swap", true]);
  assert.equal(s.bots().bots[0].agent, "codex", "saved before the kill");
  const calls = s.calls();
  assert.deepEqual(calls.at(-1), ["kill", "t5"], "the kill is the last hc call");
  assert.ok(ledgerOf(s).some((x) => x.terminal === "t100" && x.kind === "seat"));
});

test("restart: the bot attached elsewhere while the new pane came up: the new pane is ended, no rows written, the other binding kept", (t) => {
  const other = term("t9", { bot: null, cwd: "/elsewhere", created: 77 });
  const s = restartScene(t, { extra: [other] });
  assert.equal(s.cli(["whois", "--bot", ID.main, "--json"]).json().terminal, "t5");
  // While hc run starts t100, another CLI attaches Genie to t9 (an attach row, as attach --move writes).
  const rows = attachOf(s);
  const moved = { ...rows.find((x) => x.terminal === "t5"), terminal: "t9", created_ms: 77, by: "attach", at: new Date().toISOString() };
  const st = s.hcState();
  st.onRunWrite = { path: attachFile(s.app), text: [...rows, moved].map((x) => `${JSON.stringify(x)}\n`).join("") };
  writeFileSync(join(s.root, "hc.json"), JSON.stringify(st));
  const r = s.cli(["restart", "Genie"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Genie was attached to t9 while it restarted, so t100 was ended and nothing changed\./);
  assert.deepEqual(s.calls().filter((c) => c[0] === "kill").map((c) => c[1]), ["t100"]);
  assert.equal(attachOf(s).some((x) => x.terminal === "t100"), false);
  assert.equal(foldRows(attachOf(s)).byBot.get(ID.main).terminal, "t9");
});

// ---- history (#85): what a bot did, by the two ledgers ----

test("history: the bot's panes, starts, sessions (only while it held the pane) and workers; text and --json", (t) => {
  const s = scene(t);
  s.seed(team());
  mkdirSync(join(s.app, "automagik-herdr"), { recursive: true });
  const at = (m) => `2026-11-03T10:0${m}:00.000Z`;
  const row = (event, b, terminal, m, by) => ({ v: 1, event, bot: b, project: s.project, terminal, core: "c1", created_ms: 1, machine: null, by, at: at(m) });
  writeFileSync(attachFile(s.app), [row("attach", ID.dev, "t5", 1, "start"), row("detach", ID.dev, "t5", 3, "detach"), row("attach", ID.cap, "t5", 4, "attach")]
    .map((r) => `${JSON.stringify(r)}\n`).join(""), { mode: 0o600 });
  writeFileSync(ledgerPath(s.app), [
    { event: "start", kind: "seat", terminal: "t5", botId: ID.dev, agent: "claude", model: null, at: at(1) },
    { event: "session", terminal: "t5", session: "11111111-aaaa", transcript: "/x/dev.jsonl", at: at(2) },
    { event: "start", kind: "worker", terminal: "t8", botId: ID.dev, branch: "fix-x", role: "dev", agent: "codex", at: at(2) },
    { event: "session", terminal: "t5", session: "22222222-bbbb", transcript: "/x/captain.jsonl", at: at(5) },
  ].map((r) => `${JSON.stringify(r)}\n`).join(""));
  const json = s.cli(["history", "Dev", "--json"]);
  assert.equal(json.code, 0, json.err);
  const h = json.json();
  assert.equal(h.id, ID.dev);
  assert.equal(h.name, "Dev");
  assert.deepEqual(h.attach.map((r) => r.event), ["attach", "detach"]);
  assert.deepEqual(h.starts.map((r) => r.terminal), ["t5"]);
  assert.deepEqual(h.workers.map((r) => r.branch), ["fix-x"]);
  assert.deepEqual(h.sessions.map((r) => r.session), ["11111111-aaaa"], "Captain's later session in t5 isn't Dev's");
  assert.equal(h.transcript, "/x/dev.jsonl");
  const text = s.cli(["history", "Dev"]);
  assert.equal(text.code, 0, text.err);
  assert.match(text.out, /^Dev \(b-cccccccccc\)\n {2}what happened\n {4}2026-11-03 10:03 detached from t5 · by detach\n/);
  assert.match(text.out, / {2}workers\n {4}2026-11-03 10:02 fix-x · dev · codex · t8\n/);
  assert.match(text.out, / {2}transcript {3}\/x\/dev\.jsonl/);
  // The ledgers are only read.
  assert.equal(attachOf(s).length, 3);
  assert.equal(ledgerOf(s).length, 4);
});

test("history: no ledgers is an empty history; a removed bot by its bare id; an unknown name is refused", (t) => {
  const s = scene(t);
  s.seed(team());
  assert.match(s.cli(["history", "Studio"]).out, /nothing recorded on this computer/);
  const gone = s.cli(["history", "b-zzzzzzzzzz", "--json"]);
  assert.equal(gone.code, 0, gone.err);
  assert.deepEqual(gone.json(), { id: "b-zzzzzzzzzz", name: null, bot: "b-zzzzzzzzzz", attach: [], starts: [], workers: [], sessions: [], transcript: null });
  assert.match(s.cli(["history", "nobody"]).err, /No bot "nobody"/);
  assert.equal(s.cli(["history"]).code, 2);
});
