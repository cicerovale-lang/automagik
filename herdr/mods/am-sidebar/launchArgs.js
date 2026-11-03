// Start and Attach over plain data: the `hc run` arguments, the A1 parent rule, the live
// rule (DESIGN Decision 3), which terminal counts among duplicates, the labels of a pane and
// the attach refusal message. Pure: no `herdr`, so `node --test` runs it. Apache-2.0.

import { BOT_LABEL, effectiveCategory, effectiveLead, mainBotOf } from "./model.js";
import { ENV } from "./workers.js";

const SHELLS = new Set(["sh", "zsh", "bash", "fish", "dash", "ksh", "tcsh", "csh", "nu", "login"]);
const base = (p) => String(p ?? "").split("/").pop().replace(/^-/, "");

/** An hc terminal name for a bot: 1-32 of a-z 0-9 - _, unique among `taken`. */
export function hcName(name, botId, taken = new Set()) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "bot";
  if (!taken.has(slug)) return slug;
  const tail = `-${String(botId).slice(-4)}`;
  const named = `${slug.slice(0, 32 - tail.length)}${tail}`;
  return taken.has(named) ? null : named; // null: let hc pick, rather than fail on a taken name
}

/**
 * The hc parent of a started bot (DESIGN Decision 5, A1): the main bot has none; a member
 * reports to its effective lead's live terminal and outlives it, else has none.
 * `liveOf(botId)` is that bot's live terminal address, or null.
 */
export function parentArgs(file, botId, liveOf) {
  const bot = file.bots.find((b) => b.id === botId);
  if (!bot || bot.kind === "main") return ["--no-parent"];
  const { lead } = effectiveLead(file, botId);
  const live = lead ? liveOf(lead) : null;
  return live ? ["--parent", live, "--outlive-parent"] : ["--no-parent"];
}

/** Why a bot can't be started, or null. */
export function startRefusal(file, botId) {
  const bot = file.bots.find((b) => b.id === botId);
  if (!bot) return `No bot ${botId} in this project.`;
  if (bot.planned) return `${bot.name} is planned (wave ${bot.planned.wave}); edit it and clear "planned" to start it.`;
  if (!bot.agent) return `${bot.name} has no coding agent; edit it and pick one.`;
  if (bot.kind === "member" && !mainBotOf(file)) return `${bot.name}'s project has no main bot yet; create one first.`;
  return null;
}

/**
 * `hc run` arguments for Start: in the background, labelled with the bot and Herdr's
 * adoption labels, named, in the project folder, with the parent rule, never --no-notify.
 * With `path`, the agent runs as `/usr/bin/env PATH=<path> <argv>`, as a worker does
 * (workers.js workerArgs): the PATH agentPath.mjs interpreterPath gives it (#56).
 */
export function startArgs({ botId, name, cwd, space, tab, parent, argv, labels = {}, path = null }) {
  const args = ["run", "--bg", "--json"];
  if (name) args.push("--name", name);
  args.push("--cwd", cwd, "--label", `${BOT_LABEL}=${botId}`);
  // A16's labels (paneLabels), the bot label already above.
  for (const [k, v] of Object.entries(labels)) if (k !== BOT_LABEL && v) args.push("--label", `${k}=${v}`);
  if (space) args.push("--label", `herdr.space=${space}`);
  if (tab) args.push("--label", `herdr.tab=${tab}`);
  const env = path ? [ENV, `PATH=${path}`] : [];
  return [...args, ...parent, "--", ...env, ...argv];
}

// hc's keep wrapper (hc run --keep): the program, then a shell once it exits, as
// `sh -c '"$@"; exec "${SHELL:-sh}" -i' sh <program> <args>…`.
const KEEP_WRAPPER = '"$@"; exec "${SHELL:-sh}" -i';

/** A foreground argv with hc's keep wrapper taken off (the program it runs), else as it is. */
export function unwrapKeep(argv) {
  if (!Array.isArray(argv) || argv.length < 5 || !SHELLS.has(base(argv[0])) || argv[1] !== "-c" || argv[2] !== KEEP_WRAPPER) return argv;
  return argv.slice(4);
}

/**
 * True when `hc get`'s foreground is a program other than a shell (an agent, by Decision 3),
 * looking through hc's keep wrapper: once the program exits, the wrapper execs the shell, so
 * the foreground is a shell again.
 */
export function agentInForeground(get) {
  const argv0 = unwrapKeep(get?.foreground?.argv)?.[0];
  return Boolean(argv0) && !SHELLS.has(base(argv0));
}

/**
 * Whether a `terminals()` row is a live agent: `program.agent` when the row says, null
 * when it doesn't (then the caller asks `hc get`).
 */
export function rowIsAgent(row) {
  return typeof row?.program?.agent === "boolean" ? row.program.agent : null;
}

/** A Claude Code pane: by Herdr's program table, its own report, or its foreground. */
export function isClaude(row, get) {
  return row?.program?.key === "claude" || row?.report?.app === "claude-code" || get?.status?.app === "claude-code"
    || base(get?.foreground?.argv?.[0]) === "claude";
}

/** Of several `hc get` answers for one bot's label, the newest by created_ms counts. */
export function newest(gets) {
  return gets.reduce((a, b) => ((b?.created_ms ?? -1) > (a?.created_ms ?? -1) ? b : a), null);
}

// ---- A16: the labels a bot pane carries for the event envelope (herdr-meter reads them) ----

export const ROLE_LABEL = "role";
export const CATEGORY_LABEL = "category";
export const SQUAD_LABEL = "squad";
/**
 * Holds the `squad=` value this pack copied from the lead's pane. While the pane's squad
 * still equals it, the squad is ours to move or remove; a squad set later (the helper's)
 * differs from it and is never touched.
 */
export const SQUAD_MARK = "automagik-herdr.squad";

/** Whether a pane's squad is the one this pack copied (its mark still names it). */
export const copiedSquad = (have) => Boolean(have?.[SQUAD_LABEL]) && have?.[SQUAD_MARK] === have[SQUAD_LABEL];

/** The bot a member reports to (A1), "" for the main bot or an unknown one. */
export function leadIdOf(file, botId) {
  const bot = file?.bots?.find((b) => b.id === botId);
  return bot?.kind === "member" ? effectiveLead(file, botId).lead : "";
}

/**
 * A bot pane's `role=` (A16): the main bot is `main`; a member that leads another bot (by
 * effective lead) is `captain`; else its rank. No rank: null (no label).
 */
export function roleOf(file, botId) {
  const bot = file.bots.find((b) => b.id === botId);
  if (!bot) return null;
  if (bot === mainBotOf(file)) return "main";
  if (file.bots.some((b) => b.id !== botId && b.kind === "member" && effectiveLead(file, b.id).lead === botId)) return "captain";
  return bot.rank || null;
}

/**
 * The lead's pane whose labels a bot copies its squad from: of the panes carrying the lead's
 * label on this computer (terminals() rows or hc get answers), the live ones with an agent in
 * front (Decision 3), the newest by created_ms. Null when none. Used by Start, Attach and an
 * edit's relabel, in the CLI and the sidebar alike.
 */
export function leadPane(rows) {
  // program.agent false is not the last word: an agent in the foreground counts too.
  const live = (rows ?? []).filter((r) => r?.state === "live" && (rowIsAgent(r) === true || agentInForeground(r)));
  // newest() starts from null, so a row with no created_ms would never be picked.
  return live.length ? live.reduce((a, b) => ((b.created_ms ?? -1) > (a.created_ms ?? -1) ? b : a)) : null;
}

/**
 * The labels a bot's pane should carry (A16): `bot=<id>`; `role=` (roleOf) when there is one;
 * `category=<id>` when its effective category exists. `squad=` is never overwritten: when
 * `existing` (the pane's labels now) has one, it isn't listed; else the lead's pane's squad
 * (`leadLabels`) is copied, with SQUAD_MARK holding the copied value.
 */
export function paneLabels(file, botId, existing = {}, leadLabels = null) {
  const out = { [BOT_LABEL]: botId };
  const role = roleOf(file, botId);
  if (role) out[ROLE_LABEL] = role;
  const category = effectiveCategory(file, botId);
  if (category) out[CATEGORY_LABEL] = category;
  const squad = leadLabels?.[SQUAD_LABEL];
  if (!existing?.[SQUAD_LABEL] && squad) { out[SQUAD_LABEL] = squad; out[SQUAD_MARK] = squad; }
  return out;
}

/** `hc label` K=V words that bring a pane's labels (`have`) up to `want` (paneLabels): set only. */
export function labelWords(want, have = {}) {
  return Object.entries(want).filter(([k, v]) => v && have?.[k] !== v).map(([k, v]) => `${k}=${v}`);
}

/**
 * Attach's words for a pane (`have`: its labels, the bot label included), the lead's rows
 * given: the pane ends up matching paneLabels. A role= or category= this bot computes
 * differently is set, one it doesn't compute at all comes off (a stale one from the pane's
 * last bot). An unmarked squad is left alone; a squad this pack copied (copiedSquad) takes
 * the lead pane's, or comes off with its mark when the lead's pane has none.
 */
export function attachWords(file, botId, have, leadRows) {
  const leadSquad = leadPane(leadRows)?.labels?.[SQUAD_LABEL] ?? null;
  const want = paneLabels(file, botId, have, leadPane(leadRows)?.labels ?? null);
  const words = labelWords(want, have);
  for (const k of [ROLE_LABEL, CATEGORY_LABEL]) if (have?.[k] && !want[k]) words.push(`${k}=`);
  if (copiedSquad(have) && have[SQUAD_LABEL] !== leadSquad) {
    words.push(...(leadSquad ? [`${SQUAD_LABEL}=${leadSquad}`, `${SQUAD_MARK}=${leadSquad}`] : [`${SQUAD_LABEL}=`, `${SQUAD_MARK}=`]));
  }
  return words;
}

/**
 * The words after an edit (A16): `before` and `after` are paneLabels of the old and new file
 * (no pane labels known). A role or category that changed is set, or removed when the new file
 * has none and the pane still carries the one the old file gave it. The squad: a pane with
 * none gets the lead's (`leadSquad`, the lead pane's squad or null); a squad this pack copied
 * (copiedSquad) follows a lead change: the new lead's, or removed with its mark when the new
 * lead has none. A squad set by anyone else is never touched.
 */
export function relabelWords(before, after, have = {}, { leadChanged = false, leadSquad = null } = {}) {
  const words = [];
  for (const k of [ROLE_LABEL, CATEGORY_LABEL]) {
    if (after[k] && have?.[k] !== after[k]) words.push(`${k}=${after[k]}`);
    else if (!after[k] && before[k] && have?.[k] === before[k]) words.push(`${k}=`);
  }
  if (!have?.[SQUAD_LABEL]) {
    if (leadSquad) words.push(`${SQUAD_LABEL}=${leadSquad}`, `${SQUAD_MARK}=${leadSquad}`);
  } else if (leadChanged && copiedSquad(have) && have[SQUAD_LABEL] !== leadSquad) {
    words.push(...(leadSquad ? [`${SQUAD_LABEL}=${leadSquad}`, `${SQUAD_MARK}=${leadSquad}`] : [`${SQUAD_LABEL}=`, `${SQUAD_MARK}=`]));
  }
  return words;
}

/**
 * The words Detach sends: bot, role and category off (any value: nothing else sets them
 * today); the squad only while it is the one this pack copied, and the mark always.
 */
export function detachWords(have = {}) {
  const words = [`${BOT_LABEL}=`];
  for (const k of [ROLE_LABEL, CATEGORY_LABEL]) if (have?.[k]) words.push(`${k}=`);
  if (copiedSquad(have)) words.push(`${SQUAD_LABEL}=`);
  if (have?.[SQUAD_MARK]) words.push(`${SQUAD_MARK}=`);
  return words;
}

/**
 * The bots whose pane labels an edit changes (A16): every bot of the new file whose role or
 * category differs from the old file's, or whose effective lead changed (a squad to copy or
 * move). Planned bots have no pane. Returns [{ id, lead, before, after, leadChanged }]
 * (before/after: paneLabels with no pane labels known; `lead`: its lead in the new file).
 */
export function relabelPlan(beforeFile, afterFile) {
  const plan = [];
  for (const b of afterFile?.bots ?? []) {
    if (b.planned) continue;
    const had = beforeFile?.bots?.some((x) => x.id === b.id);
    const before = had ? paneLabels(beforeFile, b.id) : { [BOT_LABEL]: b.id };
    const after = paneLabels(afterFile, b.id);
    const lead = leadIdOf(afterFile, b.id);
    const leadChanged = Boolean(had) && leadIdOf(beforeFile, b.id) !== lead;
    if (before[ROLE_LABEL] !== after[ROLE_LABEL] || before[CATEGORY_LABEL] !== after[CATEGORY_LABEL] || leadChanged) {
      plan.push({ id: b.id, lead, before, after, leadChanged });
    }
  }
  return plan;
}

/**
 * Carries out a relabelPlan on this computer's panes, the I/O given (as paneOf takes `ask`):
 * `io.rows(botId)` resolves with the live local panes carrying that bot's label ({ address,
 * labels, state, created_ms, program? | foreground? }); `io.label(address, words)` sets labels
 * and resolves true when hc did. A failure of either is caught and the rest go on: a pane hc
 * didn't label is listed in `failed`; a bot whose panes couldn't be looked up (io.rows threw:
 * hc unavailable) in `unchecked`, since whether it has panes at all is unknown.
 * Resolves { done: addresses, failed: addresses, unchecked: bot ids }.
 */
export async function relabel(plan, io) {
  const done = [], failed = [], unchecked = [];
  for (const item of plan) {
    let rows;
    let leadSquad = null;
    try {
      rows = await io.rows(item.id);
      if (item.lead) leadSquad = leadPane(await io.rows(item.lead))?.labels?.[SQUAD_LABEL] ?? null;
    } catch { unchecked.push(item.id); continue; }
    for (const row of rows.filter((r) => r?.state === "live" && r.address)) {
      const words = relabelWords(item.before, item.after, row.labels ?? {}, { leadChanged: item.leadChanged, leadSquad });
      if (!words.length) continue;
      let ok = false;
      try { ok = await io.label(row.address, words); } catch { ok = false; }
      (ok ? done : failed).push(row.address);
    }
  }
  return { done, failed, unchecked };
}

/** The warning after a relabel, naming the panes not labelled and the bots not checked; null when none. */
export function relabelWarning({ failed = [], unchecked = [] } = {}) {
  const parts = [];
  if (failed.length) parts.push(`these panes' labels weren't updated: ${failed.join(", ")}`);
  if (unchecked.length) parts.push(`these bots' panes could not be checked: ${unchecked.join(", ")}`);
  return parts.length ? `Saved, but ${parts.join("; ")}.` : null;
}

/**
 * The attach check for a Claude pane (DESIGN Approach): the folder its session runs in must
 * key to the bot's project. Returns the refusal, naming both folders and the fix, or null.
 */
export function attachRefusal({ botName, projectKey, sessionFolder, sessionKey }) {
  if (sessionKey === projectKey) return null;
  return `Not attached: this Claude session runs in ${sessionFolder}, which belongs to ${sessionKey}, `
    + `not to ${botName}'s project ${projectKey}. Claude reads its settings only from the folder its `
    + `session started in, so ${botName} would get no role or briefing there. Create the bot in `
    + `${sessionKey} instead, or Start ${botName} fresh in its own project.`;
}

/**
 * A mod command as nextCommand() gives it: its name, then optional arguments as JSON or
 * key=value words ("edit b-x", "edit {\"bot\":\"b-x\"}", "attach bot=b-x terminal=t7").
 */
export function parseCommand(text) {
  const s = String(text ?? "").trim();
  const space = s.search(/\s/);
  if (space < 0) return { name: s, args: {} };
  const name = s.slice(0, space), rest = s.slice(space + 1).trim();
  if (rest.startsWith("{")) { try { return { name, args: JSON.parse(rest) }; } catch { return { name, args: {} }; } }
  const args = {};
  for (const w of rest.split(/\s+/)) {
    const eq = w.indexOf("=");
    if (eq > 0) args[w.slice(0, eq)] = w.slice(eq + 1);
    else if (w.startsWith("b-")) args.bot = w;
    else args.terminal = w;
  }
  return { name, args };
}

// ---- a bot's pane through hc (the CLI and briefing.mjs; launch.js reads Herdr's terminals()) ----

/** What an `ask` resolves with when hc gave no answer in time (a machine away). */
export const UNANSWERED = Symbol.for("automagik-herdr.unanswered");

/** `hc ls --json`'s rows, whichever shape it printed. */
export const rowsOf = (ls) => (Array.isArray(ls?.terminals) ? ls.terminals : Array.isArray(ls) ? ls : []);

/**
 * The panes carrying `bot=<id>` (`hc ls --label`), a display hint only: the attach ledger
 * (attach.js) says which pane plays a bot. Used where there is no ledger yet (the briefing
 * hook before the CLI's first run) and to clear a detached bot's labels. Each is asked with
 * `hc get`, live when an agent is in front; among several, the newest by created_ms, flagged
 * `duplicate`.
 * `ask(args)` runs `hc <args> --json` and resolves with the parsed answer, null when hc
 * failed, or UNANSWERED when it ran out of time; it may also throw (the CLI does when hc
 * fails, so a failure never reads as "no pane"). `localOnly` keeps this computer's
 * terminals (Start, Attach, Detach); the briefing and `ls` look everywhere.
 * Resolves { get, duplicate, addresses, gets } (`get` null: not running; `addresses` every
 * terminal carrying the label; `gets` every hc get answer) or, when any call went
 * unanswered, the same with `unreachable: true`.
 */
export async function paneOf(botId, ask, { localOnly = false } = {}) {
  const none = { get: null, duplicate: false, addresses: [], gets: [] };
  const ls = await ask(["ls", "--label", `${BOT_LABEL}=${botId}`]);
  if (ls === UNANSWERED) return { ...none, unreachable: true };
  const rows = rowsOf(ls).filter((r) => r?.address && r.state !== "finished" && (!localOnly || !r.address.includes("/")));
  const addresses = rows.map((r) => r.address);
  const answers = await Promise.all(rows.map((r) => ask(["get", r.address])));
  // A pane that didn't answer may be the newest: no address beats a stale one.
  if (answers.includes(UNANSWERED)) return { ...none, addresses, unreachable: true };
  const gets = answers.filter((g) => g && typeof g === "object");
  const live = gets.filter((g) => g.state !== "finished" && agentInForeground(g));
  return { get: live.length ? newest(live) : null, duplicate: live.length > 1, addresses, gets };
}

/**
 * Where a bot started from the command line opens in Herdr: the space (and tab) of a live
 * terminal Herdr placed, from its `herdr.space` / `herdr.tab` labels. `gets` are `hc get`
 * answers of terminals whose folder keys to the project; the first placed one counts.
 */
export function placementFrom(gets) {
  const g = gets.find((x) => typeof x?.labels?.["herdr.space"] === "string" && x.labels["herdr.space"]);
  return g ? { space: g.labels["herdr.space"], tab: g.labels["herdr.tab"] || null, from: g.address } : null;
}

/**
 * The same from the window (`herdr-app ls` as state.mjs spacesOf has it): the first space of
 * this computer whose folder keys to the project (`keys`: Map<folder, key>), in its selected
 * tab, passing over the ids in `skip`. Null when none does.
 */
export function spacePlace(spaces, keys, key, skip = new Set()) {
  const s = spaces.find((x) => !x.machine && !skip.has(x.id) && x.folder && keys.get(x.folder) === key);
  return s ? { space: s.id, tab: s.tabs?.find((t) => t.selected)?.id ?? null, from: null } : null;
}
