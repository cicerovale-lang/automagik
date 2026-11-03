// Start and Attach on this computer (DESIGN Approach, Decisions 1-3 and 5, A1), through the
// automagik-herdr CLI: the attach ledger it writes is the only answer to which pane plays a
// bot, so the sidebar never sets a `bot=` label itself. The CLI runs through bin/run.sh (it
// finds node 22.7 or later, or bun, where Herdr's PATH has none) with this app home. Apache-2.0.

import { spaces, focused, run, readTextFile, writeTextFile, exec, appHome, notify, home } from "herdr";
import { keyOf, rememberProject } from "./bots.js";
import { installHook, runnerPath } from "./briefingText.mjs";
import { configPaths } from "./models.js";
import { PACK_NAME } from "./release.js";

const local = (address) => typeof address === "string" && !address.includes("/");
const cliPath = (dir) => `${dir.replace(/\/+$/, "")}/mods/${PACK_NAME}/bin/automagik-herdr.mjs`;

/**
 * Runs `automagik-herdr <args> --json` with this app home: { code, out (its JSON, or null),
 * err (stderr, the `automagik-herdr: ` prefixes dropped) }. Never rejects.
 */
export async function runCli(args) {
  const dir = appHome();
  let r;
  try { r = await exec("env", [`HERDR_APP_HOME=${dir}`, "sh", runnerPath(dir), cliPath(dir), ...args, "--json"]); } catch (e) {
    return { code: 127, out: null, err: String(e?.message ?? e) };
  }
  let out = null;
  try { out = JSON.parse(r.stdout); } catch { out = null; }
  return { code: r.code, out, err: String(r.stderr ?? "").replace(/^automagik-herdr: /gm, "").trim() };
}

const refusedBy = (r, what) => ({ refused: r.err || `automagik-herdr ${what} failed (exit ${r.code}).` });
const warn = (bodies) => { for (const body of bodies ?? []) notify({ title: "Bots", body, level: "warning", timeout: 15000 }); };

/**
 * A bot's pane by the attach ledger (`automagik-herdr whois --bot`): { terminal, duplicate:
 * false }, or null when it plays nowhere (or the CLI can't answer).
 */
export async function liveTerminalOf(botId) {
  const r = await runCli(["whois", "--bot", botId]);
  const terminal = r.code === 0 ? r.out?.terminal ?? null : null;
  return terminal ? { terminal, duplicate: false } : null;
}

/** The bot a terminal plays by the attach ledger (`automagik-herdr whois <t>`), or null. */
export async function botOfTerminal(terminal) {
  if (!local(terminal)) return null;
  const r = await runCli(["whois", terminal]);
  return r.code === 0 ? r.out?.bot ?? null : null;
}

/**
 * The per-turn briefing for a Claude bot (DESIGN Approach "Group 3", Decision 9): merges the
 * hook entry, if absent, into `<sessionFolder>/.claude/settings.local.json` (never the shared
 * settings.json) and keeps that file out of git through the clone's exclude file. Writes
 * nothing, and tells the owner the README fix, when the pack's briefing.mjs isn't at the path
 * computed from appHome(). `claude`: whether the session is Claude Code (other agents get
 * nothing). Never throws: a failure is a notification, never a refused Start or Attach.
 * Resolves with { written } (true when the hook entry was added or updated).
 */
export async function afterBind(bot, sessionFolder, claude = bot?.agent === "claude") {
  if (!claude || !sessionFolder) return { written: false };
  const folder = sessionFolder.length > 1 ? sessionFolder.replace(/\/+$/, "") : sessionFolder;
  const io = {
    git: async (args, cwd) => { try { return await exec("git", args, { cwd }); } catch { return null; } },
    read: (path) => readTextFile(path),
    write: (path, text, before) => writeTextFile(path, text, before),
    mkdir: async (dir) => {
      const r = await exec("mkdir", ["-p", dir]);
      if (r.code !== 0) throw new Error(`couldn't make ${dir}: ${r.stderr.trim()}`);
    },
  };
  // The same flow as the CLI's (briefingText.mjs installHook); warnings become notifications.
  const { written, warnings } = await installHook(bot.name, folder, appHome(), io);
  for (const body of warnings) notify({ title: "Bots", body, level: "warning", timeout: 15000 });
  return { written };
}

// The agents' own config texts (models.js configPaths), for the model pin list here and
// the default model the sidebar's rows show (main.js).
export async function modelTexts() {
  const out = {};
  for (const [name, path] of Object.entries(configPaths(home()))) {
    try { out[name] = await readTextFile(path); } catch { out[name] = null; }
  }
  return out;
}

/** A sleep from a mod context's timer (mods have no setTimeout), for startBot; null without one. */
export const sleepOf = (cx) => (cx?.timer ? (ms) => new Promise((done) => cx.timer.after(ms, () => done())) : null);

const localSpaces = () => spaces().filter((s) => !s.machine);
// The first of `list` whose folder keys to the project.
async function keyedSpace(list, projectKey) {
  for (const s of list) {
    try { if (s.folder && (await keyOf(s.folder)) === projectKey) return s; } catch {}
  }
  return null;
}

// Spaces being opened now, one per project: a second Start in that project waits for it.
const opening = new Map(); // project key -> Promise<space | null>

// A new space on the project, named after its folder: space.new, then (run() answers
// nothing) looked for in spaces() every stepMs for up to waitMs. Null if it never shows.
async function openSpace(projectKey, sleep, { waitMs = 5000, stepMs = 100 } = {}) {
  const before = new Set(localSpaces().map((s) => s.id));
  try { run("space.new", { name: projectKey.replace(/\/+$/, "").split("/").pop(), folder: projectKey, machine: "" }); } catch { return null; }
  for (let waited = 0; ; waited += stepMs) {
    const space = await keyedSpace(localSpaces().filter((s) => !before.has(s.id)), projectKey);
    if (space || waited >= waitMs) return space;
    await sleep(stepMs);
  }
}

// Where a started bot opens: the first space of this computer whose folder keys to the
// project, else a space opened on it (only with a `sleep` to wait for it by, so a space
// is never left behind empty), else the shown space; in that space's active tab.
async function placeFor(projectKey, { sleep = null, ...wait } = {}) {
  let space = await keyedSpace(localSpaces(), projectKey);
  if (!space && sleep) {
    if (!opening.has(projectKey)) {
      opening.set(projectKey, openSpace(projectKey, sleep, wait).finally(() => opening.delete(projectKey)));
    }
    space = await opening.get(projectKey);
  }
  const mine = localSpaces();
  space ??= mine.find((s) => s.id === focused()?.space) ?? mine.find((s) => s.active) ?? null;
  const tab = space?.tabs?.find((t) => t.active) ?? null;
  return { space: space?.id ?? null, tab: tab?.id ?? null };
}

// Bots being started now: a second click waits for nothing and is refused.
const starting = new Set();

/**
 * Starts a bot as a new pane on this computer (`automagik-herdr start`, which writes its
 * attach row), or focuses the pane the ledger already ties it to. The CLI's refusals (a
 * planned bot, no agent, an unlisted model pin) come back as { refused }. `place.sleep`
 * (sleepOf(cx)) lets it open a space on the project when none shows it (placeFor).
 */
export async function startBot(projectKey, botId, place = {}, machine = null) {
  if (starting.has(botId)) return { refused: `${botId} is already starting.` };
  starting.add(botId);
  try { return await (machine ? startOn(projectKey, botId, machine) : startOnce(projectKey, botId, place)); } finally { starting.delete(botId); }
}

// Start on a linked machine (automagik#206): the CLI finds the window place there itself.
async function startOn(projectKey, botId, machine) {
  const r = await runCli(["start", botId, "--project", projectKey, "--machine", machine]);
  if (r.code !== 0) return refusedBy(r, "start");
  if (r.out?.running) {
    run("agent.focus", { terminal: `${machine}/${r.out.running}` });
    return { focused: `${machine}/${r.out.running}` };
  }
  warn(r.out?.warnings);
  rememberProject(projectKey, machine);
  return { terminal: r.out?.terminal ? `${machine}/${r.out.terminal}` : null };
}

async function startOnce(projectKey, botId, place) {
  const { space, tab } = await placeFor(projectKey, place);
  const where = space ? ["--space", space, ...(tab ? ["--tab", tab] : [])] : [];
  const r = await runCli(["start", botId, "--project", projectKey, ...where]);
  if (r.code !== 0) return refusedBy(r, "start");
  if (r.out?.running) {
    run("agent.focus", { terminal: r.out.running });
    return { focused: r.out.running };
  }
  warn(r.out?.warnings);
  rememberProject(projectKey);
  return { terminal: r.out?.terminal ?? null };
}

/**
 * Ties a running pane on this computer to a bot (`automagik-herdr attach`, which writes the
 * attach row and sets the labels). Never a silent move: a bot the ledger ties to another
 * pane is refused, naming it (the CLI's `attach --move` moves it).
 */
export async function attachBot(projectKey, botId, terminal, machine = null) {
  // A bot plays a pane on its project's machine only (this computer's, or that linked one's).
  const mine = machine ? typeof terminal === "string" && terminal.startsWith(`${machine}/`) : local(terminal);
  if (!mine) {
    return { refused: machine ? `${terminal} isn't on ${machine}, where this bot's project is; focus one of ${machine}'s panes.`
      : `Attach works on this computer's panes only; ${terminal} is on another machine.` };
  }
  const r = await runCli(["attach", botId, terminal, "--project", projectKey, ...(machine ? ["--machine", machine] : [])]);
  if (r.code !== 0) return refusedBy(r, "attach");
  warn(r.out?.warnings);
  rememberProject(projectKey, machine);
  return { ok: true };
}
