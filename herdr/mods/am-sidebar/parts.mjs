// The herdr parts' entries (RFC 0012): what `am install|uninstall|doctor <id>` runs for each part.json
// under herdr/ and herdr-layout/, through bin/part.mjs. Node only (like update.mjs); Herdr never
// loads this file. Apache-2.0.
//
// The pack is still one unit underneath: one tarball, installed, updated and rolled back together
// by update.mjs, and its marker (<app home>/automagik-herdr/installed-by-install.sh) stays the
// install record during the bridge cycle. These entries keep writing it; am only reads it.
//   herdr.am-sidebar   install: the pack (update.mjs install --setup) when the record is not at this
//                      version. uninstall: the whole pack, as install.sh --uninstall does, plus the
//                      briefing hooks, the hooks' entry point, the pack's keys and the command link.
//                      Install also links ~/.local/bin/automagik-herdr, as install.sh does, until the am
//                      part (RFC 0012, D34) takes the command over.
//                      The folders go to the kept set (<app home>/automagik-herdr/.prev) unless --purge.
//   herdr.am-<mod>     install: the pack, then the mod switched back on. uninstall: switched off
//                      (moved to mods-disabled/, as the mod manager does); an update keeps it off.
//   herdr.layout       install: the pack, then the automagik layout put back if it was removed.
//                      uninstall: the layout removed while it is the pack's copy (layout=removed).
// Never written: Herdr's shared.json or data/, Pocket Link (mods/pocket-link) or its LaunchAgent,
// usagemeter (its own part). doctor reads only, and prints one JSON line per check.

import { spawnSync } from "node:child_process";
import {
  chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, statSync,
  symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { stableBriefingPath, ENTRY_SOURCE } from "./briefingText.mjs";
import { CLI_LINK, knownProjects, ledgerFolders, removeHooks } from "./migrateHooks.mjs";
import { OLD_PACK_NAME, PACK_KEYS, PACK_LAYOUT, PACK_MODS, PACK_NAME, POCKET_LINK, compareVersions, formatMarker } from "./release.js";
import { appHomeOf, binDirOf, markerOf, offDirOf, placeLayout, prevSetOf, readMarker, readVersion, stateDirOf, writeMarker } from "./update.mjs";

export const NODE_MIN = "22.7.0";
/** What a herdr part's id names: `herdr.<pack mod>`, `herdr.layout`. */
export const PART_IDS = Object.freeze([...PACK_MODS.map((m) => `herdr.${m}`), "herdr.layout"]);

export function partOf(id) {
  if (id === "herdr.layout") return { id, kind: "layout" };
  const mod = typeof id === "string" && id.startsWith("herdr.") ? id.slice("herdr.".length) : null;
  if (mod && PACK_MODS.includes(mod)) return { id, kind: mod === PACK_NAME ? "pack" : "mod", mod };
  return null;
}

/** A command's result: `{ code, stdout, stderr, missing }` (missing: the program is not there). */
export function runCommand(cmd, args, { env, cwd, timeout = 120_000 } = {}) {
  const r = spawnSync(cmd, args, { env, cwd, timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status ?? (r.error ? 127 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "", missing: r.error?.code === "ENOENT" };
}

/**
 * Where everything is, from the environment am runs the entry with (AM_HOME, AM_PART_DIR,
 * AM_VERSION, AM_ARTIFACT, AM_JSON; HERDR_APP_HOME and HOME as the pack reads them). `exec` runs
 * a program (runCommand's shape); tests pass their own, and an app home of their own.
 */
export function contextOf({ env = process.env, exec = runCommand, log = (line) => process.stderr.write(`${line}\n`), platform = process.platform,
  node = process.execPath, nodeVersion = process.versions.node } = {}) {
  const appHome = appHomeOf(env);
  const modsDir = join(appHome, "mods");
  return {
    env, exec, log, platform, node, nodeVersion, appHome, modsDir, offDir: offDirOf(modsDir), binDir: binDirOf(env),
    version: /^\d+\.\d+\.\d+$/.test(env.AM_VERSION ?? "") ? env.AM_VERSION : null,
  };
}

const lstat = (p) => { try { return lstatSync(p); } catch { return null; } };
const exists = (p) => lstat(p) !== null;
const isLink = (p) => Boolean(lstat(p)?.isSymbolicLink());
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const packFolder = (name) => /^[a-z0-9][a-z0-9-]*$/.test(name) && name !== POCKET_LINK;
const fresh = (dir, prefix) => join(dir, `${prefix}${process.pid}-${randomBytes(4).toString("hex")}`);
/** Names a mod's tree never ships (update.mjs privateName: dot-names, node_modules, editor files). */
const unshipped = (name) => name.startsWith(".") || name === "node_modules" || name === "gpui-kit.d.ts" || name === "jsconfig.json";

// ---- the artifact (RFC 0012 entry contract): the one place that knows how am hands it over ----

/**
 * The pack tree AM_PART_DIR sits in. am extracts the whole verified tarball and points AM_PART_DIR
 * at `<extracted>/<select>`: the tree holds `am-sidebar/update.mjs` and `layouts/`. From a checkout
 * (`am install ./herdr/mods/am-footer`), the tree is made the way release.yml packs it: each
 * PACK_MODS folder of herdr/mods, and herdr-layout/automagik.json as layouts/automagik.json.
 */
export function packTree(partDir, tmp) {
  if (!partDir) throw new Error("am gave no AM_PART_DIR (nor AM_ARTIFACT): no pack to install from");
  let dir = resolve(partDir);
  for (let i = 0; i < 4; i++, dir = dirname(dir)) {
    const checkoutMods = basename(dir) === "mods" && isFile(join(dir, PACK_NAME, "update.mjs")) ? dir
      : isFile(join(dir, "herdr", "mods", PACK_NAME, "update.mjs")) ? join(dir, "herdr", "mods") : null;
    const layout = checkoutMods && join(checkoutMods, "..", "..", "herdr-layout", "automagik.json");
    if (checkoutMods && isFile(layout)) {
      const tree = join(tmp, "tree");
      for (const m of PACK_MODS) cpSync(join(checkoutMods, m), join(tree, m), { recursive: true, filter: (src) => !unshipped(basename(src)) });
      mkdirSync(join(tree, "layouts"), { recursive: true });
      cpSync(layout, join(tree, PACK_LAYOUT));
      return tree;
    }
    if (isFile(join(dir, PACK_NAME, "update.mjs")) && isFile(join(dir, PACK_NAME, "release.js"))) return dir;
  }
  throw new Error(`${partDir} is in no Automagik Herdr pack (an extracted automagik-herdr-pack-<v>.tgz, or a checkout's herdr/)`);
}

/**
 * The pack to install from: `{ tgz, tree, version, cleanup }`. AM_ARTIFACT (the tarball am checked
 * against the signed pointer) when am gives it, else a tarball made from packTree. `tree` is that
 * tarball unpacked (its update.mjs runs the install, as install.sh runs the release's own), and
 * `version` am's AM_VERSION, else the tarball's VERSION (update.mjs refuses a mismatch).
 */
export function packSource(ctx) {
  const tmp = mkdtempSync(join(tmpdir(), "am-herdr-part-"));
  const cleanup = () => rmSync(tmp, { recursive: true, force: true });
  try {
    let tgz = ctx.env.AM_ARTIFACT || null;
    if (tgz && !isFile(tgz)) throw new Error(`AM_ARTIFACT ${tgz} is not a file`);
    if (!tgz) {
      const tree = packTree(ctx.env.AM_PART_DIR, tmp);
      tgz = join(tmp, "pack.tgz");
      const r = ctx.exec("tar", ["-czf", tgz, "-C", tree, ...readdirSync(tree).filter((n) => !unshipped(n)).sort()], { env: { ...ctx.env, COPYFILE_DISABLE: "1" } });
      if (r.code !== 0) throw new Error(`could not pack ${tree} (${r.stderr.trim() || `tar exit ${r.code}`})`);
    }
    const tree = join(tmp, "x");
    mkdirSync(tree);
    const r = ctx.exec("tar", ["-xzf", resolve(tgz), "-C", tree], { env: ctx.env });
    if (r.code !== 0) throw new Error(`could not unpack ${tgz} (${r.stderr.trim() || `tar exit ${r.code}`})`);
    return { tgz: resolve(tgz), tree, version: ctx.version ?? readVersion(join(tree, PACK_NAME)), cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

// ---- install ----

/**
 * The pack at the source's version, through the source's own update.mjs (`install --setup`: the
 * folders, the record, the free keys, the mod manager's catalog, the layout, `herdr-app check`).
 * Nothing when the record already names that version. Throws on a failure (exit 3: a mod's
 * check failed; 4: a step after the swap did not finish; its lines are in the log).
 */
function ensurePack(ctx, source) {
  const record = readMarker(ctx.modsDir);
  // am's AM_VERSION when it gives one, so an install already at that version unpacks nothing.
  if (record && !record.v1 && record.version === (ctx.version ?? source().version)) return false;
  const src = source();
  // AM_SEQUENCE: the signed pointer's sequence, so the record keeps install.sh's replay guard on.
  const sequence = /^\d{1,15}$/.test(ctx.env.AM_SEQUENCE ?? "") ? ["--sequence", ctx.env.AM_SEQUENCE] : [];
  const r = ctx.exec(ctx.node, [join(src.tree, PACK_NAME, "update.mjs"), "install", "--from", src.tgz, "--version", src.version, "--mods", ctx.modsDir, "--setup", ...sequence],
    { env: { ...ctx.env, HERDR_APP_HOME: ctx.appHome } });
  for (const line of r.stderr.split("\n").filter(Boolean)) ctx.log(line.replace(/^notice: /, ""));
  if (r.code === 3) throw new Error(`the pack ${src.version} is installed, but herdr-app check failed for a mod (above)`);
  if (r.code === 4) throw new Error(`the pack ${src.version} is installed, but a step after it did not finish (the warning above says what)`);
  if (r.code !== 0) {
    let why = r.stdout.trim() || r.stderr.trim();
    try { why = JSON.parse(r.stdout).error ?? why; } catch {}
    throw new Error(`the pack ${src.version} was not installed: ${why}`);
  }
  ctx.log(`installed the pack ${src.version} in ${ctx.modsDir}`);
  return true;
}

/** Each free key of the pack's (release.js PACK_KEYS) into keys.json; a key the person bound stays theirs. */
function mergeKeys(ctx) {
  const path = join(ctx.appHome, "keys.json");
  const keys = isFile(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  let added = 0;
  for (const [section, entries] of Object.entries(PACK_KEYS)) {
    for (const [key, action] of Object.entries(entries)) if (keys[section]?.[key] === undefined) { (keys[section] ??= {})[key] = action; added += 1; }
  }
  if (added) writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`);
  return added;
}

/** Each pack key (PACK_KEYS) out of keys.json while it still runs the pack's action; a rebound one stays. */
function dropKeys(ctx) {
  const path = join(ctx.appHome, "keys.json");
  if (!isFile(path) || isLink(path)) return 0;
  const keys = JSON.parse(readFileSync(path, "utf8"));
  let dropped = 0;
  for (const [section, entries] of Object.entries(PACK_KEYS)) {
    for (const [key, action] of Object.entries(entries)) if (keys[section]?.[key] === action) { delete keys[section][key]; dropped += 1; }
  }
  if (dropped) writeFileSync(path, `${JSON.stringify(keys, null, 2)}\n`);
  return dropped;
}

/** The CLI's own entries in a sidebar folder: the bin/automagik-herdr wrapper and the .mjs it runs. */
const cliEntries = (ctx, sidebar = PACK_NAME) => ["automagik-herdr", "automagik-herdr.mjs"].map((f) => join(ctx.modsDir, sidebar, "bin", f));
/** Whether the link `link` is the pack's (install.sh link_ours): it points at one of `entries`. */
function linkOurs(link, entries) {
  if (!isLink(link)) return false;
  const to = resolve(dirname(link), readlinkSync(link));
  return entries.includes(to);
}
/** `<binDir>/<name>` linked to the first of `entries` that exists; a file or another link there stays the person's. */
function linkCommand(ctx, name, entries, ours) {
  const link = join(ctx.binDir, name);
  const target = entries.find(isFile);
  if (!target) return { link, done: false, why: "not shipped" };
  if (exists(link) && !isLink(link)) return { link, done: false, why: `${link} is a file, not a link: left alone (remove it, then install again)` };
  if (isLink(link) && !linkOurs(link, ours)) return { link, done: false, why: `${link} points at ${readlinkSync(link)}, not this install: left alone` };
  if (isLink(link) && resolve(dirname(link), readlinkSync(link)) === target) return { link, done: true, changed: false };
  chmodSync(target, statSync(target).mode | 0o111);
  mkdirSync(ctx.binDir, { recursive: true });
  const tmp = join(ctx.binDir, `.${name}.am-tmp-${process.pid}`);
  rmSync(tmp, { force: true });
  symlinkSync(target, tmp);
  renameSync(tmp, link);
  return { link, done: true, changed: true };
}
/** The pack's automagik-herdr link removed where it is ours; another is reported. */
function unlinkCommands(ctx) {
  const link = join(ctx.binDir, CLI_LINK);
  if (linkOurs(link, [...cliEntries(ctx), ...cliEntries(ctx, OLD_PACK_NAME)])) { unlinkSync(link); return [`removed ${link}`]; }
  return exists(link) ? [`left ${link}: it is not this install's`] : [];
}

/**
 * `install <id>`: idempotent. Returns `{ ok, changed, detail }`; throws on a failure.
 * `source` is packSource, called only when the pack itself has to be installed (or the layout read).
 */
export function install(ctx, part, source) {
  let src = null;
  const lazy = () => (src ??= source(ctx));
  try {
    let changed = ensurePack(ctx, lazy);
    const record = readMarker(ctx.modsDir);
    if (!record) throw new Error(`the pack's record ${markerOf(ctx.modsDir)} is missing after the install`);
    if (part.kind === "mod") {
      if (!record.mods.includes(part.mod)) throw new Error(`mods/${part.mod} is not the pack's (a folder of your own is left alone; install.sh --adopt replaces it)`);
      const live = join(ctx.modsDir, part.mod), off = join(ctx.offDir, part.mod);
      if (!exists(live) && exists(off) && !isLink(off)) {
        renameSync(off, live);
        ctx.log(`switched ${part.mod} back on (mods-disabled/ → mods/)`);
        changed = true;
      }
      if (!exists(live)) throw new Error(`mods/${part.mod} is missing: run install.sh again, which repairs the pack`);
      if (part.mod === "am-mods" && mergeKeys(ctx)) { ctx.log("added the mod manager's key (cmd-shift-m)"); changed = true; }
      return { ok: true, changed, detail: `${part.mod} is on (pack ${record.version})` };
    }
    if (part.kind === "layout") {
      const live = join(ctx.appHome, PACK_LAYOUT);
      if (!exists(live)) {
        if (record.layout === "removed") record.layout = null;
        const placed = placeLayout({ modsDir: ctx.modsDir, tgzDir: lazy().tree, record, log: ctx.log });
        if (!placed) throw new Error(`the pack ${record.version} ships no ${PACK_LAYOUT}`);
        changed = true;
      }
      return { ok: true, changed, detail: `${live} is in place` };
    }
    // The pack's command, as install.sh links it: a file or another link there stays the person's.
    const cli = linkCommand(ctx, CLI_LINK, cliEntries(ctx), [...cliEntries(ctx), ...cliEntries(ctx, OLD_PACK_NAME)]);
    if (cli.changed) { ctx.log(`linked ${cli.link}`); changed = true; }
    if (!cli.done) ctx.log(cli.why === "not shipped" ? `${join(ctx.modsDir, PACK_NAME, "bin")} has no automagik-herdr command: not linked` : cli.why);
    if (!(ctx.env.PATH ?? "").split(":").includes(ctx.binDir)) ctx.log(`add ${ctx.binDir} to your PATH: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`);
    return { ok: true, changed, detail: `the pack ${record.version} is installed (${record.mods.join(", ")})` };
  } finally {
    src?.cleanup();
  }
}

// ---- uninstall ----

/** A mod switched off: mods/<m> → mods-disabled/<m>, where Herdr never looks and an update keeps it. */
function switchOff(ctx, part) {
  const record = readMarker(ctx.modsDir);
  if (!record) return { ok: true, changed: false, detail: "the pack is not installed: nothing to do" };
  if (!record.mods.includes(part.mod)) return { ok: true, changed: false, detail: `mods/${part.mod} is not the pack's: left alone` };
  const live = join(ctx.modsDir, part.mod), off = join(ctx.offDir, part.mod);
  let changed = false;
  if (isLink(live)) return { ok: true, changed: false, detail: `mods/${part.mod} is a link (a checkout?): left alone` };
  if (exists(live)) {
    if (exists(off)) throw new Error(`${off} is in the way: move it, then uninstall again`);
    mkdirSync(ctx.offDir, { recursive: true });
    renameSync(live, off);
    ctx.log(`switched ${part.mod} off (mods/ → mods-disabled/): an update keeps it off; \`am install ${part.id}\` switches it back on`);
    changed = true;
  }
  if (part.mod === "am-mods" && dropKeys(ctx)) { ctx.log("removed the mod manager's key (cmd-shift-m)"); changed = true; }
  return { ok: true, changed, detail: `${part.mod} is off` };
}

/** The layout out while it is still the pack's copy; the record says removed, so no update adds it back. */
function removeLayout(ctx) {
  const record = readMarker(ctx.modsDir);
  if (!record) return { ok: true, changed: false, detail: "the pack is not installed: nothing to do" };
  const live = join(ctx.appHome, PACK_LAYOUT);
  const ref = join(stateDirOf(ctx.modsDir), "automagik.json");
  let changed = false;
  if (isFile(live) && !isLink(live)) {
    if (!isFile(ref) || !readFileSync(live).equals(readFileSync(ref))) {
      return { ok: true, changed: false, detail: `${live} differs from the pack's: it is yours, left as it is` };
    }
    rmSync(live);
    ctx.log(`removed ${live}; if Herdr shows it, switch back: herdr-app do layout.switch '{"name":"main"}'`);
    changed = true;
  }
  if (record.layout !== "removed") { writeMarker(ctx.modsDir, { ...record, layout: "removed" }); changed = true; }
  return { ok: true, changed, detail: "the automagik layout is out" };
}

/**
 * The whole pack out, as install.sh --uninstall does: the record's folders (on or off) leave mods/
 * together as the kept set (with --purge: deleted, with the older set), adopted folders come back,
 * the layout goes while it is the one this install added, the briefing hooks and their entry
 * point go, the pack's keys and its command links go, then the record. Your bots, Herdr's
 * settings (shared.json, data/), Pocket Link and usagemeter stay.
 */
function uninstallPack(ctx, { purge }) {
  const record = readMarker(ctx.modsDir);
  if (!record) return { ok: true, changed: false, detail: "the pack is not installed: nothing to do" };
  if (record.v1) throw new Error("this pack was installed by v0.2's installer: run install.sh --uninstall");
  const state = stateDirOf(ctx.modsDir);
  const prev = prevSetOf(ctx.modsDir);
  const lines = [];

  const live = join(ctx.appHome, PACK_LAYOUT), ref = join(state, "automagik.json");
  if (record.layout === "added" && isFile(live) && !isLink(live) && isFile(ref) && readFileSync(live).equals(readFileSync(ref))) {
    rmSync(live);
    lines.push(`removed ${live}; if Herdr shows it, switch back: herdr-app do layout.switch '{"name":"main"}'`);
  }

  // The record's folders, wherever they are (mods/, or mods-disabled/ for one switched off).
  const next = fresh(state, ".prev-next-");
  mkdirSync(next, { recursive: true });
  const moved = [];
  const movedOff = [];
  for (const m of record.mods.filter(packFolder)) {
    const on = join(ctx.modsDir, m), off = join(ctx.offDir, m);
    const at = isLink(on) ? null : exists(on) ? on : exists(off) && !isLink(off) ? off : null;
    if (isLink(on)) lines.push(`left ${on}: it is a link, not a folder this install put there`);
    if (!at) continue;
    renameSync(at, join(next, m));
    moved.push(m);
    if (at === off) movedOff.push(m);
  }
  // A folder already kept (one a rollback moved out) stays kept beside them.
  if (moved.length && isFile(join(prev, ".pack"))) {
    const kept = readFileSync(join(prev, ".pack"), "utf8").match(/^mods=(.*)$/m)?.[1].split(",").map((s) => s.trim()).filter(packFolder) ?? [];
    for (const m of kept) {
      if (isDir(join(prev, m)) && !isLink(join(prev, m)) && !exists(join(next, m))) { renameSync(join(prev, m), join(next, m)); moved.push(m); }
    }
  }
  if (moved.length) {
    writeFileSync(join(next, ".pack"), formatMarker({ version: record.version, mods: moved, off: movedOff }));
    const old = fresh(state, ".prev-old-");
    if (exists(prev)) renameSync(prev, old);
    if (purge) {
      rmSync(next, { recursive: true, force: true });
      lines.push(`deleted the pack's folders (${moved.join(", ")}) and their data (--purge)`);
    } else {
      renameSync(next, prev);
      lines.push(`moved the pack out of ${ctx.modsDir} (${moved.join(", ")}); it is kept in ${prev}`);
    }
    rmSync(old, { recursive: true, force: true });
  } else {
    rmSync(next, { recursive: true, force: true });
    if (purge && exists(prev)) { rmSync(prev, { recursive: true, force: true }); lines.push(`deleted the kept set ${prev} (--purge)`); }
  }

  // What the person had before: each adopted folder comes back where mods/ is free.
  for (const a of record.adopted) {
    const from = join(state, a.path), to = join(ctx.modsDir, a.mod);
    if (isDir(from) && !isLink(from) && !exists(to)) { renameSync(from, to); lines.push(`put back ${to}, the one that was there before the install`); }
  }

  const hooks = removeHooks(knownProjects(ctx.appHome), { appHome: ctx.appHome, also: ledgerFolders(ctx.appHome), log: ctx.log });
  for (const f of hooks.removed) lines.push(`removed the briefing hook from ${f} (the original is beside it, ${basename(f)}.am-backup…)`);
  for (const s of hooks.skipped) lines.push(`left: ${s.file} (${s.reason})`);
  const entry = stableBriefingPath(ctx.appHome);
  if (isFile(entry) && !isLink(entry)) { rmSync(entry); lines.push(`removed the briefing hook's entry point ${entry}`); }
  if (dropKeys(ctx)) lines.push("removed the pack's keys from keys.json");
  lines.push(...unlinkCommands(ctx));
  rmSync(markerOf(ctx.modsDir), { force: true });
  if (purge) for (const f of ["hooks-journal.json", "automagik.json"]) rmSync(join(state, f), { force: true });
  if (record.usagemeter || Object.keys(record.usagemeterOn).length) {
    lines.push("left usagemeter where it is (~/.local/bin/usagemeter, and linked machines): it is its own part");
  }
  for (const l of lines) ctx.log(l);
  return { ok: true, changed: true, detail: `the pack ${record.version} is uninstalled${purge ? " (--purge)" : ""}; your bots and Herdr's settings are untouched` };
}

/** `uninstall <id> [--purge]`: idempotent. Returns `{ ok, changed, detail }`; throws on a failure. */
export function uninstall(ctx, part, { purge = false } = {}) {
  if (part.kind === "pack") return uninstallPack(ctx, { purge });
  if (part.kind === "mod") return switchOff(ctx, part);
  if (part.kind === "layout") return removeLayout(ctx);
  throw new Error(`${part.id} is not a herdr part`);
}

// ---- doctor ----

/**
 * `doctor <id>`: reads only, in well under 30 s (no program runs, no network). Returns
 * `{ code, checks: [{ part, check, ok, detail, fix }] }`: code 0 healthy, 1 broken, 2 not
 * applicable (not macOS, or a mod switched off). `fix` is the exact command, or null.
 */
export function doctor(ctx, part) {
  const checks = [];
  const add = (check, ok, detail, fix = null) => checks.push({ part: part.id, check, ok, detail, fix: ok ? null : fix });
  // Healthy, with a note and the command that changes it: never a reason for am to roll an install back.
  const note = (check, detail, fix) => checks.push({ part: part.id, check, ok: true, detail, fix });
  const done = (code) => ({ code: code ?? (checks.every((c) => c.ok) ? 0 : 1), checks });
  const reinstall = `am install ${part.id}`;
  if (ctx.platform !== "darwin") { add("os", true, `not applicable: Automagik Herdr runs on macOS (Herdr is a Mac app); this is ${ctx.platform}`); return done(2); }

  let record = null;
  try { record = readMarker(ctx.modsDir); } catch (e) { add("record", false, `${markerOf(ctx.modsDir)} is unreadable (${e.message})`, reinstall); return done(); }
  if (!record) { add("record", false, `the pack is not installed: ${markerOf(ctx.modsDir)} is missing`, reinstall); return done(); }
  if (record.v1) { add("record", false, "a v0.2 install: the parts need the pack 3.x", "curl -fsSL https://raw.githubusercontent.com/automagik-dev/automagik/main/herdr/install.sh | bash"); return done(); }
  add("record", true, `the pack ${record.version} (${record.mods.join(", ")})`);
  if (ctx.version && compareVersions(record.version, ctx.version) !== 0) add("version", false, `the record says ${record.version}, am expects ${ctx.version}`, reinstall);

  if (part.kind === "mod" || part.kind === "pack") {
    const m = part.mod, live = join(ctx.modsDir, m), off = join(ctx.offDir, m);
    if (!record.mods.includes(m)) { add("listed", false, `the record does not list ${m}: mods/${m}, if any, is not the pack's`, reinstall); return done(); }
    if (part.kind === "mod" && !exists(live) && exists(off)) { add("switched-off", true, `not applicable: ${m} is switched off (${off})`); return done(2); }
    if (isLink(live)) add("folder", true, `mods/${m} is a link (a checkout): not the release's files`);
    else if (!isDir(live)) { add("folder", false, `mods/${m} is missing`, "curl -fsSL https://raw.githubusercontent.com/automagik-dev/automagik/main/herdr/install.sh | bash"); return done(); }
    else add("folder", true, live);
    const lacks = ["main.js", "mod.json"].filter((f) => !isFile(join(live, f)));
    add("files", lacks.length === 0, lacks.length ? `mods/${m} has no ${lacks.join(" or ")}` : "main.js and mod.json are there", reinstall);
  }

  if (part.kind === "pack") {
    const v = readVersion(join(ctx.modsDir, PACK_NAME));
    add("pack-version", v === record.version, `mods/${PACK_NAME}/VERSION is ${v}; the record says ${record.version}`, reinstall);
    const gone = record.mods.filter((m) => packFolder(m) && !exists(join(ctx.modsDir, m)) && !exists(join(ctx.offDir, m)));
    add("pack-mods", gone.length === 0, gone.length ? `the record lists ${gone.join(", ")}, in neither mods/ nor mods-disabled/` : "every mod the record lists is there (on or off)",
      "curl -fsSL https://raw.githubusercontent.com/automagik-dev/automagik/main/herdr/install.sh | bash");
    const entry = stableBriefingPath(ctx.appHome), source = join(ctx.modsDir, PACK_NAME, ENTRY_SOURCE);
    const same = isFile(entry) && isFile(source) && readFileSync(entry).equals(readFileSync(source));
    add("briefing-entry", same, same ? entry : `${entry} is ${isFile(entry) ? "not the sidebar's" : "missing"}: the bots' briefing hook finds no briefing`, reinstall);
  }

  if (part.kind === "mod" && part.mod === "am-mods") {
    let keys = {};
    try { keys = isFile(join(ctx.appHome, "keys.json")) ? JSON.parse(readFileSync(join(ctx.appHome, "keys.json"), "utf8")) : {}; } catch (e) {
      add("keys", false, `keys.json is unreadable (${e.message})`, null);
    }
    for (const [section, entries] of Object.entries(PACK_KEYS)) {
      for (const [key, action] of Object.entries(entries)) {
        const now = keys?.[section]?.[key];
        if (now === action) add("keys", true, `${key} opens the mod manager`);
        else if (now !== undefined) add("keys", true, `${key} is yours (${now}): the mod manager has no key`);
        else add("keys", false, `${key} is bound to nothing`, reinstall);
      }
    }
  }

  if (part.kind === "pack") {
    const link = join(ctx.binDir, CLI_LINK);
    const to = isLink(link) ? resolve(dirname(link), readlinkSync(link)) : null;
    if (!exists(link)) add("command", false, `${link} is missing`, reinstall);
    else if (!to) note("command", `${link} is a file of yours, not the pack's link: left alone`, `rm ${link} && ${reinstall}`);
    else if (!cliEntries(ctx).includes(to)) note("command", `${link} points at ${to}, not this install: left alone`, `rm ${link} && ${reinstall}`);
    else add("command", isFile(to), isFile(to) ? `${link} → ${to}` : `${link} points at ${to}, which is gone`, reinstall);
    const onPath = (ctx.env.PATH ?? "").split(":").includes(ctx.binDir);
    if (onPath) add("path", true, `${ctx.binDir} is on PATH`);
    else note("path", `${ctx.binDir} is not on PATH: run automagik-herdr by its full path, or add it`, `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`);
    const nodeOk = compareVersions(ctx.nodeVersion, NODE_MIN) >= 0;
    add("node", nodeOk, `node ${ctx.nodeVersion}${nodeOk ? "" : `: the command needs ${NODE_MIN} or later`}`, "brew install node");
  }

  if (part.kind === "layout") {
    const live = join(ctx.appHome, PACK_LAYOUT), ref = join(stateDirOf(ctx.modsDir), "automagik.json");
    if (!isFile(live)) {
      if (record.layout === "removed") { add("layout", true, "not applicable: the automagik layout was uninstalled"); return done(2); }
      add("layout", false, `${live} is missing`, reinstall);
      return done();
    }
    let parsed = true;
    try { JSON.parse(readFileSync(live, "utf8")); } catch { parsed = false; }
    add("layout-json", parsed, parsed ? `${live} is JSON` : `${live} is not valid JSON`, null);
    const ours = isFile(ref) && readFileSync(live).equals(readFileSync(ref));
    add("layout", true, ours ? `${live} is the pack's` : `${live} is yours (kept: it differs from the pack's ${ref})`);
  }
  return done();
}
