// The bot form (create.js) under `node --test`, with gpui and herdr stood in for
// (gpui-stub.mjs, form-herdr-stub.mjs): what it lists, what Copy copies, how a save or a
// Start that fails is reported, and that a picture it can't write is not retried.
import { registerHooks } from "node:module";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = (f) => new URL(f, import.meta.url).href;
const stubs = { herdr: here("./form-herdr-stub.mjs"), "fs/promises": here("./fs-stub.mjs"), "gpui-kit": here("./gpui-stub.mjs"), "gpui-base": here("./gpui-stub.mjs") };
const fromPack = (context) => context.parentURL?.includes("/mods/am-sidebar/");
registerHooks({
  resolve: (specifier, context, next) => (stubs[specifier] && fromPack(context) ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context)),
});
const { state } = await import(stubs.herdr);
const { nodes, textOf, index, all } = await import(stubs["gpui-kit"]);
const { BotForm, FORM_SIZE } = await import("../mods/am-sidebar/create.js");
const { hcFileOps } = await import("./hc-file-ops.mjs");

const look = (character, colour) => ({ character, colour });
const MAIN = { id: "b-mainaaaaaa", name: "orch", kind: "main", look: look("octopus", "deepseek"), role: "", instructions: "", agent: "claude" };
const OMP = { id: "b-ompaaaaaaa", name: "pi-bot", kind: "member", look: look("hex", "sky"), role: "r", instructions: "", agent: "omp", model: "kimi-k3" };
const KIMI = { id: "b-kimiaaaaaa", name: "kimi-bot", kind: "member", look: look("gem", "rose"), role: "r", instructions: "", agent: "kimi" };
const AGENTS = [
  { key: "claude", name: "Claude Code", installed: true, icon: "icons/claude.svg", tint: false },
  { key: "omp", name: "Oh My Pi", installed: true, icon: "icons/pi.svg", tint: true },
  { key: "kimi", name: "Kimi", installed: false, icon: "icons/kimi.svg", tint: false },
  { key: "amp", name: "Amp", installed: false, icon: "icons/amp.svg", tint: false },
];

function makeCx() {
  const cx = {
    pending: [], spawns: 0, notifies: 0, clip: null,
    spawn(fn) { cx.spawns += 1; const p = Promise.resolve().then(() => fn(cx)); cx.pending.push(p); return p; },
    notify() { cx.notifies += 1; },
    write_to_clipboard(text) { cx.clip = text; },
    stop_propagation() {},
  };
  cx.settle = async () => { for (let i = 0; i < 100 && cx.pending.length; i += 1) await Promise.allSettled(cx.pending.splice(0)); };
  return cx;
}

let root, project;
beforeEach((t) => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "hb-create-")));
  t.after?.(() => rmSync(root, { recursive: true, force: true }));
  project = join(root, "proj");
  mkdirSync(join(project, ".herdr"), { recursive: true });
  state.appHome = join(root, "app");
  state.notes = [];
  state.closed = [];
  state.runs = [];
  state.spaces = [];
  state.focused = null;
  state.pickFolder = null;
  state.terminals = [];
  state.agents = AGENTS;
  state.hcAnswer = () => ({ code: 0, stdout: "{}", stderr: "" });
  state.offline = new Set();
  state.calls = [];
  state.hcCalls = [];
});

const seed = (bots, extra = {}) => writeFileSync(join(project, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [], bots, ...extra }, null, 2)}\n`);
const stored = () => JSON.parse(readFileSync(join(project, ".herdr/bots.json"), "utf8"));
async function open(props) {
  const cx = makeCx();
  const form = new BotForm({ overlay: "o9", project, ...props }, cx);
  await cx.settle();
  return { form, cx, draw: () => index(form.render(cx)), click: async (id) => { nodes.get(id).click(null, cx); await cx.settle(); } };
}

test("FORM_SIZE is the mockup's 1000 x 840", () => {
  assert.deepEqual(FORM_SIZE, { width: 1000, height: 840 });
});

test("Runs on: installed agents only, plus the bot's own agent when it isn't installed", async () => {
  seed([MAIN, KIMI]);
  const { draw } = await open({ form: "create" });
  draw();
  assert.ok(nodes.has("bot-agent-claude") && nodes.has("bot-agent-omp"));
  assert.ok(!nodes.has("bot-agent-kimi") && !nodes.has("bot-agent-amp"));
  const e = await open({ form: "edit", bot: KIMI.id });
  e.draw();
  assert.ok(nodes.has("bot-agent-kimi"), "the bot's own agent stays shown");
  assert.equal(nodes.get("bot-agent-kimi").props.opacity, 0.45);
  assert.ok(!nodes.has("bot-agent-amp"));
});

test("Runs on: gemini is never offered; a gemini bot opens on Antigravity", async () => {
  state.agents = [...AGENTS,
    { key: "gemini", name: "Gemini", installed: true, icon: "icons/gemini.svg", tint: false },
    { key: "antigravity", name: "Antigravity", installed: false, icon: "icons/antigravity.svg", tint: false }];
  const GEM = { ...KIMI, id: "b-gemaaaaaaa", name: "gem-bot", agent: "gemini" };
  seed([MAIN, GEM]);
  const { draw } = await open({ form: "create" });
  draw();
  assert.ok(!nodes.has("bot-agent-gemini"), "installed, but retired");
  const e = await open({ form: "edit", bot: GEM.id });
  e.draw();
  assert.ok(!nodes.has("bot-agent-gemini"));
  assert.ok(nodes.has("bot-agent-antigravity"), "the mapped agent is the bot's own");
});

test("Runs on: a knownAgents() failure is shown, not swallowed", async () => {
  seed([MAIN]);
  Object.defineProperty(state, "agents", { configurable: true, get() { throw new Error("no program table"); } });
  try {
    const { form, draw } = await open({ form: "create" });
    assert.match(textOf(draw()), /couldn't list its coding agents \(no program table\)/);
    assert.ok(form.agentsError);
  } finally {
    Object.defineProperty(state, "agents", { configurable: true, writable: true, value: AGENTS });
  }
});

test("a stored pin can be cleared when the agent lists no models", async () => {
  seed([MAIN, OMP]);
  const { form, draw, click } = await open({ form: "edit", bot: OMP.id });
  draw();
  assert.ok(nodes.has("bot-pin"), "the pin control shows for a stored pin");
  form.pop = "models";
  draw();
  await click("bot-pin-0"); // Default
  assert.equal(form.s.pin, "");
  draw();
  assert.ok(!nodes.has("bot-pin"), "no list and no pin: no control");
});

test("Copy copies only a line the form would save; a refused one shows why", async () => {
  seed([MAIN]);
  const { form, cx, draw, click } = await open({ form: "create" });
  draw();
  await click("bot-copy");
  assert.equal(cx.clip, null);
  assert.equal(form.error, "Not copied: Give the bot a name.");
  form.inputs.name.type("qa", cx);
  draw();
  await click("bot-copy");
  assert.match(cx.clip, /^automagik-herdr create --name=qa /);
  // The model is read once per agent, not on every render.
  assert.ok(form.models.has("claude"));
});

test("a refused write says Not saved once", async () => {
  // An entry parseBots leaves out (a bad id) stays in the raw copy, so checkBots refuses the write.
  seed([MAIN, { id: "x", name: "broken", kind: "member" }]);
  const { form, cx, draw, click } = await open({ form: "create" });
  form.inputs.name.type("qa", cx);
  draw();
  await click("bot-save");
  assert.match(form.error, /^Not saved: x: id is not b- plus 10 base32 characters/);
  assert.doesNotMatch(form.error, /Not saved: Not saved/);
});

test("Create & start: a Start that throws after the save says Saved, not started", async () => {
  seed([MAIN]);
  const { form, cx, draw, click } = await open({ form: "create" });
  form.inputs.name.type("qa", cx);
  draw();
  Object.defineProperty(state, "terminals", { configurable: true, get() { throw new Error("terminals gone"); } });
  try {
    await click("bot-save-start");
  } finally {
    Object.defineProperty(state, "terminals", { configurable: true, writable: true, value: [] });
  }
  assert.match(form.error, /^Saved, not started: /);
  assert.ok(stored().bots.some((b) => b.name === "qa"), "the bot was saved");
  draw();
  assert.ok(!nodes.has("bot-save") && !nodes.has("bot-save-start"), "not offered a second time");
  assert.deepEqual(state.closed, []);
});

test("a character picture that can't be written is not retried, and one notice names the folder", async () => {
  seed([MAIN]);
  writeFileSync(join(root, "app"), "a file where the app home should be");
  const { form, cx, draw, click } = await open({ form: "create" });
  const spawns = cx.spawns;
  assert.equal(state.notes.length, 1);
  assert.match(state.notes[0].body, new RegExp(`${root}/app/am-sidebar-pets`));
  assert.ok(form.petsFailed.size > 0 && form.pets.size === 0);
  // Redraws and a new colour: no endless retry, no second notice.
  draw(); draw();
  await cx.settle();
  assert.equal(cx.spawns, spawns);
  draw();
  await click("bot-colour-rose");
  assert.ok(cx.spawns <= spawns + 1);
  assert.equal(state.notes.length, 1);
});

test("character pictures are written under the app home outside mods/ and drawn", async () => {
  seed([MAIN]);
  const { form } = await open({ form: "create" });
  assert.ok(form.pets.size >= 22);
  const file = [...form.pets][0];
  assert.match(readFileSync(join(root, "app/am-sidebar-pets", file), "utf8"), /^<svg /);
});

test("the mockup's six icons are SVG files under the app home, drawn tinted with svg()", async () => {
  seed([MAIN]);
  const { form, draw } = await open({ form: "create" });
  for (const name of ["folder", "clock", "shuffle", "chevron", "close", "copy"]) {
    assert.match(readFileSync(join(root, "app/am-sidebar-pets", `ui-${name}.svg`), "utf8"), /^<svg [^>]*stroke="currentColor"/, name);
  }
  const drawn = all(draw()).filter((n) => n.kind === "svg" && /^am-sidebar-pets\/ui-/.test(n.arg));
  assert.deepEqual([...new Set(drawn.map((n) => n.arg))].sort(),
    ["chevron", "clock", "close", "copy", "folder", "shuffle"].map((n) => `am-sidebar-pets/ui-${n}.svg`));
  assert.ok(drawn.every((n) => /^#[0-9a-f]{6}$/i.test(n.props.color)), "each one tinted");
  assert.ok(form.pets.has("ui-close.svg"));
});

test("Rank chips (A16): shown for a member, picked into the save and the copied line; None clears", async () => {
  seed([MAIN]);
  const { form, cx, draw, click } = await open({ form: "create" });
  form.inputs.name.type("qa", cx);
  draw();
  assert.ok(nodes.has("bot-rank-none") && nodes.has("bot-rank-tester") && nodes.has("bot-rank-fixer") && !nodes.has("bot-rank-main"));
  await click("bot-rank-tester");
  draw();
  await click("bot-copy");
  assert.match(cx.clip, / --rank=tester /);
  await click("bot-rank-none");
  draw();
  await click("bot-copy");
  assert.doesNotMatch(cx.clip, /--rank/);
  await click("bot-rank-fixer");
  draw();
  await click("bot-copy");
  assert.match(cx.clip, / --rank=fixer /);
  await click("bot-rank-pm");
  draw();
  await click("bot-save");
  assert.equal(stored().bots.find((b) => b.name === "qa").rank, "pm");
});

test("Rank chips are not offered for the main bot", async () => {
  seed([]);
  const { draw } = await open({ form: "create" });
  draw();
  assert.ok(!nodes.has("bot-rank-none"));
});

test("Bot settings (pick) with no bot: one New bot line that opens the Create form and closes the list", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([]);
  const { draw, click } = await open({ form: "pick" });
  draw();
  assert.ok(nodes.has("pick-new"));
  assert.equal(textOf(nodes.get("bot-form-body")), "New bot");
  state.opened = [];
  await click("pick-new");
  assert.deepEqual(state.opened, [{ mod: "am-sidebar", kind: "dialog", modal: true, ...FORM_SIZE, props: { form: "create" } }]);
  assert.deepEqual(state.closed, ["o9"]);
});

test("Bot settings (pick) with bots: the bots with Edit / Start, no New bot line", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([MAIN, OMP]);
  const { draw } = await open({ form: "pick" });
  draw();
  assert.ok(!nodes.has("pick-new"));
  assert.ok(nodes.has(`pick-${MAIN.id}`) && nodes.has(`edit-${OMP.id}`) && nodes.has(`start-${OMP.id}`));
});

test("Start in Bot settings with no space on the project: one space opened, waited for on the form's timer, the bot sent there", async () => {
  // Start runs the CLI with the place the sidebar picked; this scratch app home has no CLI, so
  // only that call is checked (the CLI's own start is tested in cli.test.mjs).
  state.calls = [];
  // Herdr shows the space a little after space.new.
  state.runFault = (name) => {
    if (name === "space.new") setTimeout(() => { state.spaces = [{ id: "s5", folder: project, machine: null, active: true, tabs: [{ id: "t5", active: true }] }]; }, 30);
  };
  seed([MAIN]);
  // Its space closed: the project is found as a remembered one.
  state.shared.set("am.sidebar.projects", [{ key: project, machine: null }]);
  try {
    const { cx, draw, click } = await open({ form: "pick" });
    cx.timer = { after(ms, fn) { setTimeout(() => fn(cx), ms); } };
    draw();
    await click(`start-${MAIN.id}`);
  } finally { state.runFault = null; state.shared.delete("am.sidebar.projects"); }
  assert.equal(state.runs.filter(([name]) => name === "space.new").length, 1);
  const cli = state.calls.find((c) => c.kind === "exec" && c.args.includes("start")).args;
  assert.deepEqual(cli.slice(cli.indexOf("--space"), cli.indexOf("--space") + 4), ["--space", "s5", "--tab", "t5"]);
});

test("Attach with no bot keeps its message (the New bot line is the pick list's alone)", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([]);
  const { draw } = await open({ form: "attach", terminal: "t1" });
  draw();
  assert.ok(!nodes.has("pick-new"));
  assert.match(textOf(nodes.get("bot-form-body")), /No bots on this computer yet/);
});

// ---- #239: the list popups keep their content's height ----

// A popup is as tall as its content, its height only the most (Herdr's openOverlay). Live,
// overflow_y_scrollbar's wrapper gave the body no height there, so the menu, pick and attach
// popups drew only their title and Cancel; overflow_y_scroll keeps the items' height. The stub
// lays nothing out, so this checks how the body is built, the part a stub can see.
const builds = (node) => node.calls.map(([name]) => name);
for (const [mode, extra] of [["menu", { bot: OMP.id, name: OMP.name, terminal: "t3" }], ["pick", {}], ["attach", { terminal: "t1" }]]) {
  test(`${mode} popup: the body scrolls without the scrollbar wrapper, so its items have a height (#239)`, async () => {
    state.spaces = [{ id: "s1", folder: project, machine: null }];
    seed([MAIN, OMP]);
    const { draw } = await open({ form: mode, planned: false, machine: null, live: null, ...extra });
    draw();
    const body = builds(nodes.get("bot-form-body"));
    assert.ok(body.includes("overflow_y_scroll"), "the body scrolls past the popup's height");
    assert.ok(!body.includes("overflow_y_scrollbar"), "no scrollbar wrapper: it collapses to 0 in a popup");
    assert.ok(body.includes("min_h"), "it can still shrink to the popup's height");
    assert.ok(textOf(nodes.get("bot-form-body")).length > 0, "items are drawn in the body");
  });
}

test("pick popup: a long bot name truncates, so Edit / Start / Restart stay in the popup (#239)", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([MAIN]);
  const { draw } = await open({ form: "pick" });
  draw();
  const name = nodes.get(`pick-${MAIN.id}`).kids[0].__node;
  assert.equal(textOf(name), MAIN.name);
  assert.ok(builds(name).includes("truncate") && builds(name).includes("min_w"), "the name can shrink");
  assert.ok(!builds(name).includes("flex_none"), "a fixed-width name pushes the buttons out");
});

// The owner's case: a folder outside git (child) under a folder holding another project's
// bots.json (repos). `project` is the parent here, seeded with its main bot.
function underParent() {
  const child = join(project, "child");
  mkdirSync(child);
  return child;
}
const kindWhy = (kind) => nodes.get(`bot-kind-${kind}`)?.props.tooltip ?? null;

test("a folder picked outside git is its own project, even under another project's folder: Main bot, saved there", async () => {
  seed([MAIN]);
  const parentBefore = readFileSync(join(project, ".herdr/bots.json"), "utf8");
  const child = underParent();
  state.pickFolder = child;
  const { form, cx, draw, click } = await open({ form: "create", project: undefined });
  draw();
  assert.match(textOf(nodes.get("bot-project")), /Pick a project…/);
  await click("bot-project");
  assert.equal(form.key, child);
  assert.equal(form.s.kind, "main", "a new project's first bot is its main bot");
  draw();
  assert.equal(kindWhy("main"), null, "Main bot is offered");
  assert.equal(kindWhy("member"), "A project's first bot is its main bot.");
  form.inputs.name.type("Child", cx);
  draw();
  await click("bot-save");
  assert.equal(form.error, null);
  const saved = JSON.parse(readFileSync(join(child, ".herdr/bots.json"), "utf8"));
  assert.deepEqual(saved.bots.map((b) => [b.name, b.kind]), [["Child", "main"]]);
  assert.equal(readFileSync(join(project, ".herdr/bots.json"), "utf8"), parentBefore, "the parent project is untouched");
});

test("a focused space whose folder is gone is not keyed: the form asks for the project", async () => {
  seed([MAIN]);
  state.spaces = [{ id: "s1", name: "gone", folder: join(project, "gone") }];
  state.focused = { space: "s1" };
  const { form, draw } = await open({ form: "create", project: undefined });
  draw();
  assert.ok(!form.key);
  assert.match(textOf(nodes.get("bot-project")), /Pick a project…/);
  assert.ok(!nodes.has("bot-project-parent") && !nodes.has("bot-project-own"));
});

test("a focused folder under another project's folder is offered both ways, never assumed", async () => {
  seed([MAIN]);
  const child = underParent();
  state.spaces = [{ id: "s1", name: "child", folder: child }];
  state.focused = { space: "s1" };
  const { form, draw, click } = await open({ form: "create", project: undefined });
  draw();
  assert.ok(!form.key, "the parent's project is not assumed");
  assert.equal(textOf(nodes.get("bot-project-parent")), "proj (parent project)");
  assert.equal(textOf(nodes.get("bot-project-own")), "Make child its own project");
  await click("bot-project-own");
  assert.equal(form.key, child);
  assert.equal(form.s.kind, "main");
  draw();
  assert.ok(!nodes.has("bot-project-parent"), "the choice is gone once made");
  // Picking the parent instead: a member of its team, as before.
  const again = await open({ form: "create", project: undefined });
  again.draw();
  await again.click("bot-project-parent");
  assert.equal(again.form.key, project);
  assert.equal(again.form.s.kind, "member");
});

test("a focused folder with its own bots.json, or in a git worktree, is keyed with no question", async (t) => {
  seed([MAIN]);
  const child = underParent();
  mkdirSync(join(child, ".herdr"));
  writeFileSync(join(child, ".herdr/bots.json"), `${JSON.stringify({ version: 1, categories: [], bots: [] })}\n`);
  state.spaces = [{ id: "s1", name: "child", folder: child }];
  state.focused = { space: "s1" };
  const own = await open({ form: "create", project: undefined });
  own.draw();
  assert.equal(own.form.key, child);
  assert.ok(!nodes.has("bot-project-parent"));
  // A worktree of a repository keys to its main checkout (Decision 15), unchanged.
  const repo = join(root, "repo");
  const wt = join(root, "repo-wt");
  const g = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo });
  mkdirSync(repo);
  g("init", "-q");
  g("commit", "-q", "--allow-empty", "-m", "init");
  g("worktree", "add", "-q", "-b", "wt", wt);
  state.spaces = [{ id: "s2", name: "wt", folder: wt }];
  state.focused = { space: "s2" };
  const tree = await open({ form: "create", project: undefined });
  tree.draw();
  assert.equal(tree.form.key, repo);
  assert.ok(!nodes.has("bot-project-own"));
});

// ---- #85: the pick and attach lists draw the sidebar's known bots at once ----

test("Bot settings (pick) draws the sidebar's known bots before discovery answers, then the fresh list", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([MAIN, OMP]);
  const cx = makeCx();
  const known = [{ key: project, machine: null, file: { version: 1, categories: [], bots: [MAIN] } },
    { key: "/x/elsewhere", machine: "box", file: { version: 1, categories: [], bots: [KIMI] } }];
  const form = new BotForm({ overlay: "o9", form: "pick", known }, cx);
  index(form.render(cx)); // before cx.settle(): nothing has answered yet
  assert.doesNotMatch(textOf(nodes.get("bot-form-body")), /Finding bots/);
  assert.ok(nodes.has(`pick-${MAIN.id}`), "the known bot shows at once");
  assert.ok(nodes.has(`pick-${KIMI.id}`), "a linked machine's project shows too");
  assert.match(textOf(nodes.get("bot-form-body")), /ELSEWHERE · box/);
  assert.ok(nodes.has(`edit-${KIMI.id}`) && nodes.has(`start-${KIMI.id}`) && nodes.has(`restart-${KIMI.id}`), "Edit, Start and Restart there");
  assert.ok(nodes.has(`start-${MAIN.id}`));
  await cx.settle();
  index(form.render(cx));
  assert.ok(nodes.has(`pick-${MAIN.id}`) && nodes.has(`pick-${OMP.id}`), "the refreshed list replaces it");
});

test("Attach draws the sidebar's known bots at once too; with nothing known it still says it is looking", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([MAIN]);
  const cx = makeCx();
  const form = new BotForm({ overlay: "o9", form: "attach", terminal: "t1", known: [{ key: project, machine: null, file: { bots: [MAIN] } }] }, cx);
  index(form.render(cx));
  assert.ok(nodes.has(`pick-${MAIN.id}`));
  await cx.settle();
  const bare = new BotForm({ overlay: "o9", form: "attach", terminal: "t1" }, makeCx());
  assert.match(textOf(index(bare.render(cx))), /Finding bots/, "no known list (an older caller): as before");
});

// ---- #85: a bot row's menu ----

// The CLI as runCli runs it (sh <app home>/mods/am-sidebar/bin/run.sh <cli> <args> --json): a
// stand-in that logs its arguments and prints `answer` (exits `code`).
function fakeCli(answer, code = 0) {
  const bin = join(state.appHome, "mods/am-sidebar/bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "answer.json"), JSON.stringify(answer));
  writeFileSync(join(bin, "run.sh"), `shift\nprintf '%s\\n' "$*" >> "${bin}/args.log"\ncat "${bin}/answer.json"\nexit ${code}\n`);
  return () => readFileSync(join(bin, "args.log"), "utf8").trim().split("\n");
}
const menu = (extra = {}) => open({ form: "menu", bot: OMP.id, name: OMP.name, planned: false, machine: null, terminal: null, live: null, ...extra });

test("menu, bot without a pane: Configure, Prompt, Start, Restart, Restart on…, Inspect; no Focus or Detach", async () => {
  seed([MAIN, OMP]);
  const { draw } = await menu({ terminal: "t3" });
  draw();
  for (const id of ["menu-configure", "menu-prompt", "menu-start", "menu-restart", "menu-restart-on", "menu-attach", "menu-inspect"]) assert.ok(nodes.has(id), id);
  for (const id of ["menu-focus", "menu-detach", "menu-restart-fresh"]) assert.ok(!nodes.has(id), id);
});

test("menu, running bot: Focus (its pane), Restart with a new conversation, Detach; Attach only to another pane", async () => {
  seed([MAIN, OMP]);
  const { draw } = await menu({ live: "t5", terminal: "t5" });
  draw();
  for (const id of ["menu-focus", "menu-restart", "menu-restart-fresh", "menu-restart-on", "menu-detach"]) assert.ok(nodes.has(id), id);
  assert.ok(!nodes.has("menu-start") && !nodes.has("menu-attach"));
  assert.match(textOf(nodes.get("menu-focus")), /t5/);
});

test("menu, planned bot: Configure, Prompt and Inspect, no Run item", async () => {
  seed([MAIN, OMP]);
  const { draw } = await menu({ planned: true, terminal: "t3" });
  const text = textOf(draw());
  assert.ok(nodes.has("menu-configure") && nodes.has("menu-prompt") && nodes.has("menu-inspect"));
  for (const id of ["menu-start", "menu-focus", "menu-restart", "menu-restart-on", "menu-attach", "menu-detach"]) assert.ok(!nodes.has(id), id);
  assert.doesNotMatch(text, /RUN/);
});

test("menu Configure opens the Edit form for the bot and closes the menu", async () => {
  seed([MAIN, OMP]);
  const { draw, click } = await menu();
  draw();
  state.opened = [];
  await click("menu-configure");
  assert.deepEqual(state.opened, [{ mod: "am-sidebar", kind: "dialog", modal: true, ...FORM_SIZE, props: { form: "edit", bot: OMP.id, project, machine: null } }]);
  assert.deepEqual(state.closed, ["o9"]);
});

test("menu Focus: the bot's pane by agent.focus when Herdr shows it", async () => {
  seed([MAIN, OMP]);
  state.panes = [{ terminal: "t5" }];
  try {
    const { draw, click } = await menu({ live: "t5" });
    draw();
    await click("menu-focus");
  } finally { state.panes = []; }
  assert.deepEqual(state.runs.at(-1), ["agent.focus", { terminal: "t5" }]);
  assert.deepEqual(state.closed, ["o9"]);
});

test("menu Prompt: the instructions edited in place and saved as the Edit form saves, every other field kept", async () => {
  const before = { ...OMP, instructions: "old words", worker: { agent: "codex" } };
  seed([MAIN, before]);
  const { form, cx, draw, click } = await menu();
  draw();
  await click("menu-prompt");
  draw();
  assert.ok(nodes.has("menu-prompt-text"));
  assert.equal(form.prompt.value(), "old words");
  form.prompt.type("new words\nline two", cx);
  draw();
  await click("menu-prompt-save");
  const saved = stored().bots.find((b) => b.id === OMP.id);
  assert.equal(saved.instructions, "new words\nline two");
  assert.deepEqual({ ...saved, instructions: "old words" }, before, "nothing else changed");
  assert.ok(state.runs.some(([name]) => name === "am-sidebar.refresh"));
  assert.deepEqual(state.closed, ["o9"]);
});

test("menu Prompt: over the limit is not saved, and an edit since it opened is refused as stale", async () => {
  seed([MAIN, OMP]);
  const { form, cx, draw, click } = await menu();
  draw();
  await click("menu-prompt");
  form.prompt.type("x".repeat(100_000), cx);
  draw();
  await click("menu-prompt-save");
  assert.match(form.error, /^Not saved: Instructions are/);
  assert.equal(stored().bots.find((b) => b.id === OMP.id).instructions, "");
  form.prompt.type("fine", cx);
  seed([MAIN, { ...OMP, role: "changed elsewhere" }]);
  draw();
  await click("menu-prompt-save");
  assert.match(form.error, /changed since this menu opened/);
  assert.equal(stored().bots.find((b) => b.id === OMP.id).role, "changed elsewhere", "the other edit is kept");
  assert.deepEqual(state.closed, []);
});

test("menu Detach: the CLI's detach for the bot and its project; a refusal is shown", async () => {
  seed([MAIN, OMP]);
  const args = fakeCli({ id: OMP.id, detached: ["t5"] });
  const { draw, click } = await menu({ live: "t5" });
  draw();
  await click("menu-detach");
  assert.deepEqual(args(), [`detach ${OMP.id} --project ${project} --json`]);
  assert.deepEqual(state.closed, ["o9"]);
  state.closed = [];
  fakeCli({}, 1);
  const again = await menu({ live: "t5" });
  again.draw();
  await again.click("menu-detach");
  assert.match(again.form.error, /detach failed \(exit 1\)/);
  assert.deepEqual(state.closed, []);
});

test("menu Inspect: what happened, by automagik-herdr history: timeline, transcript (a click copies it), workers, helpers", async () => {
  seed([MAIN, OMP]);
  const at = (m) => `2026-11-03T10:0${m}:00.000Z`;
  const args = fakeCli({ id: OMP.id, bot: OMP.id,
    attach: [{ v: 1, event: "attach", bot: OMP.id, terminal: "t5", by: "start", at: at(1) }],
    starts: [{ event: "start", kind: "seat", terminal: "t5", botId: OMP.id, agent: "omp", at: at(1) }],
    workers: [{ event: "start", kind: "worker", terminal: "t8", botId: OMP.id, branch: "fix-x", role: "dev", agent: "codex", at: at(3) }],
    sessions: [], transcript: "/x/sessions/one.jsonl" });
  const { cx, draw, click } = await menu({ live: "t5", helpers: [{ terminal: "t8", name: "fix-x" }] });
  draw();
  await click("menu-inspect");
  const text = textOf(draw());
  assert.deepEqual(args(), [`history ${OMP.id} --project ${project} --json`]);
  assert.match(text, /2026-11-03 10:01 attached to t5 · by start/);
  assert.match(text, /started in t5 · omp/);
  assert.match(text, /fix-x · dev · codex · t8/);
  assert.ok(nodes.has("menu-helper-t8"));
  await click("menu-transcript");
  assert.equal(cx.clip, "/x/sessions/one.jsonl");
  assert.doesNotMatch(text, /spend|cost/i, "no spend line: usagemeter has no per-bot figure");
});

test("menu Inspect: a CLI failure is shown in place, not a blank section", async () => {
  seed([MAIN, OMP]);
  const { form, draw, click } = await menu();
  draw();
  await click("menu-inspect");
  draw();
  assert.ok(form.history.error);
  assert.ok(nodes.has("menu-history"));
});

test("Attach with an empty known list says it is looking until discovery answers, then that there are none", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([]);
  const cx = makeCx();
  const form = new BotForm({ overlay: "o9", form: "attach", terminal: "t1", known: [] }, cx);
  assert.match(textOf(index(form.render(cx))), /Finding bots/);
  await cx.settle();
  assert.match(textOf(index(form.render(cx))), /No bots on this computer yet/);
});

// ---- #88 review: pick while discovering, a failed prompt read, Focus as the row's click, busy labels ----

test("Bot settings (pick) with an empty known list says it is looking, never New bot alone, until discovery answers", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: null }];
  seed([MAIN]);
  const cx = makeCx();
  const form = new BotForm({ overlay: "o9", form: "pick", known: [] }, cx);
  assert.match(textOf(index(form.render(cx))), /Finding bots/);
  assert.ok(!nodes.has("pick-new"), "no New bot while the bots may still be found: a duplicate risk");
  await cx.settle();
  index(form.render(cx));
  assert.ok(nodes.has(`pick-${MAIN.id}`) && !nodes.has("pick-new"));
  seed([]);
  const empty = new BotForm({ overlay: "o9", form: "pick", known: [] }, cx);
  await cx.settle();
  index(empty.render(cx));
  assert.ok(nodes.has("pick-new"), "discovery answered with no bot: New bot");
});

test("menu Prompt: a failed read is shown in the section, not Reading… forever", async () => {
  seed([MAIN]); // the menu's bot isn't in the file (removed since the row was drawn)
  const { form, draw, click } = await menu();
  draw();
  await click("menu-prompt");
  const text = textOf(draw());
  assert.ok(nodes.has("menu-prompt-error"));
  assert.match(text, /Can't read the prompt: .*has no bot b-ompaaaaaaa/);
  assert.doesNotMatch(text, /Reading…/);
  assert.equal(form.promptBase, null);
});

test("menu Focus does what the row's click does: a kept pane with no pane opens as a tab after its starter's", async () => {
  seed([MAIN, OMP]);
  state.panes = [{ terminal: "t1", tab: "tab1" }];
  state.spaces = [{ id: "s1", folder: project, machine: null, tabs: [{ id: "tab1", index: 1 }] }];
  // Herdr gives the kept terminal its pane in a new tab.
  state.runFault = (name) => { if (name === "terminal.keep") state.panes.push({ terminal: "t5", tab: "tab2" }); };
  try {
    const { draw, click } = await menu({ live: "t5", worker: { terminal: "t5", botTerminal: "t1", name: OMP.name } });
    draw();
    await click("menu-focus");
  } finally { state.runFault = null; state.panes = []; }
  const names = state.runs.map(([name]) => name);
  assert.deepEqual(names.slice(0, 3), ["space.select", "tab.select", "terminal.keep"]);
  assert.deepEqual(state.runs[2], ["terminal.keep", { terminal: "t5", place: "tab" }]);
  assert.ok(!names.includes("terminal.peek"), "not a peek");
  assert.deepEqual(state.closed, ["o9"]);
});

test("menu Focus with no pane and no starter's tab peeks, as the row's click does", async () => {
  seed([MAIN, OMP]);
  const { draw, click } = await menu({ live: "t5", worker: { terminal: "t5", botTerminal: null, name: OMP.name } });
  draw();
  await click("menu-focus");
  assert.deepEqual(state.runs.at(-1), ["terminal.peek", { terminal: "t5" }]);
  assert.deepEqual(state.closed, ["o9"]);
});

test("menu busy labels: only the running action's item changes", async () => {
  seed([MAIN, OMP]);
  fakeCli({ id: OMP.id, detached: ["t5"] });
  const { form, cx, draw } = await menu({ live: "t5", terminal: "t9" });
  form.detach(cx); // its spawn hasn't run yet: Detach is in progress
  draw();
  assert.equal(textOf(nodes.get("menu-detach")), "Detaching…");
  for (const [id, label] of [["menu-restart", "Restart"], ["menu-restart-fresh", "Restart with a new conversation"], ["menu-attach", "Attach to the focused pane (t9)"]]) {
    assert.equal(textOf(nodes.get(id)), label, id);
  }
  await cx.settle();
  const r = await menu({ terminal: "t9" });
  r.form.restart({ key: project }, { id: OMP.id }, r.cx, { fresh: true });
  r.draw();
  assert.equal(textOf(nodes.get("menu-start")), "Start");
  assert.equal(textOf(nodes.get("menu-restart")), "Restart", "a fresh restart leaves plain Restart's label");
  await r.cx.settle();
});

// ---- automagik#206: a project on a linked machine ("vm": its files are scratch paths here) ----

test("menu on a linked machine: Configure, Prompt and Run there; no What happened yet; Configure opens the form there", async () => {
  seed([MAIN, OMP]);
  const { draw, click } = await menu({ machine: "vm" });
  draw();
  for (const id of ["menu-configure", "menu-prompt", "menu-start", "menu-restart"]) assert.ok(nodes.has(id), id);
  for (const id of ["menu-attach", "menu-detach", "menu-focus", "menu-inspect"]) assert.ok(!nodes.has(id), id);
  assert.match(textOf(nodes.get("menu-remote-note")), /On vm\. What happened isn't shown/);
  assert.doesNotMatch(textOf(nodes.get("bot-form-body")), /work from that computer/);
  state.opened = [];
  await click("menu-configure");
  assert.deepEqual(state.opened[0].props, { form: "edit", bot: OMP.id, project, machine: "vm" });
});

test("menu on a linked machine, running: Focus and Detach its pane there; Attach only to a pane of that machine; actions pass --machine", async () => {
  seed([MAIN, OMP]);
  const there = await menu({ machine: "vm", live: "vm/t8", terminal: "vm/t3" });
  there.draw();
  for (const id of ["menu-focus", "menu-detach", "menu-attach", "menu-restart"]) assert.ok(nodes.has(id), id);
  assert.match(textOf(nodes.get("menu-attach")), /vm\/t3/);
  state.calls = [];
  await there.click("menu-detach");
  const cli = state.calls.find((c) => c.kind === "exec" && c.args.includes("detach"));
  assert.ok(cli && cli.args.includes("--machine") && cli.args[cli.args.indexOf("--machine") + 1] === "vm");
  // A pane of this computer (or another machine) focused: no Attach for a vm bot.
  const here = await menu({ machine: "vm", live: "vm/t8", terminal: "t3" });
  here.draw();
  assert.ok(!nodes.has("menu-attach"));
});

test("menu on a linked machine that isn't answering: its last-seen note, nothing to press", async () => {
  seed([MAIN, OMP]);
  const { draw } = await menu({ machine: "vm", stale: true });
  draw();
  assert.ok(!nodes.has("menu-configure") && !nodes.has("menu-prompt"));
  assert.match(textOf(nodes.get("menu-remote-note")), /vm isn't answering/);
});

test("menu Prompt on a linked machine: read there, saved there by hc file edit, a stale snapshot refused", async () => {
  seed([MAIN, { ...OMP, instructions: "old words" }]);
  state.hcAnswer = hcFileOps(state);
  const { form, cx, draw, click } = await menu({ machine: "vm" });
  draw();
  await click("menu-prompt");
  assert.ok(state.calls.some((c) => c.kind === "read" && c.on === "vm" && c.path === join(project, ".herdr/bots.json")));
  form.prompt.type("new words", cx);
  draw();
  await click("menu-prompt-save");
  assert.equal(form.error, null);
  assert.equal(stored().bots.find((b) => b.id === OMP.id).instructions, "new words");
  assert.ok(state.hcCalls.some((a) => a[0] === "file" && a[1] === "edit" && a.includes("vm")));
  assert.equal(state.calls.filter((c) => c.kind === "write").length, 0, "never Herdr's local write");
  // An edit there since it opened: refused as stale, named with its machine.
  const again = await menu({ machine: "vm" });
  again.draw();
  await again.click("menu-prompt");
  again.form.prompt.type("mine", again.cx);
  seed([MAIN, { ...OMP, instructions: "new words", role: "theirs" }]);
  again.draw();
  await again.click("menu-prompt-save");
  assert.match(again.form.error, /bots\.json on vm changed since this menu opened/);
  assert.equal(stored().bots.find((b) => b.id === OMP.id).role, "theirs");
});

test("Edit form on a linked machine: its agents and file there, the CLI line names --machine, saved there", async () => {
  seed([MAIN, OMP]);
  state.hcAnswer = hcFileOps(state);
  const { form, cx, draw, click } = await open({ form: "edit", bot: OMP.id, machine: "vm" });
  draw();
  assert.equal(form.machine, "vm");
  assert.match(textOf(nodes.get("bot-machine")), /on vm/);
  assert.match(textOf(nodes.get("bot-form")), /--machine=('vm'|vm) --project=/);
  form.inputs.role.type("trades", cx);
  draw();
  await click("bot-save");
  assert.equal(form.error, null);
  assert.equal(stored().bots.find((b) => b.id === OMP.id).role, "trades");
  assert.equal(state.calls.filter((c) => c.kind === "write").length, 0);
  // The machine away: the save fails with its reason, not as stale.
  state.offline.add("vm");
  const away = await open({ form: "edit", bot: OMP.id, machine: "vm" });
  away.draw();
  away.form.inputs.role.type("x", away.cx);
  away.draw();
  await away.click("bot-save");
  assert.match(away.form.error ?? "", /^Not saved: /);
  assert.doesNotMatch(away.form.error ?? "", /changed since/);
});

test("Create from a focused space on a linked machine: that machine's project, created there", async () => {
  state.spaces = [{ id: "s1", folder: project, machine: "vm", name: "hedge" }];
  state.focused = { space: "s1" };
  const { form, cx, draw, click } = await open({ form: "create", project: undefined });
  draw();
  assert.equal(form.key, project);
  assert.equal(form.machine, "vm");
  assert.ok(nodes.has("bot-save") && nodes.has("bot-save-start"));
  form.inputs.name.type("Hedge", cx);
  draw();
  await click("bot-save");
  assert.equal(form.error, null);
  assert.equal(stored().bots[0].name, "Hedge");
  assert.ok(state.calls.some((c) => c.kind === "exec" && c.command === "sh" && c.on === "vm"), "made there");
  assert.equal(state.calls.filter((c) => c.kind === "write").length, 0);
  assert.deepEqual(state.shared.get("am.sidebar.projects")?.at(-1), { key: project, machine: "vm" });
});
