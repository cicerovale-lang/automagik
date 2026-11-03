#!/usr/bin/env node
// automagik-herdr: Automagik Herdr from the command line (A11, A15): a project's bots, and
// updates of the installed pack (A14, update.mjs). The bots follow the same rules as the
// sidebar (model.js, launchArgs.js, briefingText.mjs, models.js, briefing.mjs' gathering),
// with herdr-core reached through `hc` directly. Plain node (≥ 24): no `herdr` or `gpui`
// import, no Herdr window.
// Install: ln -s ~/.config/herdr-app/mods/am-sidebar/bin/automagik-herdr ~/.local/bin/automagik-herdr
// (that wrapper runs this file through bin/run.sh, which finds node 22.7+ or bun without node on PATH).
// Apache-2.0.

import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, linkSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync,
  renameSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { BOT_LABEL, BOTS_PATH, CHARACTERS, COLOURS, KINDS, MAX_INSTRUCTIONS, OMNI_LOOK, applyBotEdit, checkBots,
  CATEGORY_ID, PROJECTS_FILE, RANKS, defaultLook, descendantsOf, effectiveLead, listedProjects, mainBotOf, newBotId, newCategoryId,
  parseBots, plannedOf, projectKeyOf, projectOf, withListedProject } from "../model.js";
import { UNANSWERED, agentInForeground, attachRefusal, attachWords, detachWords, hcName, isClaude, leadIdOf, leadPane, newest,
  paneLabels, paneOf, parentArgs, placementFrom, relabel, relabelPlan, relabelWarning, relabelWords, rowsOf, spacePlace,
  startArgs, startRefusal } from "../launchArgs.js";
import { attachKey, attachLine, attachPath, attachRow, closingRow, confirmBindings, foldAttach, modeProblem, readAttach } from "../attach.js";
import { interpreterPath } from "../agentPath.mjs";
import { installHook, withExclude } from "../briefingText.mjs";
import { gatherBriefing } from "../briefing.mjs";
import { agentKeyOfArgv, defaultModel, detectModel, knownModels, modelArgs, resolveAgent, shownModel, withOverrides } from "../models.js";
import { EFFORT_SHAPE, HC_NAME_MAX, LEAD_RANKS, LEAD_SHAPE, LEDGER_FILE, ROLES, WORKER_OF_LABEL, WORKER_ROLE_LABEL, WORKTREES_EXCLUDE,
  SESSION_LABEL, baseCandidates, branchNamesTask, branchSlug, ledgerLine, ledgerPath, optionLike, readLedger, sessionRow, parseWorktrees, runsTemplate, startRow, swapArm, swapByte,
  taskIdProblem, taskWorkerName, TEMPLATE_SHAPE, templateAgent, workerArgs, workerBranch, workerPlan, workerRole, worktreeFolder,
  writesWorktree } from "../workers.js";
import { carriedLabels, continueRefusal, ledgerSession, planText as restartText, restartPlan, restartRefusal, sessionOf } from "../restart.js";
import { binDirOf, checkForUpdate, defaultModsDir, installUpdate, liveHome, readMarker, relinkCli, rollback as rollbackPack, writeMarker } from "../update.mjs";
import { NO_UPDATE_ENV, PACK_NAME, POCKET_LINK, USAGEMETER } from "../release.js";
import { MACHINE_NAME, OPT_IN, decodeExec, hcExecArgs, installOn, linkedMachines, meterPins, meterReleases, meterScope, recordAfter, resultLine, uninstallOn } from "../meterFleet.js";
import { SHARED_RENAMES, renamedFrom } from "../migrate.js";
import { RemoteFileError, StaleSnapshot, readRemoteText, removeRemoteText, writeRemoteText } from "../remoteFile.js";
import { botHistory, historyLines } from "../inspect.js";
import { hooksNotice } from "../migrateHooks.mjs";
import { SPACE_LABEL, plan as tidyPlan, planText } from "../tidy.js";
import { fixNonVisual, readState, spacesOf } from "./state.mjs";

/** A refusal or a usage mistake: printed on stderr, exit `code`. */
export class CliError extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

// ---- files and programs ----

/** A file's text, or null when it isn't there. Any other read failure is a CliError. */
export function readText(path) {
  try { return readFileSync(path, "utf8"); } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw new CliError(`Can't read ${path}: ${e?.message ?? e}`);
  }
}
const exists = async (path) => { try { accessSync(path); return true; } catch { return false; } };
/** Where a link points (its text, as readlink gives it), or null when `path` is not a link. */
const readLink = (path) => { try { return readlinkSync(path); } catch { return null; } };
const under = (key, rest) => `${key === "/" ? "" : key}/${rest}`;

// At most this many programs at once: `ls --all` over many bots stays a handful of processes.
const MAX_RUNNING = 8;
let running = 0;
const waiting = [];
async function slot(fn) {
  if (running >= MAX_RUNNING) await new Promise((go) => waiting.push(go));
  running += 1;
  try { return await fn(); } finally { running -= 1; waiting.shift()?.(); }
}

/** Runs a program: { code, stdout, stderr }; code 127 when it isn't there. */
export function runProgram(command, args, { cwd, timeout = 15000 } = {}) {
  return slot(() => new Promise((done) => {
    try {
      execFile(command, args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return done({ code: 0, stdout, stderr });
        done({ code: err.code === "ENOENT" ? 127 : (typeof err.code === "number" ? err.code : 1), stdout: stdout ?? "", stderr: stderr || String(err.message) });
      });
    } catch (e) { done({ code: 127, stdout: "", stderr: String(e?.message ?? e) }); }
  }));
}
const git = async (args, cwd) => { const r = await runProgram("git", args, { cwd }); return r.code === 0 ? r.stdout : null; };

/** The project a folder keys to (DESIGN Decision 15): the walk-up, for the folder a command runs in. */
export const keyOf = (folder) => projectKeyOf(resolvePath(folder), git, exists);

/**
 * The project `--project <dir>` names: the folder itself outside git, never a parent
 * project's (its git main checkout in git). A folder that isn't there is refused.
 */
export async function namedKeyOf(folder) {
  const dir = resolvePath(folder);
  let isDir = false;
  try { isDir = statSync(dir).isDirectory(); } catch { /* not there */ }
  if (!isDir) throw new CliError(`--project: ${dir} is not a folder.`, 2);
  return (await projectOf(dir, git, exists)).own;
}
// The projects this run named, for the attach ledger's one-time import (projectDefining).
const namedKeys = new Set();
const commandKeyOf = async (opts) => {
  const key = await (opts.project !== undefined ? namedKeyOf(opts.project) : keyOf(process.cwd()));
  namedKeys.add(key);
  return key;
};

async function hc(args) {
  const r = await runProgram(programPath("hc") ?? "hc", args);
  if (r.code === 127) throw new CliError("hc (herdr-core) is not on PATH.");
  return r;
}
const parsed = (r, args) => {
  try { return JSON.parse(r.stdout); } catch { throw new CliError(`hc ${args.join(" ")} printed no JSON: ${r.stdout.slice(0, 200)}`); }
};
/** `hc <args> --json`, parsed. A failed call throws: a failure never reads as "no pane". */
async function hcJson(args) {
  const r = await hc([...args, "--json"]);
  if (r.code !== 0) throw new CliError(`hc ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return parsed(r, args);
}
/** `hc get <t> --json`, or null when hc says there is no such terminal (hc itself missing still throws). */
async function hcGet(terminal) {
  const r = await hc(["get", terminal, "--json"]);
  return r.code === 0 ? parsed(r, ["get", terminal]) : null;
}
const local = (address) => typeof address === "string" && !address.includes("/");

function appHome(env = process.env) { return (env.HERDR_APP_HOME || `${homedir()}/.config/herdr-app`).replace(/\/+$/, ""); }
const home = () => process.env.HOME || homedir();
const modelIo = () => ({ home: home(), read: (p) => { try { return readText(p); } catch { return null; } } });
/** The agents Herdr can start: its shipped table with the app home's programs.json applied. */
const agentTable = () => withOverrides(readText(`${appHome()}/programs.json`));

/**
 * Where `program` runs from: PATH, then two folders a PATH may lack when the sidebar runs this
 * CLI with Herdr's own (~/.local/bin, where hc and Claude Code install, and the folder of the
 * node running this, where an nvm-installed agent such as codex is). Null when none has it.
 */
function programPath(program) {
  if (program.includes("/")) { try { accessSync(program, constants.X_OK); return program; } catch { return null; } }
  const dirs = [...(process.env.PATH ?? "").split(":"), `${home()}/.local/bin`, dirname(process.execPath)];
  for (const dir of dirs) {
    if (!dir) continue;
    try { accessSync(`${dir}/${program}`, constants.X_OK); return `${dir}/${program}`; } catch { /* next */ }
  }
  return null;
}
const onPath = (program) => programPath(program) !== null;

// ---- the definitions file ----

const EMPTY = () => ({ version: 1, categories: [], bots: [] });

/** A project's definitions: { key, machine: null, text (null: no file), raw, file, warnings }. */
export function loadProject(key) {
  return projectFrom(key, null, readText(under(key, BOTS_PATH)));
}

function projectFrom(key, machine, text) {
  if (text === null) return { key, machine, text, raw: EMPTY(), file: EMPTY(), warnings: [] };
  let parsedFile;
  try { parsedFile = parseBots(text); } catch (e) { throw new CliError(`${fileName({ key, machine })}: ${e?.message ?? e}`); }
  return { key, machine, text, raw: parsedFile.raw, file: parsedFile.file, warnings: parsedFile.warnings };
}
/** A project's file, named for people: `<key>/.herdr/bots.json`, `… on <machine>` for a linked one's. */
const fileName = ({ key, machine }) => `${under(key, BOTS_PATH)}${machine ? ` on ${machine}` : ""}`;

// ---- a project on a linked machine (--machine M --project DIR; automagik#206) ----

// herdr-core there: its file ops (remoteFile.js) and one program, as `hc exec --on` runs it.
const remoteIo = {
  hc,
  exec: async (command, args, machine, { cwd } = {}) =>
    decodeExec(await hc(["exec", "--json", "--on", machine, ...(cwd ? ["--cwd", cwd] : []), "--", command, ...args]), 60),
};

// What hc said: its error's message when it printed one as JSON.
const hcSaid = (text) => { try { return JSON.parse(text)?.error?.message ?? text; } catch { return text; } };

/**
 * The project `--project <dir>` names on `--machine`, by namedKeyOf's rule there (its git
 * main checkout in git, else the folder itself). The folder is an absolute path on that
 * machine and must be there; a machine that can't be reached is refused, never guessed.
 */
export async function remoteKeyOf(opts) {
  const machine = opts.machine;
  if (!MACHINE_NAME.test(machine)) throw new CliError(`--machine: "${machine}" isn't a machine name (hc machine ls).`, 2);
  if (opts.project === undefined) throw new CliError(`--machine needs --project: the project's folder on ${machine}, as an absolute path.`, 2);
  if (!opts.project.startsWith("/")) throw new CliError(`--project: ${opts.project} is a folder on ${machine}, so give it as an absolute path.`, 2);
  const dir = opts.project.replace(/\/+$/, "") || "/";
  const there = await remoteIo.exec("test", ["-d", dir], machine);
  if (there.code === -1) throw new CliError(`${machine} can't be reached: ${hcSaid(there.stderr)}`);
  if (there.code !== 0) throw new CliError(`--project: ${dir} is not a folder on ${machine}.`, 2);
  // A call that got no answer (code -1: hc failed, a timeout) means the machine is away, never
  // "not in git" or "not there".
  const ask = async (command, args, cwd) => {
    const r = await remoteIo.exec(command, args, machine, { cwd });
    if (r.code === -1) throw new CliError(`${machine} can't be reached: ${hcSaid(r.stderr)}`);
    return r;
  };
  const gitThere = async (args, cwd) => { const r = await ask("git", args, cwd); return r.code === 0 ? r.stdout : null; };
  const existsThere = async (path) => (await ask("test", ["-e", path])).code === 0;
  return (await projectOf(dir, gitThere, existsThere)).own;
}

/** loadProject for a project on a linked machine, read there through herdr-core. */
export async function loadRemoteProject(key, machine) {
  let text;
  try { text = await readRemoteText(remoteIo, machine, under(key, BOTS_PATH)); } catch (e) {
    if (e instanceof RemoteFileError) throw new CliError(e.message);
    throw e;
  }
  return projectFrom(key, machine, text);
}

/**
 * writeBotsFile's rule on a linked machine: the whole raw file must pass checkBots, and the
 * file there must still hold the text read (null: none), else nothing is written
 * (remoteFile.js: hc file edit for an edit, an exclusive create for a new file, a checked
 * remove for `raw === null`).
 */
async function writeRemoteBots(project, raw) {
  const { key, machine, text: expected } = project;
  const path = under(key, BOTS_PATH);
  if (raw !== null) {
    const errors = checkBots(raw, expected);
    if (errors.length) throw new CliError(`Not saved: ${errors.join("; ")}`);
  }
  try {
    if (raw === null) await removeRemoteText(remoteIo, machine, path, expected);
    else await writeRemoteText(remoteIo, machine, path, `${JSON.stringify(raw, null, 2)}\n`, expected);
  } catch (e) {
    if (e instanceof StaleSnapshot) throw new CliError(`Not saved: ${fileName(project)} changed since it was read (another edit landed first). Run the command again.`);
    // A write whose answer was lost and that the file doesn't show: said as it is.
    if (e instanceof RemoteFileError && e.kind === "unknown_state") throw new CliError(e.message);
    if (e instanceof RemoteFileError) throw new CliError(`Not saved: ${e.message}`);
    throw e;
  }
}

/**
 * Saves a project's raw file where it is (raw null: deletes it) and, on this computer, lists
 * the project for the sidebar (`list`). The CLI's project list holds this computer's projects
 * only: a linked machine's shows in the sidebar from its open space, or once the sidebar
 * itself has written it.
 */
async function saveProject(project, raw, { list = true } = {}) {
  if (project.machine) return writeRemoteBots(project, raw);
  writeBotsFile(project.key, raw, project.text);
  if (list) listProject(project.key);
}

const fsIo = {
  read: readText,
  mkdir: (dir) => mkdirSync(dir, { recursive: true }),
  create: (path, text) => writeFileSync(path, text, { flag: "wx" }),
  replace: (path, text) => {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, text);
    try { renameSync(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch { /* gone already */ } throw e; }
  },
  remove: (path) => unlinkSync(path),
};

/**
 * Writes a project's definitions by bots.js writeBots' rule: the whole raw file must pass
 * checkBots, and the file must still hold `expected`, the text the edit started from (null:
 * no file yet), else nothing is written. A new file gets its `.herdr/` folder first and is
 * created exclusively; an existing one is replaced whole (written beside, then renamed).
 * `raw === null` deletes the file (the project's last bot removed).
 */
export function writeBotsFile(key, raw, expected, io = fsIo) {
  if (expected === undefined) throw new Error("writeBotsFile: pass the text the edit started from (null for a new file)");
  const path = under(key, BOTS_PATH);
  if (raw !== null) {
    const errors = checkBots(raw, expected);
    if (errors.length) throw new CliError(`Not saved: ${errors.join("; ")}`);
  }
  let now;
  try { now = io.read(path); } catch (e) { throw new CliError(`Not saved: can't read ${path} again: ${e?.message ?? e}`); }
  if (now !== expected) throw new CliError(`Not saved: ${path} changed since it was read (another edit landed first). Run the command again.`);
  try {
    if (raw === null) return io.remove(path);
    const text = `${JSON.stringify(raw, null, 2)}\n`;
    if (expected === null) { io.mkdir(under(key, ".herdr")); io.create(path, text); } else io.replace(path, text);
  } catch (e) {
    if (e?.code === "EEXIST") throw new CliError(`Not saved: ${path} appeared since it was read. Run the command again.`);
    throw new CliError(`Not saved: ${e?.message ?? e}`);
  }
}

// A lock beside the project list: made exclusively (wx) holding its holder's pid and a token,
// so one CLI at a time edits the list, and a holder removes only its own lock. Waited for up
// to LOCK_WAIT ms; one older than LOCK_STALE ms (a CLI killed mid-write) is taken over.
// Without it, two CLIs that read the list at once each write their own copy.
const LOCK_WAIT = 3000;
const LOCK_STALE = 10_000;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const stale = (path) => { try { return Date.now() - statSync(path).mtimeMs > LOCK_STALE; } catch { return false; } };

// A stale lock is moved aside first, so of two waiters only one takes it. Aside, it is checked
// again: a lock made fresh in between goes back (by link, which never replaces a newer one).
function takeOverStale(lock) {
  if (!stale(lock)) return;
  const aside = `${lock}.${process.pid}`;
  try { renameSync(lock, aside); } catch { return; } // another waiter moved it first
  if (!stale(aside)) { try { linkSync(aside, lock); } catch { /* a newer lock is there */ } }
  try { unlinkSync(aside); } catch { /* gone already */ }
}

function takeLock(lock) {
  const token = `${process.pid} ${randomUUID()}`;
  const until = Date.now() + LOCK_WAIT;
  for (;;) {
    try { writeFileSync(lock, token, { flag: "wx" }); return token; } catch (e) {
      if (e?.code !== "EEXIST") throw e;
      takeOverStale(lock);
      if (Date.now() > until) throw new Error(`${lock} is held by another automagik-herdr`);
      pause(5 + Math.floor(Math.random() * 20));
    }
  }
}
function dropLock(lock, token) {
  try { if (readFileSync(lock, "utf8") === token) unlinkSync(lock); } catch { /* gone already */ }
}
function withLock(lock, fn) {
  const token = takeLock(lock);
  try { return fn(); } finally { dropLock(lock, token); }
}
async function withLockAsync(lock, fn) {
  const token = takeLock(lock);
  try { return await fn(); } finally { dropLock(lock, token); }
}

/**
 * Adds a project to the list the sidebar reads beside its own remembered projects
 * (model.js PROJECTS_FILE, in the app home outside mods/, so the write reloads nothing), so a
 * project managed from here shows in the sidebar with no space open on it. Under a lock:
 * read, add, write beside, rename, read again; tried three times until the key is there.
 * No app home (Herdr isn't set up here): nothing is written. A failure only warns: the
 * command's own work is done.
 */
export function listProject(key, dir = appHome()) {
  const path = `${dir}/${PROJECTS_FILE}`;
  const read = () => { try { return readFileSync(path, "utf8"); } catch (e) { if (e?.code === "ENOENT") return null; throw e; } };
  let why = "it was still missing after three writes";
  if (!existsSync(dir)) return false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      withLock(`${path}.lock`, () => {
        const text = read();
        const next = withListedProject(text, key);
        if (next !== text) fsIo.replace(path, next);
      });
      if (listedProjects(read()).includes(key)) return true;
    } catch (e) { why = e?.message ?? String(e); }
  }
  process.stderr.write(`automagik-herdr: couldn't list ${key} in ${path}, so the sidebar shows it only once a space is open on it: ${why}\n`);
  return false;
}

/** Takes keys off the CLI's project list (tidy's registry prune), under listProject's lock. */
export function unlistProjects(keys, dir = appHome()) {
  const path = `${dir}/${PROJECTS_FILE}`;
  withLock(`${path}.lock`, () => {
    let text;
    try { text = readFileSync(path, "utf8"); } catch (e) { if (e?.code === "ENOENT") return; throw e; }
    const next = `${JSON.stringify(listedProjects(text).filter((k) => !keys.includes(k)), null, 2)}\n`;
    if (next !== text) fsIo.replace(path, next);
  });
}

/** A bot by id, else by its name (exact, then ignoring case), unique in the project. */
export function findBot(file, ref) {
  if (!ref) throw new CliError("Name a bot (its id or its name).", 2);
  const byId = file.bots.find((b) => b.id === ref);
  if (byId) return byId;
  for (const same of [(b) => b.name === ref, (b) => b.name.toLowerCase() === String(ref).toLowerCase()]) {
    const hits = file.bots.filter(same);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) throw new CliError(`${hits.length} bots are named "${ref}" (${hits.map((b) => b.id).join(", ")}); use the id.`);
  }
  throw new CliError(`No bot "${ref}" in this project.`);
}

function findCategory(file, ref) {
  const hit = file.categories.find((c) => c.id === ref) ?? file.categories.find((c) => c.title.toLowerCase() === String(ref).toLowerCase());
  if (!hit) throw new CliError(`No category "${ref}" in this project; add it first: automagik-herdr category add --title "${ref}".`);
  return hit;
}

// ---- the attach ledger (attach.js): which terminal plays which bot ----

/** The attach ledger can't be trusted or read: never mistaken for "hc unavailable". */
export class LedgerRefusal extends CliError {}

/** `hc get <t> --json`; null only when hc answers not_found (exit 3), any other failure throws. */
async function hcLookup(terminal) {
  const r = await hc(["get", terminal, "--json"]);
  if (r.code === 0) return parsed(r, ["get", terminal]);
  let kind = null;
  try { kind = JSON.parse(r.stderr || r.stdout)?.error?.kind ?? null; } catch { kind = null; }
  if (r.code === 3 || kind === "not_found") return null;
  throw new CliError(`hc get ${terminal} failed: ${(r.stderr || r.stdout).trim()}`);
}

let coreOnce = null;
/**
 * This computer's hc core id: `hc server status`'s core.id, "permanent random id, reset only
 * when state is wiped" (hc schema CoreInfo). Asked once per run; a failure throws.
 */
function coreId() {
  coreOnce ??= hcJson(["server", "status"]).then((s) => {
    const id = s?.core?.id;
    if (typeof id !== "string" || !id) throw new CliError("hc server status gave no core id.");
    return id;
  });
  return coreOnce;
}

/** The ledger's rows, or null when there is no file. A group- or world-writable file is refused. */
export function readAttachFile(path = attachPath(appHome())) {
  let st;
  try { st = statSync(path); } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
    throw new LedgerRefusal(`Can't read ${path}: ${e?.message ?? e}`);
  }
  const why = modeProblem(path, st.mode);
  if (why) throw new LedgerRefusal(why);
  let text;
  try { text = readFileSync(path, "utf8"); } catch (e) { throw new LedgerRefusal(`Can't read ${path}: ${e?.message ?? e}`); }
  return readAttach(text).rows;
}

/** Appends rows, one O_APPEND write each, the file made 0600 when new (`flag` "ax": only when absent). */
function appendAttach(path, rows, flag = "a") {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, flag, 0o600);
  try { for (const row of rows) writeSync(fd, attachLine(row)); } finally { closeSync(fd); }
}

/** The ledger's lock, beside it (its folder made first). */
const ledgerLock = (path) => { mkdirSync(dirname(path), { recursive: true }); return `${path}.lock`; };
const asCliError = (e) => (e instanceof CliError ? e : new CliError(e?.message ?? String(e)));

/**
 * Which project defines `botId`: the one `folder` keys to, else one this run named, the
 * current folder's, or a remembered one; null when none does.
 */
async function projectDefining(botId, folder) {
  const keys = [];
  for (const f of [folder, process.cwd()]) {
    if (typeof f === "string") { try { keys.push(await keyOf(f)); } catch { /* a folder gone */ } }
  }
  for (const k of [...namedKeys, ...rememberedKeys()]) if (!keys.includes(k)) keys.push(k);
  for (const k of keys) {
    try { if (loadProject(k).file.bots.some((b) => b.id === botId)) return k; } catch { /* unreadable: not this one */ }
  }
  return null;
}

/**
 * The one-time import (Ruling: labels seed the ledger once): with no ledger file yet, every
 * live terminal on this computer carrying `bot=<id>` becomes an attach row (by "import"),
 * one per bot by the old live rule (an agent in front, then the newest), its project the one
 * that defines the bot. The file is created, even empty, so it happens once.
 */
async function importLabels(path) {
  const core = await coreId();
  const rows = rowsOf(await hcJson(["ls"])).filter((r) => local(r?.address) && r.state !== "finished");
  // One terminal hc fails to answer for is left out, never the whole import.
  const gets = (await Promise.all(rows.map((r) => hcLookup(r.address).catch(() => null))))
    .filter((g) => g?.state === "live" && local(g.address) && typeof g.labels?.[BOT_LABEL] === "string" && Number.isSafeInteger(g.created_ms));
  const byBot = new Map();
  for (const g of gets) byBot.set(g.labels[BOT_LABEL], [...(byBot.get(g.labels[BOT_LABEL]) ?? []), g]);
  const found = [];
  for (const [bot, all] of byBot) {
    const agents = all.filter(agentInForeground);
    const pick = newest(agents.length ? agents : all);
    // A label naming no bot defined here (a stale or hand-set one) is left out.
    const project = await projectDefining(bot, pick.foreground?.cwd ?? pick.cwd);
    if (project) found.push(attachRow({ event: "attach", bot, project, terminal: pick.address, core, created_ms: pick.created_ms, by: "import" }));
  }
  try {
    await withLockAsync(ledgerLock(path), async () => {
      if (existsSync(path)) return; // another CLI imported first
      appendAttach(path, found, "ax");
    });
  } catch (e) { throw asCliError(e); }
}

/** End rows (by "sweep") for bindings hc no longer confirms, under the lock; a failure only warns. */
async function sweep(path, ended) {
  try {
    await withLockAsync(ledgerLock(path), async () => {
      const { byKey } = foldAttach(readAttachFile(path) ?? []);
      const rows = ended.filter(({ binding }) => byKey.get(attachKey(binding))?.bot === binding.bot)
        .map(({ binding, reason }) => closingRow(binding, "end", "sweep", reason));
      if (rows.length) appendAttach(path, rows);
    });
  } catch (e) {
    if (e instanceof LedgerRefusal) throw e;
    report([`couldn't write end rows to ${path}: ${e?.message ?? e}`]);
  }
}

/**
 * The ledger's rows, the one-time import done first when there is no file. With no app home
 * (Herdr not set up here) nothing is imported or made: no rows, until a start or attach.
 */
async function ledgerRows(path) {
  const rows = readAttachFile(path);
  if (rows !== null) return rows;
  if (!existsSync(appHome())) return [];
  await importLabels(path);
  return readAttachFile(path) ?? [];
}

let viewOnce = null;
/**
 * The ledger as hc confirms it now: { core, path, live: Map bot -> { binding, get },
 * byTerminal: Map address -> { binding, get } }. Every binding is checked with `hc get`;
 * one hc no longer confirms (finished, gone, or its id reused) is left out, and its end row
 * written. Once per run: commands that write the ledger decide again under its lock.
 */
export function attachView() {
  viewOnce ??= (async () => {
    const path = attachPath(appHome());
    const rows = await ledgerRows(path);
    const core = await coreId();
    const { byKey } = foldAttach(rows);
    const { live, ended } = await confirmBindings([...byKey.values()], core, (args) => hcLookup(args[1]));
    if (ended.length) await sweep(path, ended);
    return { core, path, live: new Map(live.map((l) => [l.binding.bot, l])), byTerminal: new Map(live.map((l) => [l.binding.terminal, l])) };
  })();
  return viewOnce;
}

/**
 * Runs `fn` under the ledger's lock with the fold read again: fn({ core, byBot, byKey, holds,
 * write }). `holds(binding)` confirms a binding with hc ({ binding, get } or null; an ended
 * one gets its end row), `write(rows)` appends. Two CLIs never both attach one bot.
 */
async function underLedger(fn) {
  const path = attachPath(appHome());
  await ledgerRows(path);
  const core = await coreId();
  try {
    return await withLockAsync(ledgerLock(path), async () => {
      const { byBot, byKey } = foldAttach(readAttachFile(path) ?? []);
      const ends = [];
      const holds = async (binding) => {
        if (!binding) return null;
        const { live, ended, unknown } = await confirmBindings([binding], core, (args) => hcLookup(args[1]));
        if (live.length) return live[0];
        if (unknown.length) return { binding, get: null };
        ends.push(closingRow(binding, "end", "sweep", ended[0].reason));
        return null;
      };
      const write = (rows) => appendAttach(path, [...ends.splice(0), ...rows]);
      try { return await fn({ core, byBot, byKey, holds, write }); } finally { if (ends.length) appendAttach(path, ends.splice(0)); }
    });
  } catch (e) { throw asCliError(e); }
}

/** A binding as whois prints it. */
const whoisOf = ({ binding }) => ({ terminal: binding.terminal, core: binding.core, created_ms: binding.created_ms, bot: binding.bot,
  project: binding.project, since: binding.at });

/** The `hc get` of a bot's attached terminal on this computer, or null. */
async function attachedGet(botId) {
  const held = (await attachView()).live.get(botId);
  return held?.get && local(held.get.address ?? held.binding.terminal) ? { ...held.get, address: held.get.address ?? held.binding.terminal } : null;
}

/** One bot as ls and show print it. With hc failing, the bot is still shown, its pane unknown. */
function describe(project, bot, view, hcError) {
  const { file } = project;
  const held = !bot.planned && view ? view.live.get(bot.id) : null;
  const live = held?.get ?? null;
  const lead = bot.kind === "member" ? effectiveLead(file, bot.id) : { lead: "" };
  const fallback = bot.agent ? defaultModel(bot.agent, modelIo()) : null;
  const shown = shownModel({ argv: live?.foreground?.argv, agentKey: bot.agent, pinned: bot.model, fallback });
  let status = "not running";
  if (bot.planned) status = "planned";
  else if (project.machine) status = "unknown"; // another machine's panes: not tracked here yet
  else if (hcError) status = "hc unavailable";
  else if (held) status = agentInForeground(live) ? live.status?.state ?? "running" : "no agent in front";
  const out = {
    id: bot.id, name: bot.name, kind: bot.kind, ...placeOf(project),
    lead: lead.lead || null, leadName: file.bots.find((b) => b.id === lead.lead)?.name ?? null,
    category: bot.kind === "member" && lead.lead === mainBotOf(file)?.id ? (bot.category ?? null) : null,
    planned: bot.planned ?? null, agent: bot.agent ?? null,
    model: shown.model, modelSource: shown.source, pinnedModel: bot.model ?? null,
    terminal: held?.binding.terminal ?? null, status, duplicate: false, since: held?.binding.at ?? null,
    role: bot.role, rank: bot.rank ?? null, look: bot.look,
    worker: bot.worker && typeof bot.worker === "object" ? bot.worker : null,
  };
  if (lead.warning) out.warning = lead.warning;
  if (hcError && !bot.planned) out.hcError = hcError;
  return out;
}

/** The view for ls and show: { view, hcError }; a refused ledger still throws. */
async function viewOrError() {
  try { return { view: await attachView(), hcError: null }; } catch (e) {
    if (e instanceof LedgerRefusal || !(e instanceof CliError)) throw e;
    return { view: null, hcError: e.message };
  }
}

// ---- the briefing hook (briefingText.mjs installHook, as launch.js afterBind uses it) ----

const hookIo = {
  git: (args, cwd) => runProgram("git", args, { cwd }),
  read: async (path) => readText(path),
  write: async (path, text, before) => {
    if (readText(path) !== before) throw new Error(`${path} changed while being edited`);
    fsIo.replace(path, text);
  },
  mkdir: async (dir) => { mkdirSync(dir, { recursive: true }); },
};

/** Merges the per-turn briefing hook for a Claude bot; never throws: { written, warnings }. */
export function writeBriefingHook(bot, folder, appHomeDir = appHome(), options = {}) {
  return installHook(bot.name, folder, appHomeDir, hookIo, options);
}

// ---- arguments ----

const OPTIONS = {
  json: { type: "boolean" }, all: { type: "boolean" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" },
  project: { type: "string" }, name: { type: "string" }, agent: { type: "string" }, kind: { type: "string" },
  role: { type: "string" }, instructions: { type: "string" }, "instructions-file": { type: "string" },
  lead: { type: "string" }, category: { type: "string" }, "no-category": { type: "boolean" },
  character: { type: "string" }, colour: { type: "string" }, color: { type: "string" }, omni: { type: "boolean" },
  model: { type: "string" }, "no-model": { type: "boolean" }, rank: { type: "string" },
  "planned-wave": { type: "string" }, "planned-note": { type: "string" }, unplanned: { type: "boolean" },
  space: { type: "string" }, tab: { type: "string" },
  title: { type: "string" }, sub: { type: "string" }, id: { type: "string" },
  check: { type: "boolean" }, rollback: { type: "boolean" },
  "worker-agent": { type: "string" }, "worker-model": { type: "string" }, "worker-effort": { type: "string" },
  "worker-template": { type: "string" }, template: { type: "string" },
  branch: { type: "string" }, worktree: { type: "string" }, base: { type: "string" }, effort: { type: "string" },
  task: { type: "string" }, bot: { type: "string" }, move: { type: "boolean" },
  fresh: { type: "boolean" }, force: { type: "boolean" }, save: { type: "boolean" },
  machine: { type: "string" }, linked: { type: "boolean" }, local: { type: "boolean" },
};

export const USAGE = `automagik-herdr: Automagik Herdr's bots and updates from the command line

Usage: automagik-herdr <command> [options]      (every command takes --json and --project <folder>)
       automagik-herdr <command> --machine M --project <folder there> ...
                                                 ls, show, create, edit, rm and category on a
                                                 linked machine (hc machine ls), through hc
       automagik-herdr --version                 the installed pack's version

  ls [--all]                    bots with kind, lead, category, rank, planned, agent, model, pane, status
  show <bot>                    one bot in full
  create --name N --agent A [--kind main|member] [--role R]
         [--instructions TEXT | --instructions-file F|-] [--lead BOT] [--category ID]
         [--character C --colour K | --omni] [--model M] [--rank R]
         [--planned-wave N [--planned-note T]]          prints the new bot's id
         [--worker-agent A] [--worker-model M] [--worker-effort E]   its workers' defaults
         [--worker-template T]          (an hc template: owns the command, so it wins)
  edit <bot> [the create options] [--unplanned] [--no-model] [--no-category] [--rank=]
             [--worker-agent=] [--worker-model=] [--worker-effort=] [--worker-template=]
                                (empty: cleared)
  rm <bot>
  category ls | add --title T [--sub S] [--id ID] | edit <id> [--title T] [--sub S]
           | rm <id> | order <id>...
  start <bot> [--space ID] [--tab ID]   a new pane on this computer (prints its terminal)
  restart <bot> [--fresh] [--agent A] [--model M [--save]] [--force]
                                the bot's agent again in its pane's place (same space and tab,
                                labels kept): the new pane starts, and the old one ends only once
                                the new one's agent has stayed up (prints the new terminal). It
                                resumes the conversation (claude --resume <session>, or --continue
                                when no other bot's Claude shares the folder; codex resume --last;
                                --continue for pi, omp, kimi, agy and hermes);
                                --fresh: a new one; --agent/--model: a swap (always new;
                                --save: also into ${BOTS_PATH}). Refused while the bot is
                                working or has helpers that would end with it, unless --force.
                                A bot not running is started.
  attach <bot> <terminal> [--move]   tie a running pane to the bot; a bot attached elsewhere
                                is refused unless --move (its old pane is detached first)
  detach <bot>                  untie the bot from its pane (a removed bot: by its id)
  whois <terminal> | whois --bot <bot>   who plays where, by the attach ledger
  history <bot>                 what the bot did, by the attach and workers ledgers: its panes,
                                starts, sessions (and the newest transcript) and workers
  brief <bot>                   print the bot's per-turn briefing as it would be now
  tidy                          what drifted in the window, labels and project list, as a plan;
                                changes nothing (--json: the plan's actions)
  worker "<task>" (--branch B [--base REF] | --worktree DIR)
         [[--agent A] [--model M] [--effort E] | --template T] [--name N]
         [--role dev|test|review|fix] [--task ID [--lead BOT]]
                                from a bot's pane: start one worker for the task, an hc
                                child of the bot in the task's worktree (prints its terminal);
                                --template runs an hc template, alone; --role defaults from
                                the bot's rank (tester: test, reviewer: review, fixer: fix,
                                else dev). One writer (dev, test, fix) per worktree, any bot;
                                reviewers run alongside. --task: Genie's short id (gl-231);
                                the worker is named <id>-<role>, a --branch must contain the
                                id, and --lead (default: this bot; a reviewer or fixer must
                                pass it) is the task's lead bot. A bot with a worker.swap
                                runs it on about one task in three, by rule
  update [--check | --rollback] install the latest release (checksum verified), only report
                                current and latest (--check), or put the replaced pack back;
                                an update then runs meter install where you agreed to it
                                (install.sh, or an earlier meter install); nobody asked: nowhere
  meter install [--machine M | --linked | --local]
                                the pinned usagemeter (v${USAGEMETER.version}, hash-checked on each
                                machine, never a downgrade) in ~/.local/bin on this computer and
                                every connected linked machine (hc machine ls); --machine: that
                                one, e.g. one linked later; --linked: the machines only; --local:
                                this computer only. A machine that fails is a warning. Running
                                it records your yes (--local: this computer only) for updates
  meter uninstall               remove it from the linked machines the pack put it on (the
                                install record says which), only where it is still that version

--rank R sets the pane's role= label, one of: ${RANKS.join(", ")}.
The main bot's pane is role=main, and a bot that leads others is role=captain, whatever their
rank. Start, attach, detach and an edit keep the panes' bot, role, category and squad labels
in step on this computer.

Which pane plays which bot is the attach ledger's answer (<app home>/automagik-herdr/attach.jsonl,
written by start, attach and detach only); the bot label is a display hint, and relabelling a
pane with hc label changes nothing.

A bot is its id or its name in the project. The project is the one the current folder
keys to (its git main checkout), or --project's. With --machine, --project is an absolute
folder on that machine and the file is read and written there by the same rule (a file
changed since it was read is never overwritten); its panes aren't tracked from here yet.`;

function readInstructions(opts) {
  if (opts.instructions !== undefined && opts["instructions-file"] !== undefined) throw new CliError("Give --instructions or --instructions-file, not both.", 2);
  let text = opts.instructions;
  if (opts["instructions-file"] !== undefined) {
    const f = opts["instructions-file"];
    try { text = readFileSync(f === "-" ? 0 : f, "utf8"); } catch (e) { throw new CliError(`Can't read ${f}: ${e?.message ?? e}`); }
    text = text.replace(/\n$/, "");
  }
  if (text !== undefined && text.length > MAX_INSTRUCTIONS) {
    throw new CliError(`Instructions are ${text.length} characters; the limit is ${MAX_INSTRUCTIONS}. Nothing was saved.`);
  }
  return text;
}

function checkModel(agent, model) {
  if (!agent) throw new CliError("A model pin needs a coding agent (--agent).", 2);
  const list = knownModels(agent, modelIo());
  if (!list.includes(model)) {
    throw new CliError(list.length ? `${model} isn't a known ${agent} model. Pick one of: ${list.join(", ")}.`
      : `There is no list of ${agent} models to pin from; leave the model unpinned (the running one is detected).`);
  }
}

/**
 * The entry create or edit writes: `base` (the stored raw entry, or a new one) with the
 * options given applied and checked against the project. Throws a CliError on a refusal.
 */
export function entryFrom(opts, base, project, { creating }) {
  const { file } = project;
  const entry = JSON.parse(JSON.stringify(base));
  if (opts.name !== undefined) {
    if (!opts.name.trim()) throw new CliError("A bot needs a name.", 2);
    entry.name = opts.name.trim();
  }
  if (!entry.name) throw new CliError("A bot needs a name (--name).", 2);
  const twin = file.bots.find((b) => b.id !== entry.id && b.name.toLowerCase() === entry.name.toLowerCase());
  if (twin) throw new CliError(`${twin.id} is already named "${twin.name}" in this project; names pick bots, so pick another.`);
  if (opts.kind !== undefined) {
    if (!KINDS.includes(opts.kind)) throw new CliError(`--kind is main or member, not "${opts.kind}".`, 2);
    entry.kind = opts.kind;
  }
  const main = mainBotOf(file);
  if (creating && !main && entry.kind !== "main") throw new CliError("The first bot in a project must be its main bot (--kind main).");
  if (entry.kind === "main" && main && main.id !== entry.id) throw new CliError(`This project already has a main bot, ${main.name} (${main.id}).`);
  if (opts.role !== undefined) entry.role = opts.role;
  entry.role ??= "";
  // Rank (A16): one of RANKS, for the pane's role= label; --rank= clears it (kept empty so
  // applyBotEdit removes the stored one).
  if (opts.rank !== undefined) {
    if (opts.rank !== "" && !RANKS.includes(opts.rank)) throw new CliError(`--rank is one of ${RANKS.join(", ")} (or --rank= to clear), not "${opts.rank}".`, 2);
    entry.rank = opts.rank;
  }
  const instructions = readInstructions(opts);
  if (instructions !== undefined) entry.instructions = instructions;
  entry.instructions ??= "";
  if (opts.agent !== undefined) {
    const agents = agentTable();
    const key = resolveAgent(opts.agent, agents);
    if (!key) throw new CliError(`"${opts.agent}" isn't a coding agent Herdr knows. Known: ${Object.keys(agents).join(", ")}.`);
    entry.agent = key;
  }
  // Planned (A3): a wave and an optional note; --unplanned clears it.
  if (opts.unplanned && opts["planned-wave"] !== undefined) throw new CliError("Give --planned-wave or --unplanned, not both.", 2);
  if (opts.unplanned) delete entry.planned;
  if (opts["planned-wave"] !== undefined) {
    const wave = Number(opts["planned-wave"]);
    if (!Number.isInteger(wave) || wave < 1) throw new CliError("--planned-wave is a positive whole number.", 2);
    entry.planned = plannedOf(entry.planned, wave, opts["planned-note"] ?? entry.planned?.note);
  } else if (opts["planned-note"] !== undefined) {
    if (!entry.planned) throw new CliError("--planned-note goes with --planned-wave.", 2);
    entry.planned = plannedOf(entry.planned, entry.planned.wave, opts["planned-note"]);
  }
  if (!entry.agent && !entry.planned) throw new CliError("A bot needs a coding agent (--agent), unless it is planned.", 2);
  // Model pin (A12): from the agent's list, never free text.
  if (opts.model !== undefined && opts["no-model"]) throw new CliError("Give --model or --no-model, not both.", 2);
  if (opts["no-model"]) delete entry.model;
  if (opts.model !== undefined) { checkModel(entry.agent, opts.model); entry.model = opts.model; }
  else if (entry.model && opts.agent !== undefined && !knownModels(entry.agent, modelIo()).includes(entry.model)) {
    throw new CliError(`${entry.name} is pinned to ${entry.model}, which ${entry.agent} doesn't list; pass --model or --no-model.`);
  }
  workerDefaults(opts, entry);
  // Lead (A1): the main bot or another non-planned member, never itself or one of its own.
  if (opts.lead !== undefined) {
    if (entry.kind === "main") throw new CliError("A main bot has no lead.", 2);
    const lead = findBot(file, opts.lead);
    if (lead.id === entry.id) throw new CliError(`${entry.name} can't lead itself.`);
    if (lead.planned) throw new CliError(`${lead.name} is planned, so it can't lead a bot yet.`);
    if (!creating && descendantsOf(file, entry.id).has(lead.id)) throw new CliError(`${lead.name} reports to ${entry.name}, so it can't be its lead.`);
    entry.lead = lead.id;
  }
  if (entry.kind === "main") delete entry.lead;
  // Category (A2): only for a bot whose lead is the main bot.
  if (opts.category !== undefined && opts["no-category"]) throw new CliError("Give --category or --no-category, not both.", 2);
  if (opts["no-category"]) delete entry.category;
  if (opts.category !== undefined) {
    const leadsToMain = entry.kind === "member" && (!entry.lead || entry.lead === main?.id);
    if (!leadsToMain) throw new CliError("A category goes only on a member that reports to the main bot.", 2);
    entry.category = findCategory(file, opts.category).id;
  }
  // Look: --omni, or a character and colour (one left out keeps the stored or default one).
  const colour = opts.colour ?? opts.color;
  if (opts.omni && (opts.character !== undefined || colour !== undefined)) throw new CliError("Give --omni or --character/--colour, not both.", 2);
  if (opts.character !== undefined && !CHARACTERS.includes(opts.character)) throw new CliError(`Unknown character "${opts.character}". Characters: ${CHARACTERS.join(", ")}.`, 2);
  if (colour !== undefined && !COLOURS.includes(colour)) throw new CliError(`Unknown colour "${colour}". Colours: ${COLOURS.join(", ")}.`, 2);
  const look = entry.look && typeof entry.look === "object" ? entry.look : defaultLook(entry.id);
  if (opts.omni) entry.look = { ...OMNI_LOOK };
  else entry.look = { character: opts.character ?? look.character, colour: colour ?? look.colour };
  return entry;
}

/**
 * The bot's worker defaults (`worker: { agent?, model?, effort?, template? }`) from
 * --worker-agent, --worker-model, --worker-effort and --worker-template; an empty value clears
 * that one. A template is an hc template name; it isn't looked up here (edit runs anywhere). The agent is canonical
 * (`claude-code` is stored as `claude`); a model must be on the worker agent's list when it
 * has one (an agent with no list takes any model: workers' models are swap-test data).
 */
function workerDefaults(opts, entry) {
  const given = ["agent", "model", "effort", "template"].filter((k) => opts[`worker-${k}`] !== undefined);
  if (!given.length) return;
  const w = entry.worker && typeof entry.worker === "object" && !Array.isArray(entry.worker) ? { ...entry.worker } : {};
  const agentText = opts["worker-agent"];
  if (agentText === "") delete w.agent;
  else if (agentText !== undefined) {
    const agents = agentTable();
    const key = resolveAgent(agentText, agents);
    if (!key) throw new CliError(`--worker-agent: "${agentText}" isn't a coding agent Herdr knows. Known: ${Object.keys(agents).join(", ")}.`, 2);
    w.agent = key;
  }
  const effort = opts["worker-effort"];
  if (effort === "") delete w.effort;
  else if (effort !== undefined) {
    if (!EFFORT_SHAPE.test(effort)) throw new CliError(`--worker-effort: "${effort}" isn't an effort level (low, medium, high, …).`, 2);
    w.effort = effort;
  }
  const template = opts["worker-template"];
  if (template === "") delete w.template;
  else if (template !== undefined) {
    if (!TEMPLATE_SHAPE.test(template)) throw new CliError(`--worker-template: "${template}" isn't an hc template name (letters, digits, ".", "_" and "-", no dash first).`, 2);
    w.template = template;
  }
  const model = opts["worker-model"];
  if (model === "") delete w.model;
  else if (model !== undefined) {
    if (optionLike(model)) throw new CliError(`--worker-model: "${model}" starts with a dash, so an agent would read it as an option.`, 2);
    const agent = w.agent ?? entry.agent;
    const list = agent ? knownModels(agent, modelIo()) : [];
    if (list.length && !list.includes(model)) throw new CliError(`--worker-model: ${model} isn't a known ${agent} model. Pick one of: ${list.join(", ")}.`);
    w.model = model;
  }
  entry.worker = w; // empty: applyBotEdit removes it
}

// ---- commands ----

async function projectFor(opts) {
  if (opts.machine !== undefined) return loadRemoteProject(await remoteKeyOf(opts), opts.machine);
  return loadProject(await commandKeyOf(opts));
}
// The commands that take --machine: the definitions ones (and meter's own --machine).
const ON_MACHINE = new Set(["ls", "show", "create", "edit", "rm", "category", "meter"]);
// A project's place in --json answers: `machine` only for a linked machine's.
const placeOf = (project) => ({ project: project.key, ...(project.machine ? { machine: project.machine } : {}) });

// The projects the sidebar shows with no space open: its remembered list, then this CLI's.
function rememberedKeys() {
  let keys = [];
  try {
    // The sidebar's remembered projects: am.* since the rename, else the old key (read only).
    const held = JSON.parse(readText(`${appHome()}/shared.json`) ?? "{}");
    const list = held?.["am.sidebar.projects"] ?? held?.[renamedFrom(SHARED_RENAMES, "am.sidebar.projects")];
    keys = Array.isArray(list) ? list.filter((p) => typeof p?.key === "string" && !p.machine).map((p) => p.key) : [];
  } catch { /* unreadable: none */ }
  let listed = [];
  try { listed = listedProjects(readText(`${appHome()}/${PROJECTS_FILE}`)); } catch { /* unreadable: none */ }
  return [...new Set([...keys, ...listed])];
}

async function cmdLs(opts) {
  if (opts.machine !== undefined) {
    if (opts.all) throw new CliError("ls --all lists this computer's projects; give --machine without --all.", 2);
    const project = await projectFor(opts);
    const bots = project.file.bots.map((b) => describe(project, b, null, null));
    const one = { ...placeOf(project), categories: project.file.categories, warnings: project.warnings, bots };
    return opts.json ? { projects: [one] } : lsLines([one]);
  }
  const keys = [await commandKeyOf(opts)];
  if (opts.all) for (const k of rememberedKeys()) if (!keys.includes(k)) keys.push(k);
  const projects = [];
  const { view, hcError } = await viewOrError();
  for (const key of keys) {
    let project;
    try { project = loadProject(key); } catch (e) { projects.push({ project: key, error: e.message, categories: [], bots: [], warnings: [] }); continue; }
    if (project.text === null && opts.all && key !== keys[0]) continue; // a remembered project whose file is gone
    const bots = project.file.bots.map((b) => describe(project, b, view, hcError));
    projects.push({ project: key, categories: project.file.categories, warnings: project.warnings, bots });
  }
  if (opts.json) return { projects };
  return lsLines(projects);
}

function lsLines(projects) {
  const lines = [];
  for (const p of projects) {
    lines.push(`${p.project}${p.machine ? ` on ${p.machine}` : ""}${p.error ? `  (${p.error})` : ""}`);
    if (!p.bots.length && !p.error) lines.push("  no bots");
    for (const b of p.bots) {
      const where = b.kind === "main" ? "main" : `→ ${b.leadName ?? "?"}${b.category ? ` [${b.category}]` : ""}`;
      const model = b.model ? `${b.model} (${b.modelSource})` : "-";
      const status = b.planned ? `planned, wave ${b.planned.wave}` : b.terminal ? `${b.status} in ${b.terminal}` : b.status;
      lines.push(`  ${b.id}  ${b.name}${b.rank ? ` (${b.rank})` : ""}  ${where}  ${b.agent ?? "-"}  ${model}  ${status}${b.warning ? `  ! ${b.warning}` : ""}`);
    }
    for (const w of p.warnings ?? []) lines.push(`  ! ${w}`);
    const hcError = p.bots.find((b) => b.hcError)?.hcError;
    if (hcError) lines.push(`  ! panes unknown: ${hcError}`);
    if (p.machine) lines.push(`  (panes on ${p.machine} aren't tracked from this computer yet)`);
  }
  return lines.join("\n");
}

/** A bot's worker defaults (or its swap arm) as one line: `agent codex · model gpt-5.5 · effort high`. */
const workerText = (w) => (w ? ["template", "agent", "model", "effort"].filter((k) => typeof w[k] === "string" && w[k])
  .map((k) => `${k} ${w[k]}`).join(" · ") : "");

async function cmdShow(opts, [ref]) {
  const project = await projectFor(opts);
  const bot = findBot(project.file, ref);
  const { view, hcError } = project.machine ? { view: null, hcError: null } : await viewOrError();
  const info = { ...describe(project, bot, view, hcError), instructions: bot.instructions };
  if (opts.json) return info;
  return [
    `${info.name} (${info.id})`, `  project      ${info.project}${info.machine ? ` on ${info.machine}` : ""}`, `  kind         ${info.kind}`,
    ...(info.lead ? [`  lead         ${info.leadName} (${info.lead})`] : []),
    ...(info.category ? [`  category     ${info.category}`] : []),
    ...(info.planned ? [`  planned      wave ${info.planned.wave}${info.planned.note ? ` · ${info.planned.note}` : ""}`] : []),
    `  agent        ${info.agent ?? "-"}`, `  model        ${info.model ? `${info.model} (${info.modelSource})` : "-"}${info.pinnedModel && info.modelSource !== "pinned" ? `, pinned ${info.pinnedModel}` : ""}`,
    `  status       ${info.status}${info.terminal ? ` in ${info.terminal} (since ${info.since})` : ""}`,
    `  look         ${info.look.character} in ${info.look.colour}`, `  role         ${info.role || "-"}`,
    `  rank         ${info.rank ?? "-"}`,
    `  worker       ${workerText(info.worker) || "-"}`,
    ...(info.worker?.swap ? [`  swap         ${workerText(info.worker.swap)} (planned swaps: about 1 task in 3)`] : []),
    ...(info.warning ? [`  warning      ${info.warning}`] : []),
    "  instructions", ...(info.instructions ? info.instructions.split("\n").map((l) => `    ${l}`) : ["    -"]),
  ].join("\n");
}

// ---- A16 pane labels (launchArgs.js): this computer's panes only ----

/** The `hc get` of a bot's attached live pane on this computer, as a list (launchArgs relabel's io.rows). */
async function liveRows(botId) {
  const get = await attachedGet(botId);
  return get ? [get] : [];
}
const labelIo = { rows: liveRows, label: async (address, words) => (await hc(["label", address, ...words])).code === 0 };

/**
 * After a write, the live local panes of every bot whose labels the edit changed (rank, lead
 * or category, and a lead's captain status) get them rewritten, by launchArgs.js relabel as
 * the sidebar does. The file is saved already, so a failure only warns. Resolves with the
 * terminals relabelled.
 */
async function relabelAfter(beforeFile, afterRaw) {
  let afterFile;
  try { afterFile = parseBots(JSON.stringify(afterRaw)).file; } catch { return []; }
  const out = await relabel(relabelPlan(beforeFile, afterFile), labelIo);
  const warning = relabelWarning(out);
  if (warning) report([warning]);
  return out.done;
}

async function cmdCreate(opts) {
  const project = await projectFor(opts);
  const id = newBotId();
  const entry = entryFrom(opts, { id, kind: mainBotOf(project.file) ? "member" : "main" }, project, { creating: true });
  const raw = applyBotEdit(project.raw, entry);
  await saveProject(project, raw);
  // A lead that becomes a captain; another machine's panes are left as they are.
  const relabelled = project.machine ? [] : await relabelAfter(project.file, raw);
  return opts.json ? { id, ...placeOf(project), bot: entry, relabelled } : id;
}

async function cmdEdit(opts, [ref]) {
  const project = await projectFor(opts);
  const bot = findBot(project.file, ref);
  const stored = project.raw.bots.find((b) => b?.id === bot.id);
  const entry = entryFrom(opts, stored, project, { creating: false });
  const raw = applyBotEdit(project.raw, entry);
  await saveProject(project, raw);
  const relabelled = project.machine ? [] : await relabelAfter(project.file, raw);
  return opts.json ? { id: bot.id, ...placeOf(project), bot: entry, relabelled } : `${entry.name} (${bot.id}) saved.`;
}

async function cmdRm(opts, [ref]) {
  const project = await projectFor(opts);
  const { file } = project;
  const bot = findBot(file, ref);
  // Its pane by the ledger, read before the write (the import, on a first run, needs the bot
  // still defined). hc missing or failing only drops the note.
  let holders = [];
  if (!bot.planned && !project.machine) {
    try { const held = (await attachView()).live.get(bot.id); holders = held ? [held.binding.terminal] : []; } catch (e) {
      if (e instanceof LedgerRefusal) throw e;
      holders = [];
    }
  }
  // Every other entry as stored, those parseBots left out included: they are still bots.
  const others = project.raw.bots.filter((b) => b?.id !== bot.id);
  if (bot.kind === "main" && others.length) {
    throw new CliError(`${bot.name} is the main bot and its project still has ${others.length} other bot${others.length > 1 ? "s" : ""}; remove them first.`);
  }
  const team = [...descendantsOf(file, bot.id)].map((id) => file.bots.find((b) => b.id === id)?.name ?? id);
  const leads = others.filter((b) => b?.lead === bot.id).map((b) => b.name ?? b.id);
  if (team.length || leads.length) throw new CliError(`${bot.name} leads ${[...new Set([...leads, ...team])].join(", ")}; give them another lead first (automagik-herdr edit <bot> --lead …).`);
  const raw = JSON.parse(JSON.stringify(project.raw));
  raw.bots = raw.bots.filter((b) => b?.id !== bot.id);
  // Only an empty list deletes the file; anything else must pass checkBots (a file left
  // with members and no main bot is refused, never deleted).
  const last = raw.bots.length === 0;
  await saveProject(project, last ? null : raw, { list: false });
  if (!last && !project.machine) await relabelAfter(file, raw); // its lead may stop being a captain
  const notes = [];
  if (last) notes.push(`${bot.name} was the project's last bot: ${fileName(project)} was deleted.`);
  if (holders.length) notes.push(`${holders.join(", ")} is still attached to it; detach it with: automagik-herdr detach ${bot.id}`);
  for (const n of notes) process.stderr.write(`automagik-herdr: ${n}\n`);
  return opts.json ? { removed: bot.id, ...placeOf(project), deletedFile: last, attachedTerminals: holders } : `${bot.name} (${bot.id}) removed.`;
}

async function cmdCategory(opts, [verb, ...rest]) {
  const project = await projectFor(opts);
  const raw = JSON.parse(JSON.stringify(project.raw));
  raw.categories = Array.isArray(raw.categories) ? raw.categories : [];
  const save = async () => {
    if (project.text === null) throw new CliError("This project has no bots yet; create its main bot first.");
    await saveProject(project, raw);
  };
  const find = (ref) => {
    const hit = findCategory(project.file, ref);
    return raw.categories.find((c) => c?.id === hit.id);
  };
  if (verb === "ls" || verb === undefined) {
    const list = project.file.categories.map((c) => ({ ...c, bots: project.file.bots.filter((b) => b.category === c.id).map((b) => b.id) }));
    return opts.json ? { ...placeOf(project), categories: list } : list.map((c) => `${c.id}  ${c.title}${c.sub ? ` · ${c.sub}` : ""}  (${c.bots.length} bot${c.bots.length === 1 ? "" : "s"})`).join("\n") || "no categories";
  }
  if (verb === "add") {
    if (!opts.title?.trim()) throw new CliError("A category needs a title (--title).", 2);
    const id = opts.id ?? newCategoryId(opts.title, raw.categories);
    if (!CATEGORY_ID.test(id)) throw new CliError(`--id "${id}" isn't a category id: a lowercase slug (a-z, 0-9, single dashes), as it goes into a pane's category= label.`, 2);
    if (raw.categories.some((c) => c?.id === id)) throw new CliError(`Category ${id} is there already.`);
    const cat = { id, title: opts.title.trim() };
    if (opts.sub?.trim()) cat.sub = opts.sub.trim();
    raw.categories.push(cat);
    await save();
    return opts.json ? { ...placeOf(project), category: cat } : id;
  }
  if (verb === "edit") {
    const cat = find(rest[0]);
    if (opts.title !== undefined) { if (!opts.title.trim()) throw new CliError("A category's title can't be empty.", 2); cat.title = opts.title.trim(); }
    if (opts.sub !== undefined) { if (opts.sub.trim()) cat.sub = opts.sub.trim(); else delete cat.sub; }
    await save();
    return opts.json ? { ...placeOf(project), category: cat } : `${cat.id} saved.`;
  }
  if (verb === "rm") {
    const cat = find(rest[0]);
    const users = project.file.bots.filter((b) => b.category === cat.id).map((b) => b.name);
    if (users.length) throw new CliError(`${users.join(", ")} ${users.length > 1 ? "are" : "is"} in ${cat.id}; move them first (automagik-herdr edit <bot> --category … or --no-category).`);
    raw.categories = raw.categories.filter((c) => c?.id !== cat.id);
    await save();
    return opts.json ? { ...placeOf(project), removed: cat.id } : `${cat.id} removed.`;
  }
  if (verb === "order") {
    if (!rest.length) throw new CliError("Name the categories in their new order.", 2);
    const ids = rest.map((r) => find(r).id);
    if (new Set(ids).size !== ids.length) throw new CliError("A category is named twice.", 2);
    raw.categories = [...ids.map((id) => raw.categories.find((c) => c?.id === id)), ...raw.categories.filter((c) => !ids.includes(c?.id))];
    await save();
    return opts.json ? { ...placeOf(project), categories: raw.categories.map((c) => c.id) } : raw.categories.map((c) => c.id).join(" ");
  }
  throw new CliError(`category ${verb}: unknown; use ls, add, edit, rm or order.`, 2);
}

const report = (warnings) => { for (const w of warnings) process.stderr.write(`automagik-herdr: ${w}\n`); };

/**
 * Appends one row to the workers ledger (workers.js) with a single O_APPEND write. The
 * terminal runs already, so a failure only comes back as a warning; null when written.
 */
export function appendLedger(row, appHomeDir = appHome()) {
  const path = ledgerPath(appHomeDir);
  try {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    const fd = openSync(path, "a");
    try { writeSync(fd, ledgerLine(row)); } finally { closeSync(fd); }
    return null;
  } catch (e) {
    return `${row.terminal} runs, but it isn't in ${LEDGER_FILE}, so its usage won't be tied to it: ${e?.message ?? e}`;
  }
}
/** A terminal's foreground pid from `hc get`, or null (hc failing, or no pid yet). */
async function pidOf(terminal) {
  try { const get = await hcGet(terminal); return get?.foreground?.pid ?? get?.pid ?? null; } catch { return null; }
}

/**
 * Where Herdr shows a bot started here (DESIGN: the space whose folder keys to the project):
 * the `herdr.space` / `herdr.tab` labels of a live terminal on this computer whose folder
 * keys to the project, while the window (herdr-app ls) shows the project in that space: a
 * caller's tab in another space never takes the bot. Else the window's space on the project, in
 * its selected tab. Null when none does; the pane then has no place in Herdr's window. `seen`:
 * windowSpaces(), read once by the caller; null (no window to ask): the first labelled
 * terminal's place.
 */
async function placementOf(key, seen = null) {
  const rows = rowsOf(await hcJson(["ls"])).filter((r) => local(r?.address) && r.state === "live" && typeof r.cwd === "string");
  const keys = new Map();
  await Promise.all([...new Set(rows.map((r) => r.cwd))].map(async (cwd) => {
    try { keys.set(cwd, await keyOf(cwd)); } catch { /* a folder gone: not this project */ }
  }));
  const mine = rows.filter((r) => keys.get(r.cwd) === key);
  const shows = (place) => !seen || spacePlace(seen.spaces.filter((s) => s.id === place.space), seen.keys, key) !== null;
  for (const r of mine) {
    const place = placementFrom([await hcGet(r.address)].filter(Boolean));
    if (place && shows(place)) return place;
  }
  if (seen) return spacePlace(seen.spaces, seen.keys, key);
  return null;
}

/** `herdr-app ls` as State spaces (spacesOf) and each folder's key, or null: no herdr-app, no window. */
async function windowSpaces() {
  const r = await runProgram("herdr-app", ["ls"]);
  let spaces;
  try { spaces = r.code === 0 ? spacesOf(JSON.parse(r.stdout)) : null; } catch { spaces = null; }
  if (!spaces) return null;
  const keys = new Map();
  await Promise.all([...new Set(spaces.map((s) => s.folder).filter(Boolean))].map(async (f) => {
    try { keys.set(f, await keyOf(f)); } catch { /* a folder gone: not this project */ }
  }));
  return { spaces, keys };
}

/**
 * Where a start with no --space goes: a project terminal's place (placementOf) while the window
 * still shows that space, else a window space on the project, else a new one (herdr-app do
 * space.new, named after the folder). With no window to ask, the terminal's place, or null.
 * `seen`: windowSpaces(), read once per start and shared with placementOf.
 * Two starts at once can each open one: both then use the first space on the project in the
 * window, and the one that opened another closes it (it holds only its new shell).
 */
async function windowPlace(key, labelled = null, seen = null) {
  if (!seen) return labelled;
  if (labelled && seen.spaces.some((s) => s.id === labelled.space)) return labelled;
  // This ls is the check right before space.new: nothing else runs between them.
  const open = spacePlace(seen.spaces, seen.keys, key);
  if (open) return open;
  const name = key.replace(/\/+$/, "").split("/").pop();
  const r = await runProgram("herdr-app", ["do", "space.new", JSON.stringify({ name, folder: key, machine: "" })]);
  if (r.code !== 0) return null;
  let out = {};
  try { out = JSON.parse(r.stdout) ?? {}; } catch { /* the space is found in ls instead */ }
  const now = await windowSpaces();
  const first = now && spacePlace(now.spaces, now.keys, key);
  const ours = now?.spaces.find((s) => s.id === out.space || s.tabs.some((t) => t.panes.some((p) => p.terminal === out.terminal)));
  if (first && ours && ours.id !== first.space) {
    await runProgram("herdr-app", ["do", "space.close", JSON.stringify({ id: ours.id, confirmed: true })]);
  }
  return first || (typeof out.space === "string" ? { space: out.space, tab: null, from: null } : null);
}

async function cmdStart(opts, [ref]) {
  if (opts.tab && !opts.space) throw new CliError("--tab needs --space (the space that tab is in).", 2);
  const project = await projectFor(opts);
  const { file, key } = project;
  if (project.text === null) throw new CliError(`No ${BOTS_PATH} in ${key}.`);
  const bot = findBot(file, ref);
  const why = startRefusal(file, bot.id);
  if (why) throw new CliError(why);
  // launch.js checks the folder Start launches in against the project (attachRefusal on
  // keyOf(projectKey)). Here that folder is `key`, which keyOf already returned, and a key
  // keys to itself, so the check can't refuse: it is left out, not forgotten.
  // One terminal plays a bot: the one the attach ledger names is reported, never a second
  // start (decided again under the ledger's lock, below, with hc run).
  const view = await attachView();
  const held = view.live.get(bot.id);
  if (held) return opts.json ? { id: bot.id, running: held.binding.terminal } : `${bot.name} is already running in ${held.binding.terminal}.`;
  const seat = await launchSeat(project, bot, { place: opts.space ? { space: opts.space, tab: opts.tab ?? null, from: null } : undefined });
  if (seat.running) return opts.json ? { id: bot.id, running: seat.running } : `${bot.name} is already running in ${seat.running}.`;
  return opts.json ? seatJson(bot, seat) : seat.terminal;
}

/** The agent a bot starts on, from Herdr's table: refused when it isn't one, or isn't installed. */
function startableAgent(bot, agentKey = bot.agent) {
  const agent = agentTable()[agentKey];
  if (!agent?.run?.length) throw new CliError(`${bot.name}'s coding agent "${agentKey}" isn't one Herdr can start.`);
  if (!onPath(agent.run[0])) throw new CliError(`${agent.name} (${agent.run[0]}) isn't installed on this computer.`);
  return agent;
}

const seatJson = (bot, seat) => ({ id: bot.id, terminal: seat.terminal, parent: seat.parent[0] === "--parent" ? seat.parent[1] : null, argv: seat.argv,
  labels: seat.labels, space: seat.place?.space ?? null, tab: seat.place?.tab ?? null, hookWritten: seat.hook.written, warnings: seat.hook.warnings });

/**
 * Starts a bot's pane on this computer (Start, and Restart's replacement): the agent and its
 * model pin, the A1 parent, the A16 labels, the place in Herdr's window, the briefing hook, the
 * attach row (by "start", under the ledger's lock) and the seat row. `over` (Restart): `argv`
 * (the whole command, checked by the caller), `agent`, `model`, `cwd`, `place` (undefined:
 * placementOf the project), `carry` (labels kept from the old pane), `replacing` (the old pane's
 * binding: hc run alone, past the "already running" check; the attach rows are restart's, once
 * the new pane has stayed up, and the seat row is left to `logSeat()`). Resolves { terminal,
 * created_ms, parent, argv, labels, place, hook, logSeat }, or { running } when the ledger
 * names another terminal for the bot by the time the lock is taken.
 */
async function launchSeat(project, bot, over = {}) {
  const { file, key } = project;
  const agentKey = over.agent ?? bot.agent;
  const model = over.argv ? (over.model ?? null) : bot.model;
  // A12: a pin that isn't one of the agent's listed models (an old free-text model) is refused.
  if (!over.argv && bot.model && !knownModels(bot.agent, modelIo()).includes(bot.model)) {
    throw new CliError(`${bot.name} is pinned to "${bot.model}", which isn't a ${bot.agent} model this computer lists. `
      + `Pick one with automagik-herdr edit ${bot.id} --model <model> (the error lists them), or clear it with --no-model.`);
  }
  const agent = startableAgent(bot, agentKey);
  // A1: the effective lead's live terminal as parent, outliving it; the main bot has none.
  const lead = bot.kind === "member" ? effectiveLead(file, bot.id).lead : "";
  const leadGet = lead ? await attachedGet(lead) : null;
  const leadLive = leadGet?.address ?? null;
  const parent = parentArgs(file, bot.id, (id) => (id === lead ? leadLive : null));
  const carry = over.carry ?? {};
  const labels = { ...paneLabels(file, bot.id, carry, lead ? leadPane(await liveRows(lead))?.labels ?? null : null), ...carry }; // A16
  const taken = new Set(rowsOf(await hcJson(["ls"])).map((r) => r?.name).filter(Boolean));
  const argv = over.argv ?? [...agent.run, ...modelArgs(bot.agent, bot.model)];
  // As a worker (cmdWorker): an npm agent (#!/usr/bin/env node, like codex) gets its interpreter's
  // folder first on PATH when this PATH lacks it (#56); start and restart both come here. PATH is
  // passed only when that changes it, so any other seat runs as before.
  const runPath = interpreterPath(argv[0], process.env.PATH);
  const path = runPath.path !== process.env.PATH ? runPath.path : null;
  const cwd = over.cwd ?? key;
  // A restart's own place (the old pane's space and tab) stands; a start asks the window too:
  // one herdr-app ls, shared by placementOf (a label whose space doesn't show the project is
  // dropped) and windowPlace (an open space on the project, else a new one).
  let place = over.place;
  if (place === undefined) {
    const seen = await windowSpaces();
    place = await windowPlace(key, await placementOf(key, seen), seen);
  }
  const args = startArgs({ botId: bot.id, name: hcName(bot.name, bot.id, taken), cwd, space: place?.space, tab: place?.tab, parent, argv, labels, path });
  // The hook goes in before the session starts, so Claude Code reads it at startup.
  const hook = agentKey === "claude" ? await writeBriefingHook(bot, cwd) : { written: false, warnings: [] };
  if (runPath.note) hook.warnings.unshift(runPath.note);
  report(hook.warnings);
  const run = async (ledger) => {
    const r = await hc(args);
    if (r.code !== 0) throw new CliError(`hc run failed: ${(r.stderr || r.stdout).trim()}`);
    let address = null;
    try { address = JSON.parse(r.stdout).address ?? null; } catch { address = null; }
    if (!address) throw new CliError(`hc run gave no terminal address: ${r.stdout.trim()}`);
    const get = await hcGet(address).catch(() => null);
    if (ledger) {
      if (!Number.isSafeInteger(get?.created_ms)) {
        throw new CliError(`${address} runs, but hc get gave no created_ms, so it has no attach row: attach it with automagik-herdr attach ${bot.id} ${address}`);
      }
      try { ledger.write([attachRow({ event: "attach", bot: bot.id, project: key, terminal: address, core: ledger.core, created_ms: get.created_ms, by: "start" })]); } catch (e) {
        throw new CliError(`${address} runs, but its attach row wasn't written (${e?.message ?? e}): attach it with automagik-herdr attach ${bot.id} ${address}`);
      }
    }
    return { terminal: address, created_ms: get?.created_ms ?? null, pid: get?.foreground?.pid ?? get?.pid ?? null };
  };
  // Start: under the ledger's lock, still unattached, then hc run and the attach row (by
  // "start"). Restart: hc run alone (the old pane still holds the bot).
  const started = over.replacing ? await run(null) : await underLedger(async ({ core, byBot, holds, write }) => {
    const now = await holds(byBot.get(bot.id));
    if (now) return { running: now.binding.terminal };
    return run({ core, write });
  });
  if (started.running) return { running: started.running };
  const { terminal } = started;
  // Restart writes the seat row only once the pane has proved itself.
  const logSeat = async () => {
    const unlogged = appendLedger(startRow({ kind: "seat", terminal, pid: started.pid ?? await pidOf(terminal), botId: bot.id, worktree: cwd,
      project: key, agent: agentKey, model }));
    if (unlogged) { hook.warnings.push(unlogged); report([unlogged]); }
  };
  if (!over.replacing) await logSeat();
  listProject(key);
  // An edit that landed while this Start ran: the file read again, its role and category
  // put on the new pane (relabelWords against the labels it started with).
  try {
    const fresh = loadProject(key).file;
    if (fresh.bots.some((b) => b.id === bot.id && !b.planned)) {
      const words = relabelWords(labels, paneLabels(fresh, bot.id), labels);
      if (words.length && (await hc(["label", terminal, ...words])).code !== 0) {
        const warning = `${terminal}'s labels ${words.join(" ")} weren't set.`;
        hook.warnings.push(warning);
        report([warning]); // the hook's warnings were printed before hc run
      }
    }
  } catch { /* the file can't be read now: the labels it started with stand */ }
  if (!place) {
    hook.warnings.push(`No open Herdr space shows ${key}, so Herdr gives ${terminal} no pane: it runs, unseen. `
      + `Watch it with hc attach ${terminal}. To give the next start a pane, open a space on ${key} first, or pass --space <id> (herdr-app ls lists the ids).`);
    report(hook.warnings.slice(-1));
  }
  return { terminal, created_ms: started.created_ms, parent, argv, labels, place, hook, logSeat };
}

// ---- restart: the bot's agent again, in its pane's place ----

/** How long Restart gives the replacement to prove itself before it gives up on it. */
const RESTART_WAIT_MS = Number(process.env.AUTOMAGIK_HERDR_RESTART_WAIT_MS) || 30_000;
/**
 * How long the replacement's agent must stay in front, every check, before the old pane ends:
 * an agent is in front at once and only then reads its arguments (claude --resume with a stale
 * id, --continue with no conversation, a swap to an agent that fails at startup exit in 1-3s).
 * An agent that reports its own status to hc (`reported`) has started its session: a shorter
 * settle then.
 */
const RESTART_STABLE_MS = Number(process.env.AUTOMAGIK_HERDR_RESTART_STABLE_MS) || 5000;
const RESTART_SETTLE_MS = Math.min(1500, RESTART_STABLE_MS);
const later = (ms) => new Promise((go) => setTimeout(go, ms));

/**
 * Waits until `terminal` has had an agent in front (Decision 3's live rule) at every check for
 * RESTART_STABLE_MS (RESTART_SETTLE_MS once it reports): { state: "live" | "ended" | "late",
 * get }. "ended": its program exited (a resume that found nothing, say).
 */
async function agentUp(terminal, ms = RESTART_WAIT_MS) {
  const until = Date.now() + ms;
  let since = null;
  for (;;) {
    const get = await hcGet(terminal);
    if (!get || get.state === "finished") return { state: "ended", get };
    if (get.state === "live" && agentInForeground(get)) {
      since ??= Date.now();
      if (Date.now() - since >= (get.reported === true ? RESTART_SETTLE_MS : RESTART_STABLE_MS)) return { state: "live", get };
    } else since = null;
    if (Date.now() >= until) return { state: "late", get };
    await later(250);
  }
}

/** The workers ledger's rows ([] when it can't be read). */
function workerLedgerRows() {
  try { return readLedger(readText(ledgerPath(appHome())) ?? ""); } catch { return []; }
}

/**
 * Other bots' live Claude panes whose folder is `cwd`, by the attach ledger (`view`,
 * attachView): [{ address, name }].
 */
function claudeBotsIn(view, cwd, botId, file) {
  return [...view.live.values()].filter(({ binding, get }) => binding.bot !== botId && get && agentInForeground(get)
    && (get.foreground?.cwd ?? get.cwd) === cwd && (isClaude(null, get) || agentKeyOfArgv(get.foreground?.argv) === "claude"))
    .map(({ binding }) => ({ address: binding.terminal, name: file.bots.find((b) => b.id === binding.bot)?.name ?? `bot ${binding.bot}` }));
}

/**
 * The attach rows of a restart, under the ledger's lock, once the new pane has stayed up: the
 * old binding detached (by "start", "moved"), then the new terminal attached (by "start").
 * When the ledger no longer names the old binding (another CLI attached or moved the bot
 * meanwhile) nothing is written: { lost: the terminal it names, or null }. With the old pane
 * already ended (its end row written), the new one is attached alone.
 */
async function attachMoved(bot, oldBinding, terminal, created_ms, key) {
  return underLedger(async ({ core, byBot, holds, write }) => {
    const now = byBot.get(bot.id);
    const rows = [];
    if (now && attachKey(now) === attachKey(oldBinding)) rows.push(closingRow(oldBinding, "detach", "start", "moved"));
    else if (now && (await holds(now))) return { lost: now.terminal };
    rows.push(attachRow({ event: "attach", bot: bot.id, project: key, terminal, core, created_ms, by: "start" }));
    write(rows);
    return { lost: undefined };
  });
}

/** What cmdRestart returns once it has printed its own answer (a bot restarting itself). */
export const PRINTED = Symbol.for("automagik-herdr.printed");

/** The live terminals whose hc parent is `address`, as hc get answers (they may end with it). */
async function helpersOf(address) {
  const rows = rowsOf(await hcJson(["ls"])).filter((r) => r?.parent === address && r.state !== "finished" && r.address);
  return (await Promise.all(rows.map((r) => hcGet(r.address)))).filter(Boolean);
}

async function cmdRestart(opts, [ref]) {
  if (opts.tab && !opts.space) throw new CliError("--tab needs --space (the space that tab is in).", 2);
  const swap = opts.agent !== undefined || opts.model !== undefined;
  if (opts.save && !swap) throw new CliError("--save keeps a swap in the bot's definition; it goes with --agent or --model.", 2);
  const project = await projectFor(opts);
  const { file, key } = project;
  if (project.text === null) throw new CliError(`No ${BOTS_PATH} in ${key}.`);
  const bot = findBot(file, ref);
  const why = startRefusal(file, bot.id);
  if (why) throw new CliError(why);
  // A swap's agent and model are checked as an edit checks them (entryFrom); a new agent
  // without --model drops the old agent's pin. bots.json changes only with --save.
  let entry = null;
  if (swap) {
    const stored = project.raw.bots.find((b) => b?.id === bot.id);
    const target = opts.agent !== undefined ? resolveAgent(opts.agent, agentTable()) : bot.agent;
    const edit = { agent: opts.agent, model: opts.model };
    if (opts.model === undefined && target !== bot.agent) edit["no-model"] = true;
    entry = entryFrom(edit, stored, project, { creating: false });
  } else if (bot.model && !knownModels(bot.agent, modelIo()).includes(bot.model)) {
    throw new CliError(`${bot.name} is pinned to "${bot.model}", which isn't a ${bot.agent} model this computer lists. `
      + `Pick one with automagik-herdr edit ${bot.id} --model <model>, restart it on one with --model <model>, or clear the pin with --no-model.`);
  }
  // The old pane: the one the attach ledger names for the bot, as hc confirms it.
  const view = await attachView();
  const held = view.live.get(bot.id) ?? null;
  const old = held && local(held.get?.address ?? held.binding.terminal) ? { ...held.get, address: held.get?.address ?? held.binding.terminal } : null;
  if (old) {
    const refusal = restartRefusal({ name: bot.name, old, helpers: await helpersOf(old.address), force: opts.force });
    if (refusal) throw new CliError(refusal);
  }
  // The Claude session to resume: the old pane's agent.session label, else the ledger's last
  // session row for that terminal.
  const known = !old ? null : sessionOf(old) ? { session: sessionOf(old), transcript: null } : ledgerSession(workerLedgerRows(), old.address);
  const plan = restartPlan({
    bot, run: startableAgent(bot, entry?.agent ?? bot.agent).run,
    runningAgent: old ? agentKeyOfArgv(old.foreground?.argv, agentTable()) : null, session: known?.session ?? null,
    fresh: opts.fresh || !old, agent: entry ? entry.agent : undefined, model: entry ? (entry.model ?? "") : undefined,
  });
  // The same folder as the old pane when it keys to the project (a resumed Claude session is
  // looked up by folder), else the project's; the same space and tab (its Herdr labels).
  let cwd = key;
  const oldCwd = old?.foreground?.cwd ?? old?.cwd ?? null;
  if (oldCwd && oldCwd !== key) { try { if ((await keyOf(oldCwd)) === key) cwd = oldCwd; } catch { /* gone: the project's */ } }
  const place = opts.space ? { space: opts.space, tab: opts.tab ?? null, from: null } : (old ? placementFrom([old]) ?? undefined : undefined);
  const resumeId = plan.mode === "resume" && plan.agent === "claude" ? known?.session ?? null : null;
  // --continue takes the folder's latest conversation: never while another bot's Claude runs there.
  if (plan.mode === "resume" && plan.agent === "claude" && !resumeId) {
    const refusal = continueRefusal({ name: bot.name, old, cwd, sharers: claudeBotsIn(view, cwd, bot.id, file) });
    if (refusal) throw new CliError(refusal);
  }
  // A resumed session keeps its label on the new pane, so the next restart resumes it too.
  const carry = { ...carriedLabels(old), ...(resumeId ? { [SESSION_LABEL]: resumeId } : {}) };
  const seat = await launchSeat(project, bot, { agent: plan.agent, model: plan.model, argv: plan.argv, cwd, place, carry, replacing: old ? held.binding : null });
  if (seat.running) return opts.json ? { id: bot.id, running: seat.running } : `${bot.name} is already running in ${seat.running}.`;
  const warnings = seat.hook.warnings;
  const say = (w) => { warnings.push(w); report([w]); };
  if (old) {
    // The old pane ends only once the new one has kept its agent up: the space is never left empty.
    const up = await agentUp(seat.terminal);
    if (up.state !== "live") {
      // An abandoned replacement is ended (no seat row was written for it); the old pane stays.
      const ended = up.state === "ended" || (await hc(["kill", seat.terminal])).code === 0;
      throw new CliError(up.state === "ended"
        ? `${seat.terminal} exited before its agent was up (hc read ${seat.terminal} says why); ${old.address} still runs ${bot.name}, untouched.`
          + (plan.mode === "resume" ? ` Try automagik-herdr restart ${bot.id} --fresh.` : "")
        : `${seat.terminal} didn't keep an agent in front within ${RESTART_WAIT_MS / 1000}s${ended ? ", so it was ended" : ` and couldn't be ended (hc kill ${seat.terminal})`}; `
          + `${old.address} still runs ${bot.name}, untouched.`);
    }
    // Up: the ledger moves the bot to the new terminal, under its lock.
    const created = Number.isSafeInteger(up.get?.created_ms) ? up.get.created_ms : seat.created_ms;
    let moved;
    try {
      if (!Number.isSafeInteger(created)) throw new CliError(`hc get gave no created_ms for ${seat.terminal}`);
      moved = await attachMoved(bot, held.binding, seat.terminal, created, key);
    } catch (e) {
      await hc(["kill", seat.terminal]);
      throw new CliError(`${seat.terminal} was ended and ${old.address} still runs ${bot.name}: the attach ledger wasn't written (${e?.message ?? e}).`);
    }
    if (moved.lost !== undefined) {
      await hc(["kill", seat.terminal]);
      throw new CliError(`${bot.name} was attached to ${moved.lost} while it restarted, so ${seat.terminal} was ended and nothing changed.`);
    }
    await seat.logSeat();
    if (resumeId) {
      const unlogged = appendLedger(sessionRow({ terminal: seat.terminal, session: resumeId, transcript: known?.transcript ?? null }));
      if (unlogged) say(unlogged);
    }
  }
  if (plan.mode === "resume" && plan.agent === "claude" && !resumeId) {
    say(`No Claude session id was known for ${old.address}, so ${seat.terminal} resumes the latest conversation in ${cwd} (--continue). `
      + `No other bot's Claude runs there; if it isn't ${bot.name}'s, restart again with --fresh.`);
  }
  let saved = false;
  if (opts.save) {
    const now = loadProject(key);
    const stored = now.raw.bots.find((b) => b?.id === bot.id);
    if (stored) {
      writeBotsFile(key, applyBotEdit(now.raw, { ...stored, agent: entry.agent, ...(entry.model ? { model: entry.model } : { model: undefined }) }), now.text);
      saved = true;
    }
  }
  const what = old ? `${seat.terminal} replaces ${old.address}, ${restartText(plan, resumeId)}` : `${bot.name} wasn't running; started in ${seat.terminal}${swap ? ` on ${plan.agent}` : ""}`;
  const answer = () => {
    if (!opts.json) report([`${bot.name}: ${what}${saved ? `; ${BOTS_PATH} now says ${plan.agent}${plan.model ? ` (${plan.model})` : ""}` : ""}.`]);
    return opts.json ? { ...seatJson(bot, seat), replaced: old?.address ?? null, mode: old ? plan.mode : "start", agent: plan.agent, model: plan.model,
      session: resumeId, note: plan.note, saved, warnings } : seat.terminal;
  };
  if (!old) return answer();
  // A bot restarting itself runs this inside the pane the kill ends: everything is written and
  // printed first, then the kill, the last thing it does.
  if (process.env.HC_TERMINAL_ID && [old.address, old.name].includes(process.env.HC_TERMINAL_ID)) {
    const out = answer();
    // Flushed (a pipe's write can be asynchronous) before the kill takes this process with it.
    await new Promise((done) => process.stdout.write(opts.json ? `${JSON.stringify(out, null, 2)}\n` : `${out}\n`, done));
    await new Promise((done) => process.stderr.write("", done));
    await hc(["kill", old.address]);
    return PRINTED;
  }
  const killed = await hc(["kill", old.address]);
  if (killed.code !== 0) say(`${old.address} wasn't ended (hc kill: ${(killed.stderr || killed.stdout).trim()}); end it with hc kill ${old.address}.`);
  return answer();
}

const BOT_ID_SHAPE = /^b-[a-z2-7]{10}$/;

/** Where a holder plays, for a refusal: `t7 (since 2026-11-02T10:00:00.000Z)`. */
const heldAt = (b) => `${b.terminal} (since ${b.at})`;

async function cmdAttach(opts, [ref, terminal]) {
  if (!terminal) throw new CliError("attach needs a bot and a terminal: automagik-herdr attach <bot> <terminal> [--move].", 2);
  if (terminal.startsWith("-")) throw new CliError(`"${terminal}" isn't a terminal; name one like t7.`, 2);
  if (!local(terminal)) throw new CliError(`Attach works on this computer's panes only; ${terminal} is on another machine.`);
  const project = await projectFor(opts);
  const { file, key } = project;
  const bot = findBot(file, ref);
  if (bot.planned) throw new CliError(`${bot.name} is planned (wave ${bot.planned.wave}); clear "planned" before attaching it.`);
  const get = await hcGet(terminal);
  if (!get || get.state !== "live") throw new CliError(`${terminal} isn't a live terminal.`);
  const address = get.address ?? terminal;
  if (!Number.isSafeInteger(get.created_ms)) throw new CliError(`hc get ${address} gave no created_ms; nothing was attached.`);
  const nameOf = (id) => { const n = file.bots.find((b) => b.id === id)?.name; return n ? `${n} (${id})` : `bot ${id}`; };
  const playsAnother = (b) => new CliError(`${address} already plays ${nameOf(b.bot)}, since ${b.at}; nothing was attached. `
    + `Detach that bot first: automagik-herdr detach ${b.bot}`);
  // Another bot's pane is refused first, by this run's view (and again under the lock).
  const seen = (await attachView()).byTerminal.get(address)?.binding;
  if (seen && seen.bot !== bot.id && seen.created_ms === get.created_ms) throw playsAnother(seen);
  // Claude by its report, its foreground, or a wrapper whose argv runs claude (models.js).
  const claude = isClaude({ report: { app: get.status?.app } }, get) || agentKeyOfArgv(get.foreground?.argv) === "claude";
  let sessionFolder = get.foreground?.cwd ?? get.cwd ?? null;
  if (claude) {
    if (!get.foreground?.cwd) throw new CliError(`Can't read where ${address}'s Claude session runs (hc get ${address}); nothing was attached.`);
    sessionFolder = get.foreground.cwd;
    const sessionKey = await keyOf(sessionFolder);
    const refusal = attachRefusal({ botName: bot.name, projectKey: key, sessionFolder, sessionKey });
    if (refusal) throw new CliError(refusal);
  }
  // The ledger decides, under its lock: the terminal held by another bot is refused, and so is
  // the bot held by another terminal unless --move, which writes its detach (moved) first.
  const decided = await underLedger(async ({ core, byBot, byKey, holds, write }) => {
    const here = await holds(byKey.get(attachKey({ core, terminal: address, created_ms: get.created_ms })));
    if (here && here.binding.bot !== bot.id) throw playsAnother(here.binding);
    if (here) return { already: true, movedFrom: null };
    const mine = await holds(byBot.get(bot.id));
    if (mine && !opts.move) {
      throw new CliError(`${bot.name} (${bot.id}) is attached to ${heldAt(mine.binding)}; nothing was attached. `
        + `Move it with: automagik-herdr attach ${bot.id} ${address} --move (or detach it first).`);
    }
    const rows = mine ? [closingRow(mine.binding, "detach", "attach", "moved")] : [];
    rows.push(attachRow({ event: "attach", bot: bot.id, project: key, terminal: address, core, created_ms: get.created_ms, by: "attach" }));
    write(rows);
    return { already: false, movedFrom: mine ? mine.binding.terminal : null };
  });
  const warnings = [];
  const label = async (t, words) => {
    if (!words.length) return;
    const r = await hc(["label", t, ...words]);
    if (r.code !== 0) warnings.push(`the ledger has it, but hc label ${t} ${words.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  };
  // The labels follow as a display hint: off the old pane, then bot, role, category and a
  // squad copied from the lead (A16) on this one. A label failure only warns.
  if (decided.movedFrom && local(decided.movedFrom)) {
    const old = await hcGet(decided.movedFrom).catch(() => null);
    if (old?.state === "live") await label(decided.movedFrom, detachWords(old.labels ?? {}));
  }
  const have = get.labels ?? {};
  if (have[BOT_LABEL] !== bot.id) await label(address, [`${BOT_LABEL}=${bot.id}`]);
  const lead = leadIdOf(file, bot.id);
  let leadRows = [];
  try { leadRows = lead ? await liveRows(lead) : []; } catch { leadRows = []; }
  await label(address, attachWords(file, bot.id, { ...have, [BOT_LABEL]: bot.id }, leadRows));
  const hook = claude ? await writeBriefingHook(bot, sessionFolder) : { written: false, warnings: [] };
  hook.warnings.unshift(...warnings);
  if (!decided.already) {
    const argv = get.foreground?.argv;
    const seatAgent = agentKeyOfArgv(argv, agentTable()) ?? (claude ? "claude" : bot.agent ?? null);
    const unlogged = appendLedger(startRow({ kind: "seat", terminal: address, pid: get.foreground?.pid ?? get.pid ?? null, botId: bot.id,
      worktree: sessionFolder, project: key, agent: seatAgent, model: detectModel(argv, seatAgent) }));
    if (unlogged) hook.warnings.push(unlogged);
  }
  if (hook.written) hook.warnings.push(`${bot.name}'s briefing hook was added while its Claude session was running. If its next prompt brings no briefing, restart the bot: automagik-herdr restart ${bot.id} (or the bot row's Restart).`);
  report(hook.warnings);
  listProject(key);
  const movedFrom = decided.movedFrom ? [decided.movedFrom] : [];
  if (opts.json) return { id: bot.id, terminal: address, already: decided.already, movedFrom, hookWritten: hook.written, warnings: hook.warnings };
  if (decided.already) return `${bot.name} is already ${address}.`;
  return `${bot.name} is now ${address}${movedFrom.length ? ` (moved from ${movedFrom[0]})` : ""}.`;
}

async function cmdDetach(opts, [ref]) {
  // A bare id needs no definition: a bot removed with rm can still be detached.
  const bareId = BOT_ID_SHAPE.test(ref ?? "");
  let bot = null;
  try { bot = findBot((await projectFor(opts)).file, ref); } catch (e) { if (!bareId || !(e instanceof CliError)) throw e; }
  const id = bot?.id ?? ref;
  const name = bot?.name ?? `bot ${id}`;
  const from = await underLedger(async ({ byBot, holds, write }) => {
    const mine = await holds(byBot.get(id));
    if (!mine) return null;
    write([closingRow(mine.binding, "detach", "detach")]);
    return mine.binding.terminal;
  });
  // The labels, a display hint, come off the detached pane and any other local pane carrying
  // them. A16: role= and category= go with bot=; squad= only when this pack copied it there.
  // The row is written already: a failure here only warns.
  const cleared = [];
  try {
    const { addresses, gets } = await paneOf(id, hcJson, { localOnly: true });
    for (const t of new Set([...(from && local(from) ? [from] : []), ...addresses])) {
      const have = gets.find((g) => g?.address === t)?.labels ?? (await hcGet(t).catch(() => null))?.labels ?? {};
      if (have[BOT_LABEL] !== id) continue;
      const words = detachWords(have);
      const r = await hc(["label", t, ...words]);
      if (r.code !== 0) report([`${name} is detached, but hc label ${t} ${words.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`]);
      else cleared.push(t);
    }
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    report([`${name} is detached${from ? ` from ${from}` : ""}, but its labels weren't cleared: ${e.message}`]);
  }
  const detached = from ? [from] : [];
  return opts.json ? { id, defined: Boolean(bot), detached, labelsCleared: cleared }
    : from ? `${name} detached from ${from}.` : `${name} has no pane on this computer.`;
}

async function cmdWhois(opts, [terminal]) {
  if ((opts.bot === undefined) === (terminal === undefined)) {
    throw new CliError("whois needs a terminal or --bot <id>: automagik-herdr whois <terminal> | whois --bot <id>.", 2);
  }
  if (opts.bot !== undefined) {
    const id = BOT_ID_SHAPE.test(opts.bot) || opts.bot.startsWith("session-") ? opts.bot : findBot((await projectFor(opts)).file, opts.bot).id;
    const view = await attachView();
    const held = view.live.get(id);
    const out = held ? whoisOf(held) : { terminal: null, core: view.core, created_ms: null, bot: id, project: null, since: null };
    if (opts.json) return out;
    return held ? `${id} plays in ${out.terminal} (${out.project}) since ${out.since}.` : `${id} is attached to no terminal.`;
  }
  if (terminal.startsWith("-")) throw new CliError(`"${terminal}" isn't a terminal; name one like t7.`, 2);
  if (!local(terminal)) throw new CliError(`The ledger holds this computer's terminals only; ${terminal} is on another machine.`);
  const view = await attachView();
  const get = await hcLookup(terminal);
  const address = get?.address ?? terminal;
  const held = view.byTerminal.get(address);
  const out = held ? whoisOf(held) : { terminal: address, core: view.core, created_ms: get?.created_ms ?? null, bot: null };
  if (opts.json) return out;
  return held ? `${address} plays ${out.bot} (${out.project}) since ${out.since}.` : `${address} plays no bot.`;
}

async function cmdHistory(opts, [ref]) {
  // A bare id needs no definition (as detach): a removed bot's history is still there.
  const bareId = BOT_ID_SHAPE.test(ref ?? "");
  let bot = null;
  try { bot = findBot((await projectFor(opts)).file, ref); } catch (e) { if (!bareId || !(e instanceof CliError)) throw e; }
  const id = bot?.id ?? ref;
  const h = botHistory({ attachRows: readAttachFile() ?? [], ledgerRows: workerLedgerRows(), botId: id });
  if (opts.json) return { id, name: bot?.name ?? null, ...h };
  const { timeline, workers, transcript } = historyLines(h);
  return [
    `${bot?.name ?? `bot ${id}`} (${id})`,
    "  what happened", ...(timeline.length ? timeline.map((e) => `    ${e.text}`) : ["    nothing recorded on this computer"]),
    ...(workers.length ? ["  workers", ...workers.map((w) => `    ${w}`)] : []),
    ...(transcript ? [`  transcript   ${transcript}`] : []),
  ].join("\n");
}

async function cmdBrief(opts, [ref]) {
  const project = await projectFor(opts);
  const bot = findBot(project.file, ref);
  if (bot.planned) {
    if (opts.json) return { id: bot.id, briefing: null, reason: "planned bots get no briefing" };
    process.stderr.write(`automagik-herdr: ${bot.name} is planned; planned bots get no briefing.\n`);
    return "";
  }
  // briefing.mjs' own gathering; a failed hc call reads as "no answer" (unreachable), as
  // it does in the hook, so the briefing still prints.
  const ask = async (args) => { try { return await hcJson(args); } catch (e) { if (e instanceof CliError) return UNANSWERED; throw e; } };
  // The panes by the attach ledger, as this run's view confirms them; with hc failing, every
  // pane reads as unreachable, as a failed call does in the hook.
  const { view } = await viewOrError();
  const locate = async (id) => {
    if (!view) return { get: null, duplicate: false, addresses: [], gets: [], unreachable: true };
    const held = view.live.get(id);
    if (!held) return { get: null, duplicate: false, addresses: [], gets: [] };
    const get = { ...held.get, address: held.get?.address ?? held.binding.terminal };
    return { get, duplicate: false, addresses: [get.address], gets: [get] };
  };
  const self = await locate(bot.id);
  const text = await gatherBriefing({ file: project.file, bot, address: self.get?.address ?? null, ask, locate });
  return opts.json ? { id: bot.id, briefing: text } : text;
}

// ---- workers: a bot's one worker per task ----

/**
 * The folders that may hold the calling pane's project, most telling first: its foreground's
 * folder (where the agent works now), the folders of the other terminals in its Herdr space
 * (one space = one project; the sidebar's own rule, from hc alone so no window is needed),
 * its launch folder, this command's folder, then the remembered projects. Fallbacks only: callingBot
 * asks the attach binding's project first, and keeps the hints whose bots file defines the bot.
 */
async function botProjectHints(me, address) {
  const hints = [me.foreground?.cwd];
  const space = me.labels?.[SPACE_LABEL];
  if (space) {
    try {
      const peers = rowsOf(await hcJson(["ls", "--label", `${SPACE_LABEL}=${space}`]));
      hints.push(...peers.filter((r) => local(r?.address) && r.address !== address && r.state === "live").map((r) => r.cwd));
    } catch { /* hc ls failing: the space gives no hint */ }
  }
  hints.push(me.cwd, process.cwd());
  return [...hints.filter((h) => typeof h === "string" && h.startsWith("/")), ...rememberedKeys()];
}

/**
 * The projects among `folders` whose bots file defines `botId`, in the folders' order, each
 * once: [{ key, project, bot }]. A folder gone, outside any project or with a bots file that
 * doesn't parse is skipped (another project's broken file never blocks this bot).
 */
async function projectsDefining(botId, folders) {
  const seen = new Set();
  const found = [];
  for (const folder of folders) {
    let key;
    try { key = await keyOf(folder); } catch { continue; }
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let project;
    try { project = loadProject(key); } catch { continue; }
    const bot = project.file.bots.find((b) => b.id === botId);
    if (bot) found.push({ key, project, bot });
  }
  return { found, looked: [...seen] };
}

/** A project (by key) as { key, project, bot } when its bots file defines `botId`, else null. */
function definedIn(key, botId, { strict = false } = {}) {
  let project;
  try { project = loadProject(key); } catch (e) { if (strict) throw e; return null; }
  const bot = project.file.bots.find((b) => b.id === botId);
  return bot ? { key, project, bot } : null;
}

/**
 * The bot whose pane runs this command: { me (hc get), bot, project }. Anyone else is refused.
 * The bot is the attach ledger's binding of the pane, never its label. Its project is the one
 * whose bots file defines it: `--project` when that one does; else the project the binding
 * names (attach.js: the bot's main checkout) when it does; else the one project among the
 * fallbacks (botProjectHints) that does. Two fallbacks defining it are refused, never chosen between.
 */
async function callingBot(opts) {
  const self = process.env.HC_TERMINAL_ID;
  if (!self) throw new CliError("Only a bot starts workers, from its own pane: HC_TERMINAL_ID isn't set here, so this isn't a bot's pane.");
  const me = await hcGet(self);
  if (!me) throw new CliError(`${self} isn't a terminal hc knows; start workers from a bot's pane.`);
  const address = me.address ?? self;
  // Named before the ledger is read: its one-time label import looks in a --project too.
  const named = opts.project !== undefined ? await namedKeyOf(opts.project) : null;
  if (named) namedKeys.add(named);
  // Which bot this pane plays is the attach ledger's answer, never its label.
  const binding = (await attachView()).byTerminal.get(address)?.binding;
  const botId = binding?.bot;
  if (!botId) throw new CliError(await unboundRefusal(me, address));
  // The named project as namedKeyOf keys it (never a parent's); its bots file must parse.
  let hit = named ? definedIn(named, botId, { strict: true }) : null;
  if (!hit && !named && typeof binding.project === "string") hit = definedIn(binding.project, botId);
  if (!hit) {
    const hints = [...(typeof binding.project === "string" ? [binding.project] : []), ...await botProjectHints(me, address)];
    const { found, looked } = await projectsDefining(botId, hints);
    const defining = found.filter((f) => f.key !== named);
    if (named) {
      const which = defining.length ? `it's defined in ${defining.map((f) => f.key).join(" and ")}` : "no project here defines it";
      throw new CliError(`--project ${named} doesn't define bot ${botId}, which ${address} plays (${under(named, BOTS_PATH)}); ${which}. `
        + "A bot starts workers only in its own project.");
    }
    if (defining.length > 1) {
      throw new CliError(`${address} plays bot ${botId}, which ${defining.length} projects define: ${defining.map((f) => f.key).join(", ")}. `
        + "Pick its project with --project <folder>.");
    }
    if (!defining.length) {
      throw new CliError(`${address} plays bot ${botId}, which no project here defines (looked in ${looked.join(", ") || "none"}). `
        + "A bot starts workers only in its own project.");
    }
    hit = defining[0];
  }
  if (hit.bot.planned) throw new CliError(`${hit.bot.name} is planned; a planned bot starts no workers.`);
  return { me: { ...me, address }, bot: hit.bot, project: hit.project };
}

/**
 * Why a pane the attach ledger ties no bot to can't start workers. A pane still carrying a
 * `bot` label from before the ledger (its one-time import found no project defining that bot
 * from the pane's folder, or ran before) is told how to tie it: attach, from its project; a
 * Claude session outside the project can't be attached (attachRefusal), so start it there.
 */
async function unboundRefusal(me, address) {
  const base = `${address} isn't a bot's pane (the attach ledger ties no bot to it).`;
  const labelled = me.labels?.[BOT_LABEL];
  if (typeof labelled !== "string" || !labelled) return `${base} Only a bot starts workers.`;
  const { found } = await projectsDefining(labelled, await botProjectHints(me, address));
  const key = found.length === 1 ? found[0].key : "<its project>";
  return `${base} Its ${BOT_LABEL}=${labelled} label is from before the ledger, which no longer reads labels. `
    + `Tie it: automagik-herdr attach ${labelled} ${address} --project ${key}. A Claude session must run in that project to be `
    + `attached; if it doesn't, start the bot there: automagik-herdr start ${labelled} --project ${key}.`;
}

const realDir = (p) => { try { return realpathSync(p); } catch { return null; } };
/** A path as the file system spells it (realpathSync.native: on a case-insensitive disk, the folder's own case). */
const nativeDir = (p) => { try { return realpathSync.native(p); } catch { return null; } };

/** --worktree: an existing worktree of the bot's project, not its main checkout, on a branch. */
async function givenWorktree(path, key, bot) {
  const dir = realDir(resolvePath(path));
  let isDir = false;
  try { isDir = Boolean(dir) && statSync(dir).isDirectory(); } catch { /* not there */ }
  if (!isDir) throw new CliError(`--worktree: ${resolvePath(path)} is not a folder.`, 2);
  const top = (await git(["rev-parse", "--show-toplevel"], dir))?.trim();
  if (!top) throw new CliError(`--worktree: ${dir} isn't in a git worktree.`);
  const owner = (await projectOf(top, git, exists)).key;
  if (owner !== key) throw new CliError(`${top} is a worktree of ${owner}, not of ${bot.name}'s project ${key}. A bot starts workers only in its own project.`);
  if (top === key) throw new CliError(`${top} is the project's main checkout; a worker works in a task worktree (--branch makes one).`);
  const branch = (await git(["symbolic-ref", "--short", "-q", "HEAD"], top))?.trim();
  if (!branch) throw new CliError(`${top} has no branch checked out (a detached HEAD); a worker's task is its branch.`);
  return { worktree: top, branch, created: false, base: null };
}

/**
 * --branch: the worktree already on that branch, or a new one in
 * `<main checkout>/.claude/worktrees/<slug>`. A new branch starts from --base, else
 * origin's own branch of that name, else origin/HEAD's branch, else dev, else main, after a
 * fetch. Only `git worktree add` runs: the main checkout's HEAD is never touched. The new
 * branch tracks nothing unless it continues origin's branch of the same name.
 */
async function branchWorktree(branch, base, key, warnings) {
  const ok = !branch.startsWith("-") && (await runProgram("git", ["check-ref-format", "--branch", branch], { cwd: key })).code === 0;
  if (!ok) throw new CliError(`--branch: "${branch}" isn't a valid branch name.`, 2);
  const listed = await git(["worktree", "list", "--porcelain"], key);
  if (listed === null) throw new CliError(`${key} isn't a git project, so there is no worktree for --branch; pass --worktree.`);
  const hit = parseWorktrees(listed).find((w) => w.branch === branch);
  if (hit) {
    if (realDir(hit.path) === key) throw new CliError(`${branch} is checked out in the main checkout ${key}; a worker never works there. Pass --worktree, or use another branch.`);
    if (base) warnings.push(`${branch} has a worktree already, so --base ${base} was not used.`);
    return { worktree: realDir(hit.path) ?? hit.path, branch, created: false, base: null };
  }
  const path = worktreeFolder(key, branch);
  const same = parseWorktrees(listed).find((w) => (realDir(w.path) ?? w.path) === (realDir(path) ?? path));
  if (same) {
    throw new CliError(`Branch ${branch} uses the same folder as branch ${same.branch ?? "(a detached HEAD)"}: ${path}. `
      + "Pick another branch name, or pass --worktree to work in that one.");
  }
  if (existsSync(path)) throw new CliError(`${path} is there already, but not as a worktree on ${branch}. Move it, or pass --worktree.`);
  const unexcluded = await excludeWorktrees(key);
  if (unexcluded) warnings.push(unexcluded);
  const has = async (ref) => (await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], key)) !== null;
  let args;
  let from = null;
  if (await has(`refs/heads/${branch}`)) {
    if (base) warnings.push(`${branch} exists already, so --base ${base} was not used.`);
    args = ["worktree", "add", path, branch];
  } else {
    if ((await git(["remote"], key))?.split("\n").includes("origin")) {
      const f = await runProgram("git", ["fetch", "--quiet", "origin"], { cwd: key, timeout: 60_000 });
      if (f.code !== 0) warnings.push(`git fetch origin failed, so the base may be behind: ${(f.stderr || f.stdout).trim().split("\n")[0]}`);
    }
    const originHead = (await git(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], key))?.trim() || null;
    const candidates = base ? [base] : [`origin/${branch}`, ...baseCandidates(null, originHead)];
    for (const ref of candidates) if (await has(ref)) { from = ref; break; }
    if (!from) throw new CliError(base ? `--base: ${base} isn't a commit in ${key}.` : `${key} has no origin/HEAD, dev or main to start ${branch} from; pass --base.`);
    // Only origin's own branch of that name becomes the upstream. Any other start (origin/dev)
    // would, by git's branch.autoSetupMerge, make a plain `git pull` merge it and a plain
    // `git push` (push.default=upstream) push to it; the worker's first push sets its own.
    const track = from === `origin/${branch}` ? "--track" : "--no-track";
    args = ["worktree", "add", track, "-b", branch, path, from];
  }
  const r = await runProgram("git", args, { cwd: key, timeout: 60_000 });
  if (r.code !== 0) throw new CliError(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout).trim()}`);
  return { worktree: realDir(path) ?? path, branch, created: true, base: from };
}

/**
 * Keeps the task worktrees out of the main checkout's `git add -A`: WORKTREES_EXCLUDE in the
 * clone's own exclude file, as the briefing hook's settings file is. A warning, or null.
 */
async function excludeWorktrees(key) {
  let path = null;
  try {
    path = (await git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], key))?.trim() || null;
    if (!path) throw new Error("git gave no exclude path");
    const before = readText(path);
    const after = withExclude(before, WORKTREES_EXCLUDE);
    if (after === null) return null;
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await hookIo.write(path, after, before);
    return null;
  } catch (e) {
    return `Couldn't add ${WORKTREES_EXCLUDE} to ${path ?? "the git exclude file"} (${e?.message ?? e}); keep .claude/worktrees out of the main checkout's commits.`;
  }
}

/**
 * The lock a worker's check and start run under: one per worktree, named by a hash of the
 * worktree's real path, in `lockDir`. Local: it orders the CLIs on this computer only.
 */
export function worktreeLock(lockDir, worktree) {
  const real = nativeDir(worktree) ?? resolvePath(worktree);
  return `${lockDir}/worktree-${createHash("sha256").update(real).digest("hex").slice(0, 16)}.lock`;
}

/**
 * The live workers in `worktree` (a real path), of any bot: from `ls` (`hc ls`), the live
 * terminals on this computer whose cwd is that folder as a real path and that carry a
 * worker.of label, as { address, labels }. Labels come from the row, else from `hc get`.
 * Workers on other machines aren't seen (their cwd isn't a folder here).
 */
async function workersIn(worktree, ls) {
  const out = [];
  for (const r of rowsOf(ls)) {
    if (!local(r?.address) || (r.state !== undefined && r.state !== "live") || typeof r.cwd !== "string") continue;
    const cwd = r.cwd.startsWith("~/") ? `${home()}${r.cwd.slice(1)}` : r.cwd;
    if ((nativeDir(cwd) ?? cwd) !== (nativeDir(worktree) ?? worktree)) continue;
    const labels = r.labels && typeof r.labels === "object" ? r.labels : (await hcGet(r.address))?.labels;
    if (labels?.[WORKER_OF_LABEL]) out.push({ address: r.address, labels });
  }
  return out;
}

/**
 * The agent an hc template runs, from its command in `hc templates`: an agent key, or
 * undefined when no known agent is in the command. A template hc doesn't list, or no list at
 * all, is refused here, before any worktree is made: `hc run` runs an unlisted name as a
 * program (`--template rm` would run rm).
 */
async function templateRuns(template, agents) {
  const r = await hc(["templates", "--json"]);
  let list = null;
  try { list = r.code === 0 ? JSON.parse(r.stdout).templates : null; } catch { list = null; }
  if (!Array.isArray(list)) {
    throw new CliError(`hc templates gave no list (${(r.stderr || r.stdout).trim().slice(0, 200) || `exit ${r.code}`}), `
      + `so ${template} can't be checked as a template; hc run would start an unlisted name as a program. Not started.`);
  }
  const hit = list.find((x) => x?.name === template);
  if (!hit) {
    const names = list.map((x) => x?.name).filter(Boolean);
    throw new CliError(`hc has no template ${template}${names.length ? `. Its templates: ${names.join(", ")}` : ""}.`);
  }
  return templateAgent(hit.command, agents) ?? undefined;
}

/**
 * Planned swaps: whether bot `botId`'s task `taskId` in project `key` runs the bot's other
 * arm (worker.swap). The first byte of sha256(`${botId}:${key}:${taskId}`), mod 3, is 0:
 * about one task in three, the same answer for every worker of that bot on that task.
 */
export const swapTask = (botId, key, taskId) => swapByte(createHash("sha256").update(`${botId}:${key}:${taskId}`).digest()[0]);

/**
 * The commit a worker's worktree started from: the base ref this command made it from, as a
 * SHA; else the branch's oldest reflog entry (where it was created here: Genie's worktree
 * from a fresh-fetched base); null when git keeps neither.
 */
async function baseCommit(place, key) {
  if (place.created && place.base) {
    const sha = (await git(["rev-parse", "--verify", "--quiet", `${place.base}^{commit}`], key))?.trim();
    if (sha) return sha;
  }
  const log = await git(["reflog", "show", "--format=%H", `refs/heads/${place.branch}`], key);
  return log?.trim().split("\n").filter(Boolean).at(-1) ?? null;
}

async function cmdWorker(opts, rest) {
  const task = rest.join(" ").trim();
  if (!task) throw new CliError('worker needs the task text: automagik-herdr worker "<task>" --branch <name>.', 2);
  if (optionLike(task)) throw new CliError("The task text can't start with a dash; the agent would read it as an option.", 2);
  if ((opts.branch === undefined) === (opts.worktree === undefined)) throw new CliError("Give --branch or --worktree (one of them).", 2);
  if (opts.base !== undefined && opts.branch === undefined) throw new CliError("--base goes with --branch.", 2);
  if (opts.template === "") throw new CliError("--template needs a name: --template <name> (hc templates lists them).", 2);
  if (opts.role !== undefined && !ROLES.includes(opts.role)) throw new CliError(`--role is one of ${ROLES.join(", ")}, not "${opts.role}".`, 2);
  const given = { template: opts.template, agent: opts.agent, model: opts.model, effort: opts.effort };
  const alongside = ["agent", "model", "effort"].filter((k) => given[k] !== undefined);
  if (given.template !== undefined && alongside.length) {
    throw new CliError(`A template owns its command: --template goes alone, without --${alongside.join(", --")}.`, 2);
  }
  // The task contract (Genie R1-17): --task is Genie's short id; the worker is named after it.
  const taskId = opts.task;
  if (taskId !== undefined) {
    const why = taskIdProblem(taskId);
    if (why) throw new CliError(why, 2);
    if (opts.name !== undefined) throw new CliError(`--name goes without --task: a task's worker is named ${taskId}-<role>.`, 2);
    if (opts.branch !== undefined && !branchNamesTask(opts.branch, taskId)) {
      throw new CliError(`--branch ${opts.branch} doesn't contain the task id ${taskId}; a task's branch names it (fix/${taskId}-login).`, 2);
    }
  }
  if (opts.lead !== undefined && !LEAD_SHAPE.test(opts.lead)) {
    throw new CliError(`--lead: "${opts.lead}" isn't a bot id (b- plus 10 base32 characters) or a Genie session (session-<uuid>).`, 2);
  }
  const { me, bot, project } = await callingBot(opts);
  const { role, error: roleError } = workerRole(bot, opts.role);
  if (roleError) throw new CliError(roleError, 2);
  if (taskId !== undefined && opts.lead === undefined && LEAD_RANKS.includes(bot.rank)) throw new CliError("pass --lead <the task's lead bot>", 2);
  const lead = opts.lead ?? bot.id;
  const taskName = taskId !== undefined ? taskWorkerName(taskId, role) : null;
  if (taskName && taskName.length > HC_NAME_MAX) {
    throw new CliError(`${taskName} is longer than hc's ${HC_NAME_MAX}-character terminal names; a task's worker is named exactly <id>-<role>.`, 2);
  }
  const agents = agentTable();
  const warnings = [];
  // Planned swaps (owner, council #4): on a task the rule picks, the bot's worker.swap replaces
  // its worker defaults, and a per-task --agent, --model or --effort is recorded, not used.
  // Never for a template worker; off a swap task, a per-task pick is an override.
  let pick = given;
  let swap = false;
  let overrideRequested = null;
  const arm = taskId !== undefined && !runsTemplate(bot, given) && swapTask(bot.id, project.key, taskId) ? swapArm(bot) : null;
  if (arm?.agent && !resolveAgent(arm.agent, agents)) {
    warnings.push(`${bot.name}'s worker swap agent "${arm.agent}" isn't one Herdr knows; this swap task runs without it.`);
    delete arm.agent;
  }
  if (arm && Object.keys(arm).length) {
    swap = true;
    pick = { ...arm };
    if (alongside.length) {
      overrideRequested = Object.fromEntries(alongside.map((k) => [k, given[k]]));
      warnings.push(`${taskId} is one of ${bot.name}'s planned swap tasks, so it runs ${workerText(arm)}; `
        + `${alongside.map((k) => `--${k} ${given[k]}`).join(", ")} recorded, not used.`);
    }
  }
  const override = !swap && Object.values(given).some((v) => v !== undefined);
  const plan = workerPlan(bot, pick, agents);
  if (plan.error) throw new CliError(plan.error, 2);
  warnings.push(...plan.warnings);
  // The agent that runs: the plan's, or the one a template's command names (null: can't tell).
  let runs = plan.agent;
  if (plan.template) runs = await templateRuns(plan.template, agents);
  else {
    if (!onPath(plan.argv[0])) throw new CliError(`${agents[plan.agent].name} (${plan.argv[0]}) isn't installed on this computer.`);
    const list = plan.model ? knownModels(plan.agent, modelIo()) : [];
    if (list.length && !list.includes(plan.model)) warnings.push(`${plan.model} isn't on ${plan.agent}'s model list; started with it anyway.`);
  }
  // An npm agent (#!/usr/bin/env node) gets its interpreter's folder on PATH when the pane lacks it.
  const runPath = plan.template ? null : interpreterPath(plan.argv[0], process.env.PATH);
  if (runPath?.note) warnings.push(runPath.note);
  const place = opts.worktree !== undefined ? await givenWorktree(opts.worktree, project.key, bot)
    : await branchWorktree(opts.branch, opts.base, project.key, warnings);
  const base = await baseCommit(place, project.key);
  // A Claude worker gets the per-turn hook in its worktree: it prints no briefing there (the
  // worker is no bot), but it ties the Claude session to the terminal (briefing.mjs).
  if (runs === undefined) {
    warnings.push(`Can't tell which agent template ${plan.template} runs, so no session hook was written in ${place.worktree}; `
      + `if it runs Claude, the ${place.branch} worker's session won't be linked to usage.`);
  } else if (runs === "claude") {
    const lost = `The ${place.branch} worker's Claude session won't be linked to usage`;
    warnings.push(...(await writeBriefingHook(bot, place.worktree, appHome(), { lost })).warnings);
  }
  // One writer (dev, test, fix) per worktree, whatever its bot; reviewers run alongside, but
  // one bot runs one reviewer per branch. A worker with no role label counts as a writer.
  // Checked and started under one lock per worktree, so two calls at once can't both pass.
  const lockDir = ledgerPath(appHome()).replace(/\/[^/]*$/, "");
  try { mkdirSync(lockDir, { recursive: true }); } catch (e) { throw new CliError(`Can't make ${lockDir}: ${e?.message ?? e}`); }
  const worktree = realDir(place.worktree) ?? place.worktree;
  const terminal = await withLockAsync(worktreeLock(lockDir, worktree), async () => {
    const ls = await hcJson(["ls"]);
    // A task's worker is named exactly <id>-<role>: a live holder of that name is refused, never suffixed.
    // This computer's terminals only (hc names are unique per core), as workersIn sees them.
    const holder = taskName && rowsOf(ls).find((r) => r?.name === taskName && local(r.address)
      && (r.state === undefined || r.state === "live"));
    if (holder) {
      throw new CliError(`${taskName} is taken by a live terminal: ${holder.address}. A task's worker is named exactly <id>-<role>, `
        + `never suffixed. Check it (hc read ${holder.address}) or end it (hc kill ${holder.address}) before starting another.`);
    }
    const live = await workersIn(worktree, ls);
    const nameOf = (id) => project.file.bots.find((b) => b.id === id)?.name ?? id;
    const writing = role !== "review" && live.find((w) => writesWorktree(w.labels));
    const reviewing = role === "review" && live.find((w) => w.labels[WORKER_OF_LABEL] === bot.id
      && workerBranch(w.labels) === place.branch && w.labels[WORKER_ROLE_LABEL] === "review");
    const hit = writing || reviewing;
    if (hit) {
      const what = writing ? `${place.worktree} already has a live writer: ${hit.address} (${nameOf(hit.labels[WORKER_OF_LABEL])}'s `
        + `${hit.labels[WORKER_ROLE_LABEL] ?? "worker, no role label"}). One writer per worktree.`
        : `${bot.name} already has a live review worker on ${place.branch}: ${hit.address}.`;
      throw new CliError(`${what} Check it (hc read ${hit.address}) or end it (hc kill ${hit.address}) before starting another.`);
    }
    const taken = new Set(rowsOf(ls).map((r) => r?.name).filter(Boolean));
    const name = taskName ?? hcName(opts.name ?? branchSlug(place.branch), bot.id, taken);
    const args = workerArgs({ botId: bot.id, branch: place.branch, role, name, cwd: place.worktree, parent: me.address,
      agent: plan.agent, model: plan.model, effort: plan.effort, argv: plan.argv, task, template: plan.template,
      path: runPath?.path ?? process.env.PATH, taskId, project: project.key, lead });
    const r = await hc(args);
    if (r.code !== 0) throw new CliError(`hc run failed: ${(r.stderr || r.stdout).trim()}`);
    let address = null;
    try { address = JSON.parse(r.stdout).address ?? null; } catch { address = null; }
    if (!address) throw new CliError(`hc run gave no terminal address: ${r.stdout.trim()}`);
    return address;
  }).catch((e) => { throw e instanceof CliError ? e : new CliError(e?.message ?? String(e)); });
  const pid = await pidOf(terminal);
  const unlogged = appendLedger(startRow({ kind: "worker", terminal, pid, botId: bot.id, task: taskId, branch: place.branch,
    project: project.key, lead, worktree, base, created: place.created, agent: plan.agent, model: plan.model, effort: plan.effort,
    template: plan.template, role, swap, override, overrideRequested }));
  if (unlogged) warnings.push(unlogged);
  report(warnings);
  const out = { terminal, bot: bot.id, role, parent: me.address, worktree: place.worktree, branch: place.branch, created: place.created,
    base: place.base, template: plan.template, agent: plan.agent, model: plan.model, effort: plan.effort, pid, argv: plan.argv, warnings,
    task: taskId ?? null, project: project.key, lead, baseCommit: base, swap, override, override_requested: overrideRequested };
  if (opts.json) return out;
  const how = place.created ? `new, from ${place.base ?? place.branch}` : "existing";
  const what = plan.template ? [`  template  ${plan.template}${runs ? ` (runs ${runs})` : ""}`]
    : [`  agent     ${plan.agent}`, `  model     ${plan.model ?? "(the agent's default)"}`,
      `  effort    ${plan.effort ?? "(the agent's default)"}`];
  const contract = taskId !== undefined ? [`  task      ${taskId} (lead ${lead})`] : [];
  const swapped = swap ? [`  swap      yes: ${bot.name}'s planned swap task`] : [];
  return [terminal, `  role      ${role}`, ...contract, `  worktree  ${place.worktree}`, `  branch    ${place.branch} (${how})`, ...what,
    ...swapped,
    `End it once the task merges: hc kill ${terminal}`].join("\n");
}

// ---- updates (A14) ----

/** The hooks notice (migrateHooks.mjs hooksNotice) on lines of its own after the summary, or "". */
const hooksLines = (hooks) => { const lines = hooksNotice(hooks); return lines.length ? `\n${lines.join("\n")}` : ""; };

/**
 * `update`: install the latest release, `--check` only reports, `--rollback` swaps the kept
 * pack back. `io` is injected by the tests (fetch, env, modsDir, binDir); the pack is the installed
 * one under $HERDR_APP_HOME/mods, never this checkout (update.mjs). The CLI link (~/.local/bin) and
 * the open spaces are looked at only for this computer's own pack: with `io.modsDir`, only `io.binDir`.
 */
export async function cmdUpdate(opts, _rest = [], io = {}) {
  if (opts.check && opts.rollback) throw new CliError("Give --check or --rollback, not both.", 2);
  const host = io.modsDir ? { binDir: io.binDir ?? null, window: false }
    : { binDir: io.binDir ?? binDirOf(io.env ?? process.env), window: liveHome(`${appHome(io.env ?? process.env)}/mods`) };
  const where = { ...(io.env ? { env: io.env } : {}), ...(io.fetch ? { fetch: io.fetch } : {}), ...(io.keys ? { keys: io.keys } : {}), ...(io.modsDir ? { modsDir: io.modsDir } : {}), ...host };
  const failed = (what, e) => new CliError(`${what}: ${String(e?.message ?? e).split("\n")[0]}`);
  // The pack just swapped (or one an older CLI installed) may name its CLI otherwise
  // (bin/automagik-herdr, or only the .mjs before it): the ~/.local/bin link follows, so a
  // rollback never leaves it dangling. Idempotent, never fatal; `--check` changes nothing.
  // `from`: where the link pointed before a rollback, whose own relink (update.mjs moveHooks) may
  // already have moved it: either way the move is reported. The link is host.binDir's: with an
  // injected io.modsDir only io.binDir, never this computer's ~/.local/bin.
  const relink = (from = null) => {
    const { binDir } = host;
    try {
      let r = relinkCli({ modsDir: io.modsDir ?? defaultModsDir(io.env ?? process.env), binDir });
      if (!r && from && binDir) {
        const link = join(binDir, "automagik-herdr");
        const to = readLink(link);
        if (to && to !== from) r = { link, from, to };
      }
      return { relinked: r, note: r ? ` ${r.link} now points at ${r.to}.` : "" };
    } catch (e) {
      return { relinked: null, note: ` The automagik-herdr link was not repointed (${String(e?.message ?? e).split("\n")[0]}): run install.sh again.` };
    }
  };
  if (opts.rollback) {
    const before = host.binDir ? readLink(join(host.binDir, "automagik-herdr")) : null;
    let r;
    try { r = rollbackPack({ ...(io.modsDir ? { modsDir: io.modsDir } : {}), ...host }); } catch (e) { throw failed("Nothing rolled back", e); }
    const { relinked, note } = relink(before);
    const warned = r.warnings?.length ? ` Warning: ${r.warnings.join("; ")}.` : "";
    return opts.json ? { rolledBack: r, relinked } : `Rolled back to Automagik Herdr ${r.version ?? "(no VERSION)"} at ${r.pack}. Reload Herdr's mods to use it.${warned}${note}${hooksLines(r.hooks?.hooks)}`;
  }
  let r;
  try { r = opts.check ? await checkForUpdate(where) : await installUpdate(where); } catch (e) {
    throw failed(opts.check ? "Couldn't check for updates" : "Not updated", e);
  }
  const { relinked, note } = opts.check ? { relinked: null, note: "" } : relink();
  const meter = r.installed ? await meterAfterUpdate(io) : null;
  if (opts.json) return opts.check ? r : { ...r, relinked, ...(meter ? { meter: meter.results } : {}) };
  const current = r.current ?? "not installed";
  if (r.disabled) return `Automagik Herdr ${current} is installed. Updates are off (${NO_UPDATE_ENV}=1).${note}`;
  if (r.installed) {
    return `Updated Automagik Herdr ${current} → ${r.installed.version}. The replaced pack is kept: \`automagik-herdr update --rollback\` puts it back. Reload Herdr's mods to use it.${note}${hooksLines(r.installed.hooks?.hooks)}${meter.lines.map((l) => `\n${l}`).join("")}`;
  }
  if (r.update) return `Automagik Herdr ${current} is installed; ${r.update.version} is out (${r.update.page}). Run \`automagik-herdr update\` to install it.`;
  return `Automagik Herdr ${current} is installed; the latest release is ${r.latest ?? "none yet"}. Up to date.${note}`;
}

// ---- tidy (sidebar-rules Group 2) ----

const tidyIo = () => ({ run: runProgram, home: home(), appHome: appHome(), prune: (keys) => unlistProjects(keys) });

/** `tidy`: the plan (tidy.js), read from hc, herdr-app, git and the files; it changes nothing. */
async function cmdTidy(opts) {
  let state;
  try { state = await readState(tidyIo(), { window: true }); } catch (e) { throw new CliError(`Can't plan: ${e?.message ?? e}`); }
  const actions = tidyPlan(state, { now: Date.now(), home: home(), appHome: appHome() });
  return opts.json ? actions : planText(actions);
}

/** After start, attach and create: the plan's non-visual fixes only; a failure only warns. */
async function tidyQuietly() {
  try {
    const io = tidyIo();
    const actions = tidyPlan(await readState(io, { window: false }), { now: Date.now(), home: io.home, appHome: io.appHome });
    report(await fixNonVisual(actions.filter((a) => !a.visual), io));
  } catch (e) { report([`tidy: ${e?.message ?? e}`]); }
}
const TIDIES = new Set(["start", "restart", "attach", "create"]);

// ---- usagemeter on every linked machine (meterFleet.js) ----

const hcProgram = () => programPath("hc");
/** meterFleet.js's runner: on a linked machine through `hc exec`, else here from the home folder. */
const meterRun = (argv, { on, timeout }) => (on
  ? runProgram(hcProgram() ?? "hc", hcExecArgs(on, argv, timeout), { timeout: (timeout + 15) * 1000 }).then((r) => decodeExec(r, timeout))
  : runProgram(argv[0], argv.slice(1), { cwd: home(), timeout: timeout * 1000 }));

/** The linked machines (`{ name, connected }`), or `{ why }` when hc can't say. */
async function meterMachines() {
  if (!hcProgram()) return { why: "hc (herdr-core) is not on PATH" };
  const r = await runProgram(hcProgram(), ["machine", "ls", "--json"], { timeout: 20000 });
  if (r.code !== 0) return { why: `hc machine ls failed: ${(r.stderr || r.stdout).trim().split("\n")[0]}` };
  return { machines: linkedMachines(r.stdout) };
}

/**
 * The install record after `results` (only a v2 one install.sh wrote; none: nothing is noted), and
 * the scope an explicit `meter install` agreed to (`scope`: all, or local; never narrower than all).
 */
function noteMeter(modsDir, results, scope = null) {
  const record = readMarker(modsDir);
  if (!record || record.v1) return;
  const usagemeterScope = scope === "all" || (scope === "local" && record.usagemeterScope !== "all") ? scope : record.usagemeterScope;
  const here = results.find((r) => r.machine === null);
  const usagemeter = here?.status === "installed" ? here.version : ["newer", "link", "unknown"].includes(here?.status) ? null : record.usagemeter;
  const usagemeterOn = recordAfter(record.usagemeterOn, results);
  if (usagemeter === record.usagemeter && usagemeterScope === record.usagemeterScope
    && JSON.stringify(usagemeterOn) === JSON.stringify(record.usagemeterOn)) return;
  writeMarker(modsDir, { ...record, usagemeter, usagemeterOn, usagemeterScope });
}

/**
 * `meter install` / `meter uninstall`. One machine at a time; a machine that fails is a warning
 * line, and the command still succeeds (but `--machine M` failing exits 1).
 */
export async function cmdMeter(opts, [verb, ...rest], io = {}) {
  const modsDir = io.modsDir ?? defaultModsDir(process.env);
  if (rest.length) throw new CliError(`meter ${verb} takes no arguments (got ${rest.join(" ")}).`, 2);
  const results = [], notes = [];
  if (verb === "install") {
    if ([opts.machine !== undefined, opts.linked, opts.local].filter(Boolean).length > 1) throw new CliError("Give one of --machine, --linked and --local.", 2);
    const releases = meterReleases(process.env);
    const pins = meterPins(process.env, (path) => readFileSync(path, "utf8"));
    if (opts.machine === undefined && !opts.linked) results.push(await installOn(meterRun, null, { releases, pins }));
    if (!opts.local) {
      const found = await meterMachines();
      if (found.why) {
        if (opts.machine !== undefined) throw new CliError(`usagemeter on ${opts.machine}: ${found.why}.`);
        notes.push(`usagemeter on linked machines: skipped (${found.why}).`);
      }
      let list = found.machines ?? [];
      if (opts.machine !== undefined) {
        list = list.filter((m) => m.name === opts.machine);
        if (!list.length) throw new CliError(`No linked machine "${opts.machine}" (hc machine ls).`, 2);
      }
      for (const m of list) results.push(m.connected ? await installOn(meterRun, m.name, { releases, pins }) : { machine: m.name, status: "disconnected" });
    }
  } else if (verb === "uninstall") {
    if (opts.machine !== undefined || opts.linked || opts.local) throw new CliError("meter uninstall takes no --machine, --linked or --local.", 2);
    const owned = readMarker(modsDir)?.usagemeterOn ?? {};
    const names = Object.keys(owned);
    const pocket = join(modsDir, POCKET_LINK);
    const found = names.length && !existsSync(pocket) ? await meterMachines() : {};
    for (const name of names) {
      const m = found.machines?.find((k) => k.name === name);
      if (existsSync(pocket)) results.push({ machine: name, status: "kept", why: `Pocket Link (${pocket}) runs it too` });
      else if (found.why) results.push({ machine: name, status: "kept", why: found.why });
      else if (!m?.connected) results.push({ machine: name, status: "kept", why: m ? "the machine is not connected" : "no such linked machine any more" });
      else results.push(await uninstallOn(meterRun, name, owned[name]));
    }
  } else {
    throw new CliError(`meter needs install or uninstall${verb ? `, not "${verb}"` : ""}.`, 2);
  }
  // An explicit `meter install` is the person's yes (install.sh's own run passes --linked
  // and records its scope itself; `update` asks only within the scope already agreed).
  const agreed = verb === "install" && !opts.linked && opts.machine === undefined ? (opts.local ? "local" : "all") : null;
  try { noteMeter(modsDir, results, agreed); } catch (e) { notes.push(`usagemeter: the install record could not note it (${e?.message ?? e}).`); }
  if (opts.machine !== undefined && results.some((r) => r.status === "failed" || r.status === "disconnected")) {
    throw new CliError(results.map(resultLine).join("\n").replace(/^Warning: /, ""));
  }
  if (opts.json) return { results, notes };
  return [...results.map(resultLine), ...notes].join("\n")
    || (verb === "install" ? "usagemeter: no connected linked machine (hc machine ls)." : "usagemeter: no linked machine has the pack's usagemeter.");
}

/**
 * After `update` installed a pack: that pack's own `meter install` (its release.js may pin a newer
 * usagemeter than this running CLI's), as install.sh's scope says. Lines to print; never throws.
 */
export async function meterAfterUpdate(io) {
  const modsDir = io.modsDir ?? defaultModsDir(io.env ?? process.env);
  const scope = meterScope(readMarker(modsDir));
  if (scope === "none") return { lines: ["usagemeter: skipped (install.sh --no-usagemeter)."], results: [] };
  // Nobody asked (an older install.sh recorded no --no-usagemeter): nowhere, and how to opt in.
  if (!scope) return { lines: [OPT_IN], results: [] };
  const args = ["meter", "install", "--json", ...(scope === "local" ? ["--local"] : [])];
  let r;
  if (io.meter) r = await io.meter(args);
  else if (io.modsDir) return { lines: [], results: [] };
  else r = await runProgram(process.execPath, [join(modsDir, PACK_NAME, "bin", "automagik-herdr.mjs"), ...args], { timeout: 30 * 60 * 1000 });
  try {
    const out = JSON.parse(r.stdout);
    return { lines: [...out.results.map(resultLine), ...(out.notes ?? [])], results: out.results };
  } catch {
    return { lines: [`Warning: usagemeter was not checked: ${(r.stderr || r.stdout || `exit ${r.code}`).trim().split("\n").pop()}. Run \`automagik-herdr meter install\` to retry.`], results: [] };
  }
}

const COMMANDS = { ls: cmdLs, show: cmdShow, create: cmdCreate, edit: cmdEdit, rm: cmdRm, category: cmdCategory,
  start: cmdStart, restart: cmdRestart, attach: cmdAttach, detach: cmdDetach, whois: cmdWhois, history: cmdHistory, brief: cmdBrief, update: cmdUpdate,
  tidy: cmdTidy, worker: cmdWorker, meter: cmdMeter };
const NEEDS_BOT = new Set(["show", "edit", "rm", "start", "restart", "attach", "detach", "history", "brief"]);

/** Runs one command line; resolves with the exit code. Output goes to stdout, problems to stderr. */
export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    process.stderr.write(`automagik-herdr: ${e.message}\n\n${USAGE}\n`);
    return 2;
  }
  const { values: opts, positionals } = parsed;
  const [command, ...rest] = positionals;
  // The pack this command belongs to (its VERSION file; 0.0.0 for a checkout never released).
  if (opts.version && !command) {
    let version = "0.0.0";
    try { version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim() || version; } catch { /* no VERSION file */ }
    process.stdout.write(opts.json ? `${JSON.stringify({ version })}\n` : `automagik-herdr ${version}\n`);
    return 0;
  }
  if (opts.help || !command || command === "help") { process.stdout.write(`${USAGE}\n`); return command || opts.help ? 0 : 2; }
  const run = COMMANDS[command];
  if (!run) { process.stderr.write(`automagik-herdr: unknown command "${command}"\n\n${USAGE}\n`); return 2; }
  try {
    if (NEEDS_BOT.has(command) && !rest[0]) throw new CliError(`${command} needs a bot (its id or name).`, 2);
    if (opts.machine !== undefined && !ON_MACHINE.has(command)) {
      throw new CliError(`${command} works on this computer's panes only for now; --machine goes with ls, show, create, edit, rm and category.`, 2);
    }
    const out = await run(opts, rest);
    if (out === PRINTED) return 0;
    if (opts.json) process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    else if (out) process.stdout.write(`${out}\n`);
    if (TIDIES.has(command)) await tidyQuietly();
    return 0;
  } catch (e) {
    const message = e instanceof CliError ? e.message : `${e?.stack ?? e}`;
    process.stderr.write(`automagik-herdr: ${message}\n`);
    return e instanceof CliError ? e.code : 1;
  }
}

// Run as a program (also through the ~/.local/bin symlink, hence the realpath), not on import.
const invoked = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; } })();
if (import.meta.url === invoked) {
  // An update made by an older CLI (0.3.4 and before) left the link on the .mjs, which needs node
  // on PATH: the first start that has a runtime moves it to the wrapper. Silent, never fatal.
  try { relinkCli(); } catch { /* the link stays; `automagik-herdr update` reports why */ }
  process.exitCode = await main();
}
