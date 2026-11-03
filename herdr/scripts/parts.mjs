#!/usr/bin/env node
// The herdr parts' manifests (RFC 0012): one part.json at each part's root, beside its own manifest
// (mod.json). `am` reads them to install, uninstall and check each part on its own; the pack's
// marker stays the install record during the bridge cycle (RFC 0012, "One install authority").
// This checks every part.json under herdr/ and herdr-layout/ against the fields RFC 0012 defines,
// and that what each one names exists: its paths match files git tracks, its select is its own
// folder inside the pack tarball, and each entry's script ships in that tarball.
//
//   node scripts/parts.mjs --check    exit 1, naming each problem
//
// It reads the files git tracks, from the repository's top, wherever it runs.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const KINDS = Object.freeze(["dsh-plugin", "herdr-mod", "herdr-layout", "binary", "android-app", "desktop-app"]);
export const OSES = Object.freeze(["macos", "linux", "windows"]);
export const TARGETS = Object.freeze(["local", "fleet"]);
export const SETS = Object.freeze(["code", "work"]);
export const VERBS = Object.freeze(["install", "uninstall", "doctor"]);
const REQUIRED = Object.freeze(["id", "title", "kind", "paths", "provides", "requires", "os", "targets", "artifact", "select", "entry", "writes", "set"]);
/** A fork replacing a part names it here (RFC 0012, "Replaceable through capabilities"). */
const OPTIONAL = Object.freeze(["replaces"]);
/** The pack tarball every herdr part comes from; release.js tarballName with the version left open. */
export const PACK_ARTIFACT = "automagik-herdr-pack-{version}.tgz";
/** The script every herdr part's entries run, inside the tarball. */
export const PACK_ENTRY = "am-sidebar/bin/part.mjs";

export const ID = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
export const CAP = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
const PROVIDED = /^([a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+)@([1-9]\d*)$/;

/**
 * Where a path inside the pack tarball lives in the repository: `layouts/<x>` is
 * `herdr-layout/<x>` (release.yml packs herdr-layout/automagik.json there), and every other
 * `<mod>/…` is `herdr/mods/<mod>/…`. The one place to change when the layout entry's shape does.
 */
export function repoPathOf(inPack) {
  if (inPack === "layouts" || inPack.startsWith("layouts/")) return `herdr-layout${inPack.slice("layouts".length)}`;
  return `herdr/mods/${inPack}`;
}

/** A `paths` glob as a RegExp over repository paths: `**` crosses folders, `*` and `?` do not. */
export function globRe(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i += 1;
      if (glob[i + 1] === "/") { i += 1; re += "(?:.*/)?"; } else re += ".*";
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * What no part may write (RFC 0012, `writes`): Herdr's own (shared.json, data/), Pocket Link's
 * folder, and any LaunchAgent (Pocket Link's is Pocket's). Each is `[RegExp, why]`.
 */
export const REFUSED_WRITES = Object.freeze([
  [/(^|\/)herdr-app\/shared\.json(#|$)/, "Herdr's shared.json"],
  [/(^|\/)herdr-app\/data(\/|$)/, "Herdr's data/"],
  [/(^|\/)pocket-link(\/|$)/, "Pocket Link (Pocket's part)"],
  [/(^|\/)LaunchAgents(\/|$)/, "a LaunchAgent"],
]);

/**
 * Paths no write may reach, as samples a glob is tried against: a glob that matches one (`~/**`,
 * `~/.config/herdr-app/*.json`, `…/d*\/**`) is refused like the path itself.
 */
export const PROTECTED_SAMPLES = Object.freeze([
  ["~/.config/herdr-app/shared.json", "Herdr's shared.json"],
  ["~/.config/herdr-app/data", "Herdr's data/"],
  ["~/.config/herdr-app/data/x", "Herdr's data/"],
  ["~/.config/herdr-app/data/x/y.json", "Herdr's data/"],
  ["~/.config/herdr-app/mods/pocket-link", "Pocket Link (Pocket's part)"],
  ["~/.config/herdr-app/mods/pocket-link/main.js", "Pocket Link (Pocket's part)"],
  ["~/Library/LaunchAgents/ai.namastex.pocket-link.plist", "a LaunchAgent"],
]);

/** Why a write may not be declared, or null: `..`, a protected path (REFUSED_WRITES), or a glob that reaches one. */
export function refusedWrite(w) {
  const path = w.split("#")[0].replace(/^\$HERDR_APP_HOME(\/|$)/, "~/.config/herdr-app$1");
  if (path.split("/").includes("..")) return "a path with .. is not a part's to write (it can reach anything)";
  for (const [re, why] of REFUSED_WRITES) if (re.test(w) || re.test(path)) return `${why} is not a part's to write`;
  const re = globRe(path);
  for (const [sample, why] of PROTECTED_SAMPLES) if (re.test(sample)) return `it can match ${sample}: ${why} is not a part's to write`;
  return null;
}

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const strings = (v) => Array.isArray(v) && v.every((s) => typeof s === "string" && s.length > 0);
const relative = (p) => typeof p === "string" && p !== "" && !p.startsWith("/") && !p.split("/").includes("..");

/**
 * Checks the part.json files among `files` (repository paths git tracks) under herdr/ and
 * herdr-layout/. `read(path)` returns a file's text; `packMods` is release.js PACK_MODS.
 * Returns `{ parts: [{ file, id }], problems: string[] }`.
 */
export function validateParts({ files, read, packMods }) {
  const tracked = new Set(files);
  const manifests = files.filter((f) => /^(herdr|herdr-layout)\/(.*\/)?part\.json$/.test(f)).sort();
  const problems = [];
  const parts = [];
  const ids = new Map();
  const caps = new Map();
  for (const file of manifests) {
    const bad = (why) => problems.push(`${file}: ${why}`);
    let part;
    try { part = JSON.parse(read(file)); } catch (e) { bad(`not JSON (${e.message})`); continue; }
    if (!isObject(part)) { bad("not a JSON object"); continue; }
    if (Object.hasOwn(part, "version")) bad("has a version: a part's version is the release's (RFC 0012), never written by hand");
    for (const k of Object.keys(part)) if (!REQUIRED.includes(k) && !OPTIONAL.includes(k) && k !== "version") bad(`unknown field ${k}`);
    for (const k of REQUIRED) if (!Object.hasOwn(part, k)) bad(`has no ${k}`);
    const root = `${dirname(file)}/`;

    if (typeof part.id !== "string" || !ID.test(part.id)) bad(`id ${JSON.stringify(part.id)} is not <owner>.<name> in lowercase words`);
    else if (ids.has(part.id)) bad(`id ${part.id} is ${ids.get(part.id)}'s too`);
    else ids.set(part.id, file);
    if (typeof part.title !== "string" || !part.title.trim()) bad("has no title");
    if (!KINDS.includes(part.kind)) bad(`kind ${JSON.stringify(part.kind)} is not one of ${KINDS.join(", ")}`);

    if (!strings(part.paths) || part.paths.length === 0) bad("paths is not a list of globs");
    else for (const p of part.paths) {
      if (!relative(p)) { bad(`path ${p} is not relative to the repository`); continue; }
      const re = globRe(p);
      if (!files.some((f) => re.test(f))) bad(`path ${p} matches no file git tracks`);
    }

    if (!strings(part.provides) || part.provides.length === 0) bad("provides is not a list of capabilities");
    else for (const c of part.provides) {
      const m = PROVIDED.exec(c);
      if (!m) { bad(`provides ${c}: not <capability>@<major>`); continue; }
      if (caps.has(m[1])) bad(`provides ${m[1]}, which ${caps.get(m[1])} provides too`);
      else caps.set(m[1], part.id);
    }
    if (!Array.isArray(part.requires)) bad("requires is not a list");
    else for (const r of part.requires) {
      if (!isObject(r) || Object.keys(r).sort().join() !== "cap,major" || typeof r.cap !== "string" || !CAP.test(r.cap)
        || !Number.isSafeInteger(r.major) || r.major < 1) bad(`requires ${JSON.stringify(r)}: not { cap, major }`);
    }

    if (!strings(part.os) || part.os.length === 0 || part.os.some((o) => !OSES.includes(o)) || new Set(part.os).size !== part.os.length) {
      bad(`os ${JSON.stringify(part.os)} is not a list of ${OSES.join(", ")}`);
    }
    if (!TARGETS.includes(part.targets)) bad(`targets ${JSON.stringify(part.targets)} is not local or fleet`);
    if (!strings(part.set) || part.set.some((s) => !SETS.includes(s))) bad(`set ${JSON.stringify(part.set)} is not a list of ${SETS.join(", ")}`);
    if (Object.hasOwn(part, "replaces") && (!strings(part.replaces) || part.replaces.some((r) => !ID.test(r)))) bad("replaces is not a list of part ids");

    // The pack's parts: one tarball, each part's folder inside it.
    if (part.artifact !== PACK_ARTIFACT) bad(`artifact ${JSON.stringify(part.artifact)} is not ${PACK_ARTIFACT} (every herdr part ships in the pack)`);
    const selectOk = relative(part.select) && part.select.endsWith("/");
    if (!selectOk) bad(`select ${JSON.stringify(part.select)} is not a folder inside the tarball (relative, ending in /)`);
    else {
      if (repoPathOf(part.select) !== root) bad(`select ${part.select} is ${repoPathOf(part.select)} in the repository, not this part's folder ${root}`);
      const top = part.select.split("/")[0];
      if (top !== "layouts" && !packMods.includes(top)) bad(`select ${part.select} is not in the pack (release.js PACK_MODS, or layouts/)`);
    }

    if (!isObject(part.entry)) bad("entry is not an object");
    else {
      for (const k of Object.keys(part.entry)) if (![...VERBS, "rollback"].includes(k)) bad(`entry.${k} is not install, uninstall, doctor or rollback`);
      for (const verb of [...VERBS, ...(Object.hasOwn(part.entry, "rollback") ? ["rollback"] : [])]) {
        const argv = part.entry[verb];
        if (!strings(argv)) { bad(`entry.${verb} is not an argv array`); continue; }
        if (argv[0].includes("/") || argv[0].includes("\\")) bad(`entry.${verb} runs ${argv[0]}: name a program (node), not a path`);
        const script = argv[1];
        if (!selectOk || typeof script !== "string" || !/\.m?js$/.test(script)) { bad(`entry.${verb} names no script`); continue; }
        const inPack = posix.normalize(posix.join(part.select, script));
        if (inPack.startsWith("../")) { bad(`entry.${verb}'s ${script} is outside the tarball`); continue; }
        if (!tracked.has(repoPathOf(inPack))) bad(`entry.${verb}'s ${script} is ${inPack} in the tarball, ${repoPathOf(inPack)} here, which git does not track`);
        if (inPack === PACK_ENTRY && (argv.length !== 4 || argv[2] !== verb || argv[3] !== part.id)) {
          bad(`entry.${verb} must be ["node", "${script}", "${verb}", "${part.id}"]`);
        }
      }
    }

    if (!strings(part.writes) && !(Array.isArray(part.writes) && part.writes.length === 0)) bad("writes is not a list of paths");
    else for (const w of part.writes) {
      if (!/^(~\/|\*\*\/)/.test(w)) bad(`writes ${w}: start it with ~/ (the home) or **/ (any project), never a machine's own path`);
      const why = refusedWrite(w);
      if (why) bad(`writes ${w}: ${why}`);
    }
    parts.push({ file, id: part.id });
  }
  for (const m of packMods) {
    if (!manifests.includes(`herdr/mods/${m}/part.json`)) problems.push(`herdr/mods/${m}: a pack mod with no part.json`);
  }
  for (const f of manifests) if (/(^|\/)pocket-link\//.test(f)) problems.push(`${f}: Pocket Link is Pocket's part, not the pack's`);
  return { parts, problems };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (process.argv[2] !== "--check" || process.argv.length !== 3) {
    console.error("usage: node scripts/parts.mjs --check");
    process.exit(2);
  }
  const { PACK_MODS } = await import(new URL("../mods/am-sidebar/release.js", import.meta.url).href);
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: top, encoding: "utf8" }).split("\0").filter(Boolean);
  const { parts, problems } = validateParts({ files, read: (f) => readFileSync(join(top, f), "utf8"), packMods: PACK_MODS });
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log(`${parts.length} part.json valid: ${parts.map((p) => p.id).join(", ")}`);
}
