#!/usr/bin/env node
// Installs, updates and rolls back the pack as one unit (A14, D3, D10): one release tarball holds
// every pack mod folder plus layouts/automagik.json; it is checked against the release's
// automagik-herdr-pack-<v>.tgz.sha256, each folder is built in a staging folder beside mods/ (the mod's private paths
// carried in), then renamed into place, and the folders it replaced are kept together as one
// rollback set. Only folders the ownership record lists are replaced; any other folder in mods/
// is left alone, or adopted on an explicit --adopt (moved to backup/ first, never replaced).
// Node only (the CLI, and the mod through `exec("node", [<pack>/update.mjs, "check"])`, Herdr's
// runtime having no fetch); the rules over plain data live in release.js. Apache-2.0.
//
//   node update.mjs check             [--mods <dir>]   one JSON line: current, latest, update
//   node update.mjs update [--check] [--json] [--mods <dir>]   install the latest release (apply: the same, JSON;
//                                     apply --expect <v>: only if the latest is still <v>, else `refused`)
//   node update.mjs rollback          [--mods <dir>]   swap the kept set back; one JSON line
//   node update.mjs install --from <tgz> --version <v> [--sequence <n>] [--mods <dir>] [--adopt] [--setup]
//       a tarball already checked against its .sha256 (install.sh); one JSON line. --setup also
//       merges free keys, writes the mod manager's catalog.json, places the layout (D8) and runs
//       `herdr-app check` on every installed mod (exit 3 when one fails). Exit 4: installed, but a
//       step after the swap (the record, the kept set) did not finish; its warning says where things are.
//   node update.mjs repair --from <tgz> --version <v> [--mods <dir>]
//       install.sh's same-version rerun: checks every installed pack file against that tarball,
//       reinstalls a missing or damaged folder (its damaged copy kept in backup/), puts back a
//       missing automagik layout and runs `herdr-app check` on every mod (exit 3 / 4 as above).
//
// <dir> defaults to $HERDR_APP_HOME/mods (~/.config/herdr-app/mods), never this file's own
// folder, so running it from a checkout never replaces the checkout. Everything else lives in
// <app home>/automagik-herdr/, outside mods/ (a folder left inside mods/ is loaded as a mod):
//   installed-by-install.sh   the ownership record (release.js parseMarker)
//   .prev/                    the set the last install, update or rollback replaced (.prev/.pack lists it)
//   backup/<mod>-<date>/      a folder the person owned, moved aside on --adopt; never replaced
//   backup/layouts-<date>/    the rename migration's backups and journal (migrateHome.mjs)
//
// Across the rename (Group 6a, D12) an old-named folder the record lists hands its private paths
// to its am-* folder and leaves with the kept set; a person's own is left, or adopted on --adopt.
// After the folders, layouts and keys.json follow the renamed folders (migrateHome.mjs), and a
// rollback across the rename reverts those edits from the journal. Then the briefing hooks follow
// (Group 6b, migrateHooks.mjs): onto <app home>/automagik-herdr/briefing.mjs when the installed
// sidebar ships it, back to v0.3's path when it doesn't, and the CLI link follows the sidebar folder.
//
// Needs Node 22.7 or later: the installed pack has no package.json, so Node loads release.js
// (shared with the mod, whose loader takes .js) as ESM by detecting its syntax.

import { execFile, execFileSync } from "node:child_process";
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  CATALOG_URL, OLD_PACK_NAME, PACK_CATALOG_URLS, PACK_KEYS, PACK_KEYS_FILE, PACK_LAYOUT, PACK_NAME, POCKET_LINK, POINTER_SIG_URL, POINTER_URL,
  TIMEOUT_MS, V020_LAYOUT_SHA256, formatMarker, packOfPointer, parseMarker, parseSums, pickUpdate, updatesOff,
} from "./release.js";
import { ABSORBED, RENAMES, editTarget, own, renamedFrom } from "./migrate.js";
import { apply as applyMigration, pending, plan as migrationPlan, revert as revertMigration } from "./migrateHome.mjs";
import { CLI_LINK, botPaneFolders, hooksNotice, openSpaces, relink, syncHooks } from "./migrateHooks.mjs";

export { CHECK_EVERY_MS, FIRST_CHECK_MS, LANE_RELEASE, NO_UPDATE_ENV, PACK_MODS, PACK_NAME, POINTER_SIG_URL, POINTER_URL, RETRY_MS, compareVersions,
  noticeText, packOfPointer, parseSums, pickUpdate, sumsName, tarballName, updatesOff } from "./release.js";

const run = promisify(execFile);
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** The version of a pack with no VERSION file: one installed before releases, older than any. */
export const UNRELEASED = "0.0.0";

export const appHomeOf = (env = process.env) => (env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app")).replace(/\/+$/, "");
export const defaultModsDir = (env = process.env) => join(appHomeOf(env), "mods");
/** Where the record, the kept set, backups and staging live: beside mods/, on the same file system. */
export const stateDirOf = (modsDir) => join(dirname(resolve(modsDir)), "automagik-herdr");
export const prevSetOf = (modsDir) => join(stateDirOf(modsDir), ".prev");
export const markerOf = (modsDir) => join(stateDirOf(modsDir), "installed-by-install.sh");
/** Where a mod switched off waits (the mod manager's setEnabled, or `am uninstall` of one pack mod): beside mods/. */
export const offDirOf = (modsDir) => join(dirname(resolve(modsDir)), "mods-disabled");
const backupOf = (modsDir) => join(stateDirOf(modsDir), "backup");

const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
const isLink = (path) => { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } };
const exists = (path) => { try { lstatSync(path); return true; } catch { return false; } };
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const today = () => new Date().toISOString().slice(0, 10);
/**
 * Where a folder of the record's is: mods/<m>, else mods-disabled/<m> (switched off), else null.
 * A link in mods/ is never the record's to move (a checkout), and hides an off copy.
 */
function placeOf(modsDir, m) {
  const live = join(modsDir, m), off = join(offDirOf(modsDir), m);
  if (isLink(live)) return null;
  if (exists(live)) return live;
  return exists(off) && !isLink(off) ? off : null;
}
/** A folder name the pack may own: lowercase words and dashes, never Pocket Link's. */
const packFolder = (name) => /^[a-z0-9][a-z0-9-]*$/.test(name) && name !== POCKET_LINK;
/** The other name of a renamed folder (old → am-*, am-* → old), or undefined. */
const OLD_OF = Object.fromEntries(Object.entries(RENAMES).map(([old, now]) => [now, old]));
const twinOf = (name) => (Object.hasOwn(RENAMES, name) ? RENAMES[name] : Object.hasOwn(OLD_OF, name) ? OLD_OF[name] : undefined);

/** The version a pack folder carries in its VERSION file (UNRELEASED when it has none). */
export function readVersion(packDir) {
  try { return readFileSync(join(packDir, "VERSION"), "utf8").trim() || UNRELEASED; } catch { return UNRELEASED; }
}

export const readMarker = (modsDir) => { try { return parseMarker(readFileSync(markerOf(modsDir), "utf8")); } catch { return null; } };
const readSet = (modsDir) => { try { return parseMarker(readFileSync(join(prevSetOf(modsDir), ".pack"), "utf8")); } catch { return null; } };

/**
 * The installed pack's version: the ownership record's, else the VERSION in the sidebar folder
 * (PACK_NAME, else its name before the rename, OLD_PACK_NAME, as a hand-installed v0.2 has it).
 */
export const installedVersion = ({ modsDir = defaultModsDir() } = {}) => readMarker(modsDir)?.version
  ?? readVersion(join(modsDir, [PACK_NAME, OLD_PACK_NAME].find((m) => isFile(join(modsDir, m, "VERSION"))) ?? PACK_NAME));

/**
 * Checks `buf` against the sha256sum line for `name` in `sums` (the release's .sha256: its text or parseSums' Map).
 * Returns the hex digest; throws when the name is missing or the digest differs.
 */
export function verifySha256(buf, sums, name) {
  const table = sums instanceof Map ? sums : parseSums(sums);
  const want = table.get(name);
  if (!want) throw new Error(`${name} is not in its .sha256: refusing it`);
  const got = sha256(buf);
  if (got !== want) throw new Error(`${name} does not match its .sha256 (sha256 ${got}, expected ${want}): refusing it`);
  return got;
}

async function download(fetch, url, timeoutMs) {
  const response = await fetch(url, { headers: { "user-agent": "automagik-herdr" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * The keys this pack trusts for the pointer: pack-keys.json beside this file, which the release
 * tarball carries. The installed copy is the trust anchor; a key rotation ships in a pack whose
 * pointer the old key signed.
 */
export const packKeys = (dir = dirname(fileURLToPath(import.meta.url))) => {
  try { return JSON.parse(readFileSync(join(dir, PACK_KEYS_FILE), "utf8"))?.keys ?? []; } catch { return []; }
};

/**
 * pack.json's exact `bytes` and its base64 `signature` checked against `keys` (ed25519, as
 * plugin-lane's lane.json.sig): the update it names (packOfPointer). Throws when its key is not
 * one of `keys` or the signature does not match.
 */
export function verifyPointer(bytes, signature, keys) {
  let pointer;
  try { pointer = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { throw new Error("the pack pointer is not JSON: refusing it"); }
  const key = (keys ?? []).find((k) => k?.keyId === pointer?.keyId);
  if (!key) throw new Error(`the pack pointer is signed by ${pointer?.keyId}, a key this pack does not trust: refusing it`);
  let ok = false;
  try { ok = verifySignature(null, Buffer.from(bytes), createPublicKey(key.publicKey), Buffer.from(String(signature ?? "").trim(), "base64")); } catch {}
  if (!ok) throw new Error("the pack pointer's signature does not match: refusing it");
  return packOfPointer(pointer);
}

/**
 * The newest pack, as the signed pointer names it (verifyPointer), or null when updates are off or
 * there is no pointer yet (404: no pack released here). Throws on any other answer, a missing
 * signature, or one that does not verify.
 */
export async function fetchPointer({ fetch = globalThis.fetch, env = process.env, keys = packKeys(), timeoutMs = TIMEOUT_MS } = {}) {
  if (updatesOff(env)) return null;
  const get = (url) => fetch(url, { headers: { "user-agent": "automagik-herdr" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  const response = await get(POINTER_URL);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for the pack pointer`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const sig = await get(POINTER_SIG_URL);
  if (!sig.ok) throw new Error(`GitHub answered ${sig.status} for the pack pointer's signature: refusing the pointer`);
  return verifyPointer(bytes, await sig.text(), keys);
}

/** Downloads `update`'s tarball (from pickUpdate) into `dir`, checked against the sha256 the signed pointer names before it is written; returns its path. */
export async function downloadUpdate(update, { fetch = globalThis.fetch, dir, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const buf = await download(fetch, update.tarball.url, timeoutMs);
  const got = sha256(buf);
  if (got !== update.sha256) throw new Error(`${update.tarball.name} does not match the signed pointer (sha256 ${got}, expected ${update.sha256}): refusing it`);
  const target = dir ?? mkdtempSync(join(tmpdir(), "automagik-herdr-"));
  mkdirSync(target, { recursive: true });
  const path = join(target, update.tarball.name);
  writeFileSync(path, buf);
  return path;
}

/**
 * What is wrong with a tarball's entries: `names` as `tar -tzf` lists them, `lines` as `tar -tvzf`
 * does (its first character is the entry's type). Every entry must be relative, have no `..`
 * segment, be a plain file or folder, and sit in a pack folder (a lowercase name, never
 * pocket-link) or be `layouts/automagik.json`. Empty when all is well.
 */
export function unsafeEntries(names, lines) {
  if (names.length === 0) return ["the tarball is empty"];
  if (names.length !== lines.length) return ["the tarball's listing does not add up (a name with a line break?)"];
  const problems = [];
  names.forEach((name, i) => {
    const segments = name.split("/");
    const type = lines[i][0];
    if (name.startsWith("/")) problems.push(`${name}: an absolute path`);
    else if (segments.includes("..")) problems.push(`${name}: a .. segment`);
    else if (segments[0] === "layouts" ? !["layouts/", PACK_LAYOUT].includes(name) : !packFolder(segments[0]) || segments.length < 2) {
      problems.push(`${name}: outside the pack's folders`);
    } else if ((type !== "-" && type !== "d") || lines[i].includes(" link to ") || lines[i].includes(" -> ")) {
      problems.push(`${name}: not a plain file or folder`);
    }
  });
  return problems;
}

async function listEntries(tgzPath) {
  const list = async (flags) => (await run("tar", [flags, tgzPath], { maxBuffer: 64 * 1024 * 1024 })).stdout.split("\n").filter((l) => l !== "");
  return unsafeEntries(await list("-tzf"), await list("-tvzf"));
}

/** Paths under `dir` (itself included) that are neither a regular file nor a folder. */
function irregularPaths(dir) {
  const found = [];
  const walk = (path) => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const entry of readdirSync(path)) walk(join(path, entry));
    else if (!stat.isFile()) found.push(path);
  };
  walk(dir);
  return found;
}

/** A mod's private paths, never the pack's to judge: dot entries, node_modules and what herdr-app writes itself. */
const privateName = (name) => name.startsWith(".") || name === "node_modules" || name === "gpui-kit.d.ts" || name === "jsconfig.json";

/**
 * Copies `from`'s private paths into `to` (a staged folder), the person's over the package's. A
 * symlinked `.state` stays a link to the same place; nothing is followed or flattened.
 */
export function carryPrivate(from, to) {
  if (!from || !exists(from) || isLink(from)) return 0;
  let carried = 0;
  for (const name of readdirSync(from)) {
    if (!privateName(name)) continue;
    const src = join(from, name), dst = join(to, name);
    rmSync(dst, { recursive: true, force: true });
    if (isLink(src)) symlinkSync(readlinkSync(src), dst);
    else cpSync(src, dst, { recursive: true, verbatimSymlinks: true });
    carried += 1;
  }
  return carried;
}

/** A free name under backup/: `<mod>-<date>`, then `-2`, `-3`… */
function backupName(modsDir, mod) {
  const base = `${mod}-${today()}`;
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!exists(join(backupOf(modsDir), name))) return name;
  }
}

/**
 * Renames in order, journalled: on any failure every rename already done is reversed (the old
 * folders go back where they were) and the error is thrown. `rename` is injectable for tests.
 */
function swapAll(moves, rename) {
  const done = [];
  try {
    for (const [from, to] of moves) {
      mkdirSync(dirname(to), { recursive: true });
      rename(from, to);
      done.push([from, to]);
    }
  } catch (error) {
    for (const [from, to] of done.reverse()) renameSync(to, from);
    throw error;
  }
}

/**
 * A name under `dir` nothing has: `<prefix><pid>-<random>`. Never an earlier run's leftover (a
 * reused pid), so nothing here deletes a folder it did not make.
 */
function freshPath(dir, prefix) {
  for (;;) {
    const path = join(dir, `${prefix}${process.pid}-${randomBytes(4).toString("hex")}`);
    if (!exists(path)) return path;
  }
}

/**
 * Moves the old kept set out of the way before a swap that replaces it: to `.prev-old-<pid>-<random>`,
 * renamed back by `restoreSet` when the swap fails. Null when nothing is kept yet.
 */
function setAside(modsDir) {
  if (!exists(prevSetOf(modsDir))) return null;
  const old = freshPath(stateDirOf(modsDir), ".prev-old-");
  renameSync(prevSetOf(modsDir), old);
  return old;
}
const restoreSet = (modsDir, old) => { if (old) renameSync(old, prevSetOf(modsDir)); };

/**
 * After a swap: `next` (holding the folders it moved out of mods/) becomes the kept set, then the
 * old set is removed. Never deletes `next`; a step that fails is reported in `warnings` with where
 * the folders are, so a caller never says "nothing was installed" about an install that happened.
 */
function keepSet(modsDir, next, moved, record, old, rename, warnings, off = []) {
  if (moved.length > 0) {
    try {
      // off: the folders that were switched off when kept, so a rollback puts them back off.
      writeFileSync(join(next, ".pack"), formatMarker({ version: record?.version ?? UNRELEASED, mods: moved, sequence: record?.sequence ?? null, off: off.filter((m) => moved.includes(m)) }));
      rename(next, prevSetOf(modsDir));
    } catch (error) {
      warnings.push(`the replaced folders could not become the kept set (${error.message}): they are in ${next}`);
      try { restoreSet(modsDir, old); } catch {}
      return;
    }
  }
  if (!old) return;
  try { rmSync(old, { recursive: true, force: true }); } catch (error) {
    warnings.push(`the older kept set could not be removed (${error.message}): it is in ${old}`);
  }
}

/** In a kept set: the automagik layout its pack placed (the reference copy at the swap), which a
 *  rollback puts back under the same rule as placeLayout's. Dot-named, so no set lists it. */
export const KEPT_LAYOUT = ".layout.json";
const layoutRefOf = (modsDir) => join(stateDirOf(modsDir), "automagik.json");

function keepLayout(modsDir, dir, warnings) {
  try {
    if (isFile(layoutRefOf(modsDir))) cpSync(layoutRefOf(modsDir), join(dir, KEPT_LAYOUT));
  } catch (error) { warnings.push(`the layout was not kept for a rollback (${error.message})`); }
}

/**
 * After a rollback: the rolled-to pack's layout (`body`, from its kept set) goes back in place of
 * the rolled-out pack's when the live one is still that pack's own (byte-equal to the reference),
 * or absent; one the person edited is kept (D8). The reference becomes `body` either way.
 * Returns "restored", "same", "kept", or null (no layout was kept with that set).
 */
export function restoreLayout({ modsDir, body, log = () => {} }) {
  if (!body) return null;
  const live = join(dirname(resolve(modsDir)), PACK_LAYOUT);
  const ref = layoutRefOf(modsDir);
  const had = isFile(live) ? readFileSync(live) : null;
  const lastPack = isFile(ref) ? readFileSync(ref) : null;
  let placed = "kept";
  if (had && had.equals(body)) placed = "same";
  else if (had && lastPack && had.equals(lastPack)) {
    writeFileSync(live, body);
    log(`put back the automagik layout the rolled-back pack shipped (${live})`);
    placed = "restored";
  } else if (had) log(`kept your automagik layout (${live}): you changed it; the rolled-back pack's is in ${ref}`);
  else placed = "same"; // the person removed it: a rollback doesn't add it back
  writeFileSync(ref, body);
  return placed;
}

export const writeMarker = (modsDir, record) => {
  const path = markerOf(modsDir);
  writeFileSync(`${path}.tmp`, formatMarker(record));
  renameSync(`${path}.tmp`, path);
};

/**
 * v0.2.x left `<OLD_PACK_NAME>.before-install` (the pack found at the first install) and
 * `<OLD_PACK_NAME>.prev` in the state folder: both move to backup/, the first recorded as adopted
 * so --uninstall puts it back.
 */
function carryV1(modsDir, record, log) {
  const state = stateDirOf(modsDir);
  for (const [old, adopted] of [[`${OLD_PACK_NAME}.before-install`, true], [`${OLD_PACK_NAME}.prev`, false]]) {
    if (!exists(join(state, old))) continue;
    const name = backupName(modsDir, `${OLD_PACK_NAME}-${adopted ? "before-install" : "v0.2-prev"}`);
    mkdirSync(backupOf(modsDir), { recursive: true });
    renameSync(join(state, old), join(backupOf(modsDir), name));
    if (adopted) record.adopted.push({ mod: OLD_PACK_NAME, path: `backup/${name}` });
    log(`kept v0.2's ${old} in ${join(backupOf(modsDir), name)}`);
  }
}

/**
 * Installs the pack in `tgzPath` (a verified release tarball) into `modsDir`, as one unit. The
 * tarball's folders must be exactly the PACK_MODS of the release.js it carries, each with main.js
 * and mod.json, plain files and folders only, and its VERSION must be `version`. Per folder:
 * not there → installed; listed in the ownership record → replaced (the old copy into the kept
 * set, its private paths carried over); anyone else's → left alone, or with `adopt` moved to
 * backup/ and replaced. A link is never replaced. Returns `{ version, mods, installed, replaced,
 * left, adopted, retired, prev }` and rewrites the record.
 */
/**
 * Unpacks a release tarball into `staging` (an empty folder) and checks it is a plain pack: only
 * folders and plain files, its folders exactly the PACK_MODS of the release.js it carries, each with
 * main.js and mod.json, and VERSION `version`. Returns its mod folders, sorted.
 */
async function stagePack(tgzPath, version, staging) {
  const unsafe = await listEntries(resolve(tgzPath));
  if (unsafe.length > 0) throw new Error(`${tgzPath} is not a plain pack (${unsafe.slice(0, 3).join("; ")}): refusing it`);
  await run("tar", ["-xzf", resolve(tgzPath), "-C", staging]);
  const irregular = irregularPaths(staging);
  if (irregular.length > 0) throw new Error(`${tgzPath} unpacked a link or special file (${irregular[0]}): refusing it`);
  const folders = readdirSync(staging).filter((n) => n !== "layouts").sort();
  const carrier = folders.filter((n) => isFile(join(staging, n, "update.mjs")) && isFile(join(staging, n, "release.js")));
  if (carrier.length !== 1) throw new Error(`${tgzPath} holds no one folder with update.mjs and release.js: refusing it`);
  const { PACK_MODS: listed } = await import(pathToFileURL(join(staging, carrier[0], "release.js")).href);
  if (!Array.isArray(listed) || [...listed].sort().join(",") !== folders.join(",") || !listed.every(packFolder)) {
    throw new Error(`${tgzPath}'s folders (${folders.join(", ")}) are not its PACK_MODS (${listed}): refusing it`);
  }
  for (const m of folders) {
    if (!isFile(join(staging, m, "main.js")) || !isFile(join(staging, m, "mod.json"))) throw new Error(`${tgzPath}: ${m}/ has no main.js and mod.json: refusing it`);
  }
  const carried = readVersion(join(staging, carrier[0]));
  if (carried !== version) throw new Error(`${tgzPath} carries VERSION ${carried}, not ${version}: refusing it`);
  return folders;
}

/** The files under `dir` (relative paths), a mod's private paths (privateName) left out. */
function shippedFiles(dir, rel = "") {
  const found = [];
  for (const name of readdirSync(join(dir, rel)).sort()) {
    if (rel === "" && privateName(name)) continue;
    const path = rel ? `${rel}/${name}` : name;
    if (lstatSync(join(dir, path)).isDirectory()) found.push(...shippedFiles(dir, path));
    else found.push(path);
  }
  return found;
}

/**
 * Checks an installed pack against the release tarball it came from (`tgzPath`, already checked
 * against its .sha256), changing nothing. Every pack folder the ownership record lists must hold
 * each of the release's files byte for byte (a mod's private paths and files it added are not
 * judged), and a shipped executable must still be executable. A folder the record lists that is
 * not in mods/ is missing, unless the mod manager switched it off (moved it to <app
 * home>/mods-disabled/): that stays off. A folder the record does not list (the person's own,
 * present or not) and a link are left out. Returns `{ version, missing, damaged: [{ mod,
 * files }], repair, layout }`: `repair` lists the folders to reinstall, `layout` is "missing"
 * when <app home>/layouts/automagik.json is gone, else "present".
 */
export async function verifyInstall({ tgzPath, version, modsDir = defaultModsDir() }) {
  const staging = mkdtempSync(join(tmpdir(), "automagik-herdr-verify-"));
  try {
    const folders = await stagePack(tgzPath, version, staging);
    const owned = new Set(readMarker(modsDir)?.mods ?? []);
    const disabled = offDirOf(modsDir);
    const missing = [], damaged = [];
    for (const m of folders) {
      if (m.toLowerCase() === POCKET_LINK) continue;
      const live = join(modsDir, m);
      if (isLink(live)) continue;
      if (!owned.has(m)) continue;
      if (!exists(live)) {
        if (!exists(join(disabled, m))) missing.push(m);
        continue;
      }
      const files = shippedFiles(join(staging, m)).filter((f) => {
        const at = join(live, f);
        const want = join(staging, m, f);
        if (!isFile(at) || isLink(at) || !readFileSync(at).equals(readFileSync(want))) return true;
        // A shipped executable that lost its exec bit (gaining one is harmless: install.sh chmods the command).
        return (statSync(want).mode & 0o111) !== 0 && (statSync(at).mode & 0o111) === 0;
      });
      if (files.length) damaged.push({ mod: m, files });
    }
    const layout = isFile(join(dirname(resolve(modsDir)), PACK_LAYOUT)) ? "present" : "missing";
    return { version, missing, damaged, repair: [...missing, ...damaged.map((d) => d.mod)].sort(), layout };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function applyUpdate({ tgzPath, version, sequence = null, modsDir = defaultModsDir(), adopt = false, repair = null, log = () => {}, rename = renameSync }) {
  if (typeof version !== "string" || version === "") throw new Error("applyUpdate needs the release's version");
  const state = stateDirOf(modsDir);
  mkdirSync(state, { recursive: true });
  const staging = mkdtempSync(join(state, "staging-"));
  const next = freshPath(state, ".prev-next-");
  let swapped = false;
  try {
    const folders = await stagePack(tgzPath, version, staging);

    const before = readMarker(modsDir);
    if (repair && before?.version !== version) throw new Error(`the installed pack is ${before?.version ?? "not this installer's"}, not ${version}: nothing to repair`);
    const record = {
      version, mods: [], layout: before?.layout ?? null, before: before?.before ?? "none", adopted: [...(before?.adopted ?? [])],
      migrated: [...(before?.migrated ?? [])], usagemeter: before?.usagemeter ?? null,
      usagemeterOn: { ...(before?.usagemeterOn ?? {}) }, usagemeterScope: before?.usagemeterScope ?? null,
      // When the pack was put in place (the mod manager's INSTALLED); a repair keeps the date.
      installed: (repair ? before?.installed : null) ?? new Date().toISOString(),
      // The signed pointer's sequence when this release came through it; a repair keeps the record's.
      sequence: sequence ?? (repair ? before?.sequence ?? null : null),
    };
    const owned = new Set(before?.mods ?? []);
    const kept = readSet(modsDir);
    const plan = { installed: [], replaced: [], renamed: [], left: [], adopted: [], retired: [], repaired: [], off: [] };
    const keptOff = [];
    const both = [];
    const moves = [];
    // A folder the person owns moves to backup/ (never replaced) and is recorded, so --uninstall puts it back.
    const adoptFolder = (m) => {
      const name = backupName(modsDir, m);
      moves.push([join(modsDir, m), join(backupOf(modsDir), name)]);
      plan.adopted.push({ mod: m, backup: join(backupOf(modsDir), name) });
      record.adopted.push({ mod: m, path: `backup/${name}` });
    };
    for (const m of folders) {
      const live = join(modsDir, m), fresh = join(staging, m);
      // A repair reinstalls only the folders it names; every other one the record lists stays as it
      // is, and one it doesn't list (the person's own, or one they removed) is never installed.
      if (repair && !repair.includes(m)) { if (owned.has(m)) record.mods.push(m); continue; }
      // A mod of the record's switched off (in mods-disabled/, not mods/) is updated where it is and
      // stays off: its old copy goes into the kept set like any replaced folder, never back on.
      const off = join(offDirOf(modsDir), m);
      if (owned.has(m) && !exists(live) && exists(off) && !isLink(off)) {
        carryPrivate(off, fresh);
        moves.push([off, join(next, m)], [fresh, off]);
        plan.replaced.push(m);
        plan.off.push(m);
        keptOff.push(m);
        record.mods.push(m);
        continue;
      }
      if (owned.has(m) && exists(live) && exists(off)) both.push(m);
      if (isLink(live)) {
        if (owned.has(m)) throw new Error(`${live} is a link (a checkout?): update it with git instead`);
        plan.left.push(m);
        continue;
      }
      if (!exists(live)) {
        // Across the rename: the old-named folder's private paths come into its am-* folder. The
        // record's leaves with the kept set (below); a person's own is left, or adopted.
        const old = own(OLD_OF, m), oldLive = old && join(modsDir, old);
        if (old && exists(oldLive) && !isLink(oldLive)) {
          if (owned.has(old)) { carryPrivate(oldLive, fresh); plan.renamed.push([old, m]); }
          else if (adopt) { carryPrivate(oldLive, fresh); adoptFolder(old); }
          else plan.left.push(old);
        } else if (kept?.mods.includes(m)) carryPrivate(join(prevSetOf(modsDir), m), fresh);
        // (A folder a rollback or --uninstall moved into the kept set comes back with its state.)
        plan.installed.push(m);
      } else if (owned.has(m) && repair) {
        // A damaged copy of the installed release goes to backup/, never into the kept set: that
        // stays the release before, for a rollback. Not recorded as adopted: --uninstall leaves it.
        carryPrivate(live, fresh);
        const backup = join(backupOf(modsDir), backupName(modsDir, m));
        moves.push([live, backup]);
        plan.repaired.push({ mod: m, backup });
      } else if (owned.has(m)) {
        carryPrivate(live, fresh);
        moves.push([live, join(next, m)]);
        plan.replaced.push(m);
      } else if (adopt) {
        carryPrivate(live, fresh);
        adoptFolder(m);
      } else {
        plan.left.push(m);
        continue;
      }
      moves.push([fresh, live]);
      record.mods.push(m);
    }
    // A person's old-named folder beside its am-* folder (left by an earlier run without --adopt):
    // left again, or adopted now. With no am-* folder yet, the loop above decided it.
    for (const m of repair ? [] : folders) {
      const old = own(OLD_OF, m), oldLive = old && join(modsDir, old);
      if (!old || owned.has(old) || plan.left.includes(old) || plan.adopted.some((a) => a.mod === old)) continue;
      if (!exists(oldLive) || isLink(oldLive)) continue;
      if (adopt) adoptFolder(old);
      else plan.left.push(old);
    }
    // A mod another pack mod took in (migrate.js ABSORBED): the record's leaves with the
    // set (below); a person's own is left, or adopted, once the mod that took it in is shipped.
    for (const [m, into] of Object.entries(ABSORBED)) {
      const live = join(modsDir, m);
      if (owned.has(m) || !exists(live) || isLink(live) || !(folders.includes(into) || folders.includes(RENAMES[into]))) continue;
      if (adopt) adoptFolder(m);
      else plan.left.push(m);
    }
    // A folder the record lists that this release no longer ships leaves mods/ with the set.
    for (const m of repair ? [] : owned) {
      if (folders.includes(m) || !packFolder(m)) continue;
      const at = placeOf(modsDir, m);
      if (!at) continue;
      moves.push([at, join(next, m)]);
      plan.retired.push(m);
      if (at !== join(modsDir, m)) keptOff.push(m);
    }
    mkdirSync(modsDir, { recursive: true });
    const keep = [...plan.replaced, ...plan.retired];
    const old = keep.length ? setAside(modsDir) : null;
    try {
      swapAll(moves, rename);
    } catch (error) {
      restoreSet(modsDir, old);
      throw error;
    }
    swapped = true;
    // From here the new folders are live: nothing below undoes them or deletes `next`, and the
    // record is written first so it always names what mods/ holds.
    const warnings = [];
    try { writeMarker(modsDir, record); } catch (error) { warnings.push(`the ownership record could not be written (${error.message})`); }
    if (before?.v1) { try { carryV1(modsDir, record, log); writeMarker(modsDir, record); } catch (error) { warnings.push(`v0.2's kept copies stay where they were (${error.message})`); } }
    if (keep.length) keepLayout(modsDir, next, warnings);
    keepSet(modsDir, next, keep, before, old, rename, warnings, keptOff);
    for (const m of plan.off) log(`updated mods-disabled/${m}: it stays off`);
    for (const m of both) log(`warning: mods/${m} and mods-disabled/${m} both exist: mods/${m} was updated, the switched-off copy is left as it is`);
    for (const m of plan.left) {
      const why = Object.hasOwn(ABSORBED, m) ? "the pack's sidebar or Markdown mod does its job now" : "--adopt moves it to backup/ and installs the pack's";
      log(`left alone: mods/${m} (not installed by automagik-herdr; ${why})`);
    }
    for (const a of plan.adopted) log(`adopted mods/${a.mod}: the original is kept in ${a.backup}`);
    for (const r of plan.repaired) log(`repaired mods/${r.mod}: reinstalled ${version}; the damaged copy is kept in ${r.backup}`);
    for (const m of repair ? plan.installed : []) log(`repaired mods/${m}: it was missing; installed ${version}`);
    for (const w of warnings) log(`warning: ${w}`);
    return { version, mods: record.mods, ...plan, prev: keep.length && !exists(next) ? prevSetOf(modsDir) : null, warnings };
  } finally {
    rmSync(staging, { recursive: true, force: true });
    if (!swapped) rmSync(next, { recursive: true, force: true });
  }
}

/**
 * Swaps the kept set back in: every folder of the current set leaves mods/ for the new kept set,
 * every folder of the kept one comes back (private paths carried over), so a second rollback
 * undoes the first. Refuses, changing nothing, when a folder in the way is not the record's.
 */
export function rollback({ modsDir = defaultModsDir(), rename = renameSync, log = () => {}, binDir = null, window = false } = {}) {
  const set = readSet(modsDir);
  const prev = prevSetOf(modsDir);
  if (!set || set.mods.length === 0) throw new Error(`no earlier pack kept at ${prev}: nothing to roll back to`);
  const record = readMarker(modsDir) ?? { version: UNRELEASED, mods: [], layout: null, before: "none", adopted: [] };
  const owned = new Set(record.mods);
  // The layout the kept set's pack placed, read before the set moves (null: kept before v0.9).
  let keptLayout = null;
  try { if (isFile(join(prev, KEPT_LAYOUT))) keptLayout = readFileSync(join(prev, KEPT_LAYOUT)); } catch {}
  const next = freshPath(stateDirOf(modsDir), ".prev-next-");
  const moves = [];
  const out = [];
  for (const m of set.mods) {
    const live = join(modsDir, m);
    if (!packFolder(m) || !exists(join(prev, m))) throw new Error(`the kept set lists ${m}, which is not there: nothing rolled back`);
    if (isLink(live)) throw new Error(`${live} is a link (a checkout?): roll it back with git instead`);
    if (exists(live) && !owned.has(m)) throw new Error(`mods/${m} is not this installer's: nothing rolled back`);
    const offNow = join(offDirOf(modsDir), m);
    if (!exists(live) && set.off.includes(m) && exists(offNow) && !owned.has(m)) throw new Error(`mods-disabled/${m} is not this installer's: nothing rolled back`);
  }
  const outOff = [];
  for (const m of set.mods) {
    const live = join(modsDir, m);
    const off = join(offDirOf(modsDir), m);
    if (exists(live)) {
      carryPrivate(live, join(prev, m));
      moves.push([live, join(next, m)]);
      out.push(m);
    } else if (owned.has(m) && exists(off) && !isLink(off)) {
      // Switched off: the kept copy comes back where it is, still off.
      carryPrivate(off, join(prev, m));
      moves.push([off, join(next, m)], [join(prev, m), off]);
      out.push(m);
      outOff.push(m);
      continue;
    } else if (set.off.includes(m)) {
      // Not here now (a release retired it, or this set is older than it), and it was off when
      // kept: it comes back off.
      moves.push([join(prev, m), off]);
      continue;
    } else {
      // Across the rename: the live twin's private paths go back with it (it leaves below).
      const twin = twinOf(m), twinLive = twin && join(modsDir, twin);
      if (twin && owned.has(twin) && !set.mods.includes(twin) && exists(twinLive) && !isLink(twinLive)) carryPrivate(twinLive, join(prev, m));
    }
    moves.push([join(prev, m), live]);
  }
  for (const m of owned) {
    if (set.mods.includes(m) || !packFolder(m)) continue;
    const at = placeOf(modsDir, m);
    if (!at) continue;
    moves.push([at, join(next, m)]);
    out.push(m);
    if (at !== join(modsDir, m)) outOff.push(m);
  }
  // The kept set's folders come back out of `prev`, which then holds only what stays behind
  // (.pack and anything unlisted): it is set aside, and removed only once the swap stands.
  try {
    swapAll(moves, rename);
  } catch (error) {
    rmSync(next, { recursive: true, force: true });
    throw error;
  }
  const warnings = [];
  // A folder the person had, adopted into backup/, comes back where mods/ is free once this
  // rollback drops the pack's copy of it (Group 3, D10): its own name or its renamed twin left
  // mods/; a mod the pack absorbed comes back when the set rolled back to has no am-* mod that
  // absorbed it (am-sidebar, am-markdown). Decided from the pack's sets only, never from a
  // person's folder that shares a name.
  const left = new Set(out);
  const dropped = (m) => {
    const into = own(ABSORBED, m);
    if (into) return !set.mods.includes(own(RENAMES, into) ?? into);
    const copies = [m, twinOf(m)].filter(Boolean);
    return copies.some((c) => left.has(c)) && !copies.some((c) => set.mods.includes(c));
  };
  const adopted = [];
  for (const a of record.adopted) {
    const from = join(stateDirOf(modsDir), a.path), to = join(modsDir, a.mod);
    if (exists(to) || !exists(from) || isLink(from) || !dropped(a.mod)) { adopted.push(a); continue; }
    try { renameSync(from, to); log(`put back mods/${a.mod} from ${a.path}`); } catch (error) {
      warnings.push(`mods/${a.mod} stays in ${from} (${error.message})`);
      adopted.push(a);
    }
  }
  try { writeMarker(modsDir, { ...record, version: set.version ?? UNRELEASED, mods: set.mods, adopted, installed: new Date().toISOString(), sequence: set.sequence ?? null }); } catch (error) { warnings.push(`the ownership record could not be written (${error.message})`); }
  let old = null;
  try { old = setAside(modsDir); } catch (error) { warnings.push(`the old kept set stays in ${prev} (${error.message})`); }
  // The rolled-out pack's layout goes with its folders, so a second rollback brings it back.
  if (out.length && exists(next)) keepLayout(modsDir, next, warnings);
  if (old || !exists(prev)) keepSet(modsDir, next, out, record, old, rename, warnings, outOff);
  else warnings.push(`the folders rolled out are in ${next}`);
  let layout = null;
  try { layout = restoreLayout({ modsDir, body: keptLayout, log }); } catch (error) { warnings.push(`the automagik layout was not put back (${error.message})`); }
  // The migration's edits whose mod left mods/ in this rollback are reverted from the journals
  // (an edit to a mod still installed stays); then the references follow the folders now in
  // place (forward again, they move again).
  const reverted = revertRefs({ modsDir, log, warnings, left: (mod) => left.has(mod) && !set.mods.includes(mod) });
  const migration = migrateRefs({ modsDir, log, warnings });
  const hooks = moveHooks({ modsDir, log, warnings, binDir, window });
  return { pack: modsDir, prev, mods: set.mods, version: set.version, layout, reverted: reverted.restored, migration, hooks, warnings };
}

/**
 * The rename migration after the folders (Group 6a): layouts and keys.json follow the folders
 * the record says were renamed, each rewritten file backed up into backup/layouts-<date>/ with a
 * journal the record lists (`migrated=`). A failure is a warning: the folders are already in place.
 * Returns migrateHome's `{ done, skipped, journal }`, or null when it failed.
 */
export function migrateRefs({ modsDir, log = () => {}, warnings = [] }) {
  const home = dirname(resolve(modsDir));
  try {
    const p = migrationPlan(home);
    if (!pending(p)) {
      const kept = p.left.length ? `; ${p.left.length} reference(s) stay as they are (--adopt takes the mods you kept)` : "";
      log(`rename migration: nothing to migrate${kept}`);
      return { done: [], skipped: p.left, journal: null };
    }
    if (p.shared.length) log(`shared keys move to am.* when their mod next loads: ${p.shared.map(([o]) => o).join(", ")}`);
    // The journal goes into the record before the first rewrite, so a rollback reverts whatever
    // was rewritten even if the run stops part-way; without a record, nothing is rewritten.
    const onJournal = (dir) => {
      const record = readMarker(modsDir);
      if (!record) throw new Error("there is no ownership record to list the journal in");
      writeMarker(modsDir, { ...record, migrated: [...record.migrated, `backup/${basename(dir)}`] });
    };
    const r = applyMigration(p, { backupDir: join(backupOf(modsDir), backupName(modsDir, "layouts")), onJournal });
    for (const line of r.done) log(line);
    for (const s of r.skipped) log(`left: ${s.item} (${s.reason})`);
    return r;
  } catch (error) {
    warnings.push(`layouts and keys were not migrated to the new names (${error.message}); the backups so far are in ${backupOf(modsDir)}`);
    return null;
  }
}

/**
 * Reverts, newest journal first, every edit the record's journals list whose mod is no longer in
 * mods/ or whose pack copy `left` this rollback (an edit pointing at a mod the pack still
 * installs stays valid and stays); a journal with nothing
 * left leaves the record's `migrated=` (its backups stay).
 */
export function revertRefs({ modsDir, log = () => {}, warnings = [], left = () => false }) {
  const record = readMarker(modsDir);
  const restored = [];
  // `left(mod)`: the pack's copy of that mod left mods/ in this rollback (a person's own may be back).
  const gone = (edit) => { const mod = editTarget(edit); return !mod || left(mod) || !exists(join(modsDir, mod)); };
  try {
    const still = [];
    for (const path of [...(record?.migrated ?? [])].reverse()) {
      const r = revertMigration(join(stateDirOf(modsDir), path), { due: gone });
      restored.push(...r.restored);
      if (r.remaining) still.unshift(path);
      for (const f of r.restored) log(`restored the old names in ${f}`);
      for (const s of r.skipped) log(`left: ${s.item} (${s.reason})`);
    }
    if (record && still.length !== record.migrated.length) writeMarker(modsDir, { ...record, migrated: still });
  } catch (error) {
    warnings.push(`the rename migration was not reverted (${error.message}); the originals are in ${backupOf(modsDir)}/layouts-*`);
  }
  return { restored };
}

/** Where install.sh links the CLI: $HOME/.local/bin. */
export const binDirOf = (env = process.env) => join(env.HOME || homedir(), ".local", "bin");
/**
 * Whether a run crossed the rename: `before` is oldSidebarHere(modsDir) taken before it, and the
 * sidebar's folder from before the rename (OLD_PACK_NAME) is gone from mods/ now.
 */
export const oldSidebarHere = (modsDir) => exists(join(modsDir, OLD_PACK_NAME));
export const crossedRename = (modsDir, before) => before && !oldSidebarHere(modsDir);

/** Whether `modsDir` is in the app home Herdr runs by default: only then are the open spaces asked for. */
export const liveHome = (modsDir) => dirname(resolve(modsDir)) === join(homedir(), ".config", "herdr-app");

/**
 * The briefing hooks and the CLI link after the folders and references (Group 6b, migrateHooks.mjs
 * syncHooks and relink). `binDir`: the folder holding the CLI link (null: the link is not looked at);
 * `window`: also the open spaces' and the bot panes' folders (`herdr-app ls`, `hc`). A failure is a warning.
 * `crossed`: this run moved the sidebar off its folder from before the rename (crossedRename), so
 * the hooks notice warns even when no settings file was rewritten.
 * Returns `{ hooks, link }` (hooks: syncHooks's result plus `crossed`, or null; link: the line logged or null).
 */
export function moveHooks({ modsDir, log = () => {}, warnings = [], binDir = null, window = false, crossed = false }) {
  let hooks = null;
  let link = null;
  try { hooks = { ...syncHooks({ modsDir, extra: window ? [...openSpaces(), ...botPaneFolders()] : [], log }), crossed }; } catch (error) {
    warnings.push(`the briefing hooks were not moved (${error.message}); each rewritten settings.local.json has its backup beside it`);
  }
  if (binDir) {
    try {
      link = relink({ binDir, modsDir, owned: new Set(readMarker(modsDir)?.mods ?? []) });
      if (link) log(link);
    } catch (error) { warnings.push(`${join(binDir, CLI_LINK)} was not repointed (${error.message})`); }
  }
  return { hooks, link };
}

/** A keys.json that will not parse stops the run before any folder moves. */
export function preflightKeys(appHome) {
  const path = join(appHome, "keys.json");
  if (!existsSync(path)) return;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
  } catch (error) {
    throw new Error(`${path} is unreadable (${error.message}): nothing was installed`);
  }
}

/**
 * install.sh's part after the folders land: free keys only (a key in use stays the person's),
 * the mod manager's catalog.json, the layout (added when absent; replaced only when byte-identical
 * to v0.2.x's or to the last pack's, D8; otherwise kept with a note) and `herdr-app check` on
 * every installed mod. Returns the mods whose check failed.
 */
export function setupHome({ modsDir, tgzDir, record, log = () => {}, herdrApp = "herdr-app" }) {
  const appHome = dirname(resolve(modsDir));
  const keysPath = join(appHome, "keys.json");
  const mine = existsSync(keysPath) ? JSON.parse(readFileSync(keysPath, "utf8")) : {};
  let added = 0;
  for (const [section, entries] of Object.entries(PACK_KEYS)) {
    for (const [key, action] of Object.entries(entries)) {
      const current = mine[section]?.[key];
      if (current === undefined) { (mine[section] ??= {})[key] = action; added += 1; log(`key + ${key} → ${action} (${section})`); }
      else if (current !== action) log(`key = ${key} stays ${current} (${section})`);
    }
  }
  if (added) writeFileSync(keysPath, JSON.stringify(mine, null, 2) + "\n");
  // The mod manager's catalog: it reads data/am-mods/catalog.json, then the one in its data folder
  // from before the rename (core.js catalogUrl). Each one there that still holds a URL the pack
  // wrote gets the current one; a URL the person set, a file it can't read or a link stays theirs.
  // With neither, the pack's goes in data/am-mods/. An absolute path whose file is gone is only
  // noted, never rewritten: it may be an unmounted volume or a moved checkout, and core.js
  // falls back to the published index until it is back.
  const catalogs = ["am-mods", renamedFrom(RENAMES, "am-mods")].map((d) => join(appHome, "data", d, "catalog.json"));
  for (const file of catalogs.filter(exists)) {
    let url = null, gone = false;
    try {
      if (isLink(file)) url = "(a link)";
      else {
        url = JSON.parse(readFileSync(file, "utf8"))?.url ?? null;
        gone = typeof url === "string" && url.startsWith("/") && !existsSync(url);
      }
    } catch { url = "(unreadable)"; }
    if (gone) log(`your mod manager catalog ${url} is missing; the mod manager uses the published index until it is back`);
    else if (url && !PACK_CATALOG_URLS.includes(url)) log(`kept your mod manager catalog (${url}) in ${file}`);
    else if (url !== CATALOG_URL) writeFileSync(file, JSON.stringify({ url: CATALOG_URL }, null, 2) + "\n");
  }
  if (!catalogs.some(exists)) {
    mkdirSync(dirname(catalogs[0]), { recursive: true });
    writeFileSync(catalogs[0], JSON.stringify({ url: CATALOG_URL }, null, 2) + "\n");
  }

  placeLayout({ modsDir, tgzDir, record, log });
  return checkMods({ modsDir, mods: record.mods, log, herdrApp }).failed;
}

/**
 * The pack's layout (D8): added when absent; replaced only when byte-identical to v0.2.x's or to
 * the last pack's; otherwise kept with a note. Records it and keeps the pack's copy as the
 * reference. Returns "added", "replaced", "kept", "same", "removed" (the record says the person
 * uninstalled it: `layout=removed`, left out) or null (the tarball has none).
 */
export function placeLayout({ modsDir, tgzDir, record, log = () => {} }) {
  const appHome = dirname(resolve(modsDir));
  const shipped = join(tgzDir, PACK_LAYOUT);
  const ref = join(stateDirOf(modsDir), "automagik.json");
  const live = join(appHome, PACK_LAYOUT);
  let placed = null;
  if (isFile(shipped)) {
    const body = readFileSync(shipped);
    const had = isFile(live) ? readFileSync(live) : null;
    const lastPack = isFile(ref) ? readFileSync(ref) : null;
    if (!had && record.layout === "removed") {
      // Uninstalled on its own (the herdr.layout part): an update or a repair never adds it back.
      log(`left out the automagik layout: it was uninstalled (\`am install herdr.layout\` puts it back)`);
      placed = "removed";
    } else if (!had || sha256(had) === V020_LAYOUT_SHA256 || (lastPack && had.equals(lastPack))) {
      placed = "same";
      if (!had || !had.equals(body)) {
        mkdirSync(dirname(live), { recursive: true });
        writeFileSync(live, body);
        log(had ? `replaced the automagik layout (${live}): it was the one an older release shipped` : `added the automagik layout (${live})`);
        placed = had ? "replaced" : "added";
      }
    } else {
      log(`kept your automagik layout (${live}): it differs from the one v0.2 shipped; the pack's is in ${ref}`);
      placed = "kept";
    }
    if (placed !== "removed") record.layout = !had || record.layout === "added" ? "added" : "kept";
    writeFileSync(ref, body);
    writeMarker(modsDir, record);
  }
  return placed;
}

/**
 * `herdr-app check` on each of `mods`, its whole output shown on a failure. Returns `{ failed,
 * checked }`: the mods whose check failed, and false when herdr-app is not on PATH (said once).
 */
export function checkMods({ modsDir, mods, log = () => {}, herdrApp = "herdr-app" }) {
  const failed = [];
  let haveHerdr = true;
  for (const m of mods) {
    if (!haveHerdr) break;
    try {
      execFileSync(herdrApp, ["check", join(modsDir, m)], { stdio: "pipe" });
      log(`check passed: ${m}`);
    } catch (error) {
      if (error.code === "ENOENT") { haveHerdr = false; log("herdr-app is not on PATH: no mod was checked"); break; }
      failed.push(m);
      const [first, ...rest] = String(error.stderr || error.stdout || error.message).trim().split("\n");
      log(`check FAILED: ${m}: ${first}`);
      for (const line of rest) log(`    ${line}`);
    }
  }
  return { failed, checked: haveHerdr && mods.length > 0 };
}

/**
 * Points the CLI link at the entry the installed pack has: bin/automagik-herdr (it runs the .mjs
 * through bin/run.sh, which finds node 22.7+ or bun where PATH has none) or, in a pack from before
 * it (a rollback), bin/automagik-herdr.mjs. Only a link to one of those two in this pack, or in
 * the sidebar's folder from before the rename (OLD_PACK_NAME: a v0.4.x link the migration didn't
 * move), is ours; one from the old folder moves only onto an entry that is there. A file, a
 * missing link or one pointing elsewhere is left alone. Cheap (an lstat, a readlink)
 * and idempotent: the CLI runs it on every start. Returns `{ link, from, to }` when it
 * repointed the link, else null; throws only when the swap itself fails.
 */
export function relinkCli({ modsDir = defaultModsDir(), name = PACK_NAME, binDir = binDirOf() } = {}) {
  if (!binDir) return null;
  const link = join(binDir, CLI_LINK);
  if (!isLink(link)) return null;
  const from = readlinkSync(link);
  const entries = (m) => ["automagik-herdr", "automagik-herdr.mjs"].map((f) => join(resolve(modsDir), m, "bin", f));
  const [wrapper, mjs] = entries(name);
  const now = resolve(dirname(link), from);
  const old = name !== OLD_PACK_NAME && entries(OLD_PACK_NAME).includes(now);
  if (now !== wrapper && now !== mjs && !old) return null;
  const to = isFile(wrapper) ? wrapper : mjs;
  if (now === to || (old && !isFile(to))) return null;
  const tmp = join(binDir, `.${CLI_LINK}.relink-${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(to, tmp);
  try { renameSync(tmp, link); } catch (error) { rmSync(tmp, { force: true }); throw error; }
  return { link, from, to };
}

/**
 * `{ current, latest, update, disabled }`: latest is the version the signed pointer names, or null
 * (no pack released yet); update from pickUpdate. `keys`: the trusted keys (packKeys by default).
 */
export async function checkForUpdate({ fetch = globalThis.fetch, env = process.env, modsDir = defaultModsDir(env), keys } = {}) {
  const current = installedVersion({ modsDir });
  if (updatesOff(env)) return { current, latest: null, update: null, disabled: true };
  const pack = await fetchPointer({ fetch, env, ...(keys ? { keys } : {}) });
  return { current, latest: pack?.version ?? null, update: pickUpdate(current, pack), disabled: false };
}

/**
 * check, then download, verify and apply when there is an update. `{ current, latest, update, installed }`.
 * `expect`: the version the person confirmed (the status bar's dialog). When the latest release
 * is another one by now, nothing is downloaded: `{ ..., installed: null, refused: { expected, latest } }`.
 */
export async function installUpdate({ fetch = globalThis.fetch, env = process.env, modsDir = defaultModsDir(env), keys, log, binDir = null, window = false, expect = null } = {}) {
  const found = await checkForUpdate({ fetch, env, modsDir, keys });
  if (!found.update) return { ...found, installed: null };
  if (expect && found.update.version !== expect) return { ...found, installed: null, refused: { expected: expect, latest: found.update.version } };
  const dir = mkdtempSync(join(tmpdir(), "automagik-herdr-"));
  try {
    const tgzPath = await downloadUpdate(found.update, { fetch, dir });
    const before = oldSidebarHere(modsDir);
    const installed = await applyUpdate({ tgzPath, version: found.update.version, sequence: found.update.sequence, modsDir, log });
    // The release's layout, as install.sh --setup places it (D8: one the person edited is kept),
    // so an update shows what the release added to it; then the person's layouts are migrated.
    const tgzDir = join(dir, "layout");
    try {
      mkdirSync(tgzDir);
      await run("tar", ["-xzf", resolve(tgzPath), "-C", tgzDir, PACK_LAYOUT]).catch(() => {});
      installed.layout = placeLayout({ modsDir, tgzDir, record: readMarker(modsDir), log });
    } catch (error) { installed.warnings.push(`the automagik layout was not placed (${error.message})`); }
    installed.migration = migrateRefs({ modsDir, log, warnings: installed.warnings });
    installed.hooks = moveHooks({ modsDir, log, warnings: installed.warnings, binDir, window, crossed: crossedRename(modsDir, before) });
    return { ...found, installed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * install.sh's same-version rerun: checks the installed pack against the release tarball
 * (verifyInstall), reinstalls each missing or damaged folder (applyUpdate's repair: the damaged
 * copy to backup/, the kept set untouched), puts back a missing automagik layout (placeLayout), then
 * runs `herdr-app check` on every pack mod. `{ version, repaired, layout, checkFailed, checked, changed }`
 * (`checked` false: herdr-app is not on PATH, so no mod was checked);
 * `changed` is false only when every file matched the release and no folder or layout was put
 * back (the layout's reference copy and the record are rewritten as on every install).
 */
export async function repairInstall({ tgzPath, version, modsDir = defaultModsDir(), log = () => {}, herdrApp = "herdr-app", window = false }) {
  const found = await verifyInstall({ tgzPath, version, modsDir });
  for (const m of found.missing) log(`missing: mods/${m}`);
  for (const d of found.damaged) {
    log(`differs from the release: mods/${d.mod} (${d.files.slice(0, 5).join(", ")}${d.files.length > 5 ? `, and ${d.files.length - 5} more` : ""})`);
  }
  if (found.layout === "missing" && readMarker(modsDir)?.layout !== "removed") log(`missing: the automagik layout (${join(dirname(resolve(modsDir)), PACK_LAYOUT)})`);
  const repaired = found.repair.length ? await applyUpdate({ tgzPath, version, modsDir, repair: found.repair, log }) : null;
  const tgzDir = mkdtempSync(join(tmpdir(), "automagik-herdr-layout-"));
  try {
    await run("tar", ["-xzf", resolve(tgzPath), "-C", tgzDir, PACK_LAYOUT]).catch(() => {});
    const record = readMarker(modsDir);
    const layout = placeLayout({ modsDir, tgzDir, record, log });
    // A mod switched off (in mods-disabled/, not mods/) has no folder here to check.
    const { failed: checkFailed, checked } = checkMods({ modsDir, mods: record.mods.filter((m) => exists(join(modsDir, m))), log, herdrApp });
    const changed = Boolean(repaired) || layout === "added" || layout === "replaced";
    const warnings = repaired?.warnings ?? [];
    // The hooks too, so a rerun moves those of a project opened (or listed) since the install.
    const hooks = moveHooks({ modsDir, log, warnings, window });
    return { version, repaired: found.repair, layout, checkFailed, checked, changed, hooks, warnings };
  } finally {
    rmSync(tgzDir, { recursive: true, force: true });
  }
}

const USAGE = "usage: node update.mjs check | update [--check] [--json] | apply [--expect <v>] | rollback | install --from <tgz> --version <v> [--sequence <n>] [--adopt] [--setup] | repair --from <tgz> --version <v>  (each takes [--mods <dir>])";
const FLAGS = {
  check: [], apply: ["--expect"], rollback: [], update: ["--check", "--json"], install: ["--from", "--version", "--sequence", "--adopt", "--setup"],
  repair: ["--from", "--version"],
};
const VALUED = new Set(["--mods", "--from", "--version", "--expect", "--sequence"]);

/** Strict arguments: an unknown command or flag, or a flag missing its value, is a usage error before anything is read. */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const usage = () => Object.assign(new Error(USAGE), { usage: true });
  if (!Object.hasOwn(FLAGS, command)) throw usage();
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag !== "--mods" && !FLAGS[command].includes(flag)) throw usage();
    if (VALUED.has(flag)) {
      const value = rest[++i];
      if (value === undefined || value === "" || value.startsWith("-")) throw usage();
      opts[flag.slice(2)] = value;
    } else opts[flag.slice(2)] = true;
  }
  if ((command === "install" || command === "repair") && !(opts.from && opts.version)) throw usage();
  if (opts.sequence !== undefined && !/^\d{1,15}$/.test(String(opts.sequence))) throw usage();
  return { command, opts };
}

async function main(argv) {
  const { command, opts } = parseArgs(argv);
  const modsDir = opts.mods ?? defaultModsDir();
  const log = (line) => process.stderr.write(`${line}\n`);
  // The hooks notice, last and tagged: install.sh prints the `notice: ` lines at the end of its run.
  const notice = (hooks) => { for (const line of hooksNotice(hooks)) log(`notice: ${line}`); };
  // The CLI link and the open spaces belong to this computer's own app home; install.sh links the CLI itself.
  const host = { binDir: binDirOf(), window: liveHome(modsDir) };
  if (command === "check" || (command === "update" && opts.check)) return checkForUpdate({ modsDir });
  if (command === "apply" || command === "update") {
    const r = await installUpdate({ modsDir, log: command === "update" ? log : undefined, expect: opts.expect ?? null, ...host });
    if (command === "update") notice(r.installed?.hooks?.hooks);
    if (command === "apply" || opts.json) return r;
    return { text: r.installed ? `Updated ${r.current} → ${r.installed.version}.` : `Up to date (${r.current}; latest ${r.latest ?? "none yet"}).` };
  }
  if (command === "rollback") {
    const r = rollback({ modsDir, log, ...host });
    notice(r.hooks?.hooks);
    if (r.warnings.length) process.exitCode = 4;
    return r;
  }
  if (command === "repair") {
    // Exit 3: a mod's herdr-app check failed; exit 4: a step after a swap did not finish.
    const r = await repairInstall({ tgzPath: opts.from, version: opts.version, modsDir, log, window: host.window });
    notice(r.hooks?.hooks);
    if (r.warnings.length) process.exitCode = 4;
    else if (r.checkFailed.length) process.exitCode = 3;
    return r;
  }
  // install.sh: the tarball it downloaded and checked with shasum, through applyUpdate's checks.
  const appHome = dirname(resolve(modsDir));
  if (opts.setup) preflightKeys(appHome);
  const before = oldSidebarHere(modsDir);
  const installed = await applyUpdate({ tgzPath: opts.from, version: opts.version, sequence: opts.sequence === undefined ? null : Number(opts.sequence), modsDir, adopt: Boolean(opts.adopt), log });
  const crossed = () => crossedRename(modsDir, before);
  // Exit 4: installed, but a step after the swap did not finish (its warning says what and where).
  const done = () => { if (installed.warnings.length) process.exitCode = 4; };
  if (!opts.setup) {
    installed.migration = migrateRefs({ modsDir, log, warnings: installed.warnings });
    installed.hooks = moveHooks({ modsDir, log, warnings: installed.warnings, window: host.window, crossed: crossed() });
    notice(installed.hooks?.hooks);
    done();
    return { installed };
  }
  const tgzDir = mkdtempSync(join(tmpdir(), "automagik-herdr-layout-"));
  try {
    await run("tar", ["-xzf", resolve(opts.from), "-C", tgzDir, PACK_LAYOUT]).catch(() => {});
    const failed = setupHome({ modsDir, tgzDir, record: readMarker(modsDir), log });
    // After setupHome: the pack's own layout is placed first, so only the person's are migrated.
    installed.migration = migrateRefs({ modsDir, log, warnings: installed.warnings });
    installed.hooks = moveHooks({ modsDir, log, warnings: installed.warnings, window: host.window, crossed: crossed() });
    notice(installed.hooks?.hooks);
    done();
    if (failed.length && !process.exitCode) process.exitCode = 3;
    return { installed, checkFailed: failed };
  } finally {
    rmSync(tgzDir, { recursive: true, force: true });
  }
}

const invoked = (() => { try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) {
  try {
    const out = await main(process.argv.slice(2));
    console.log(typeof out?.text === "string" ? out.text : JSON.stringify(out));
  } catch (error) {
    console.log(JSON.stringify({ error: String(error?.message ?? error) }));
    process.exit(error?.usage ? 2 : 1);
  }
}
