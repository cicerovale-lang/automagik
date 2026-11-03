// Automagik Herdr's releases over plain data (A14): which GitHub release is newer than the
// installed pack, which files it must carry, and the timing of the mod's check. Taken from
// Automagik's desktop updater (apps/desktop/src/update.js: compareVersions, pickUpdate, the
// 4-hour timing). Pure: no `herdr` and no `node:` imports, so the mod, the CLI and
// `node --test` share it; the download, checksum and swap live in update.mjs. Apache-2.0.
//
// The pack lives in the Automagik monorepo (herdr/) and ships on its releases, `v<version>` with
// the monorepo's one version (docs/rfcs/0011-monorepo-parts-and-releases.md there). A release
// carries the pack only when herdr/ changed since the one before, so the newest pack is named by a
// signed pointer, as plugin-lane names the plugins: the rolling `herdr-lane` release holds pack.json
// (the newest pack release, its tarball and that tarball's sha256) and pack.json.sig (ed25519 over
// its exact bytes, base64), checked against the keys this pack carries (pack-keys.json). The
// signature is checked in update.mjs and install.sh (node:crypto); this file only reads the pointer.

export const REPO = "automagik-dev/automagik";
/** The rolling release that names the newest pack, and its two files. */
export const LANE_RELEASE = "herdr-lane";
export const POINTER_URL = `https://github.com/${REPO}/releases/download/${LANE_RELEASE}/pack.json`;
export const POINTER_SIG_URL = `${POINTER_URL}.sig`;
export const POINTER_SCHEMA = 1;
/** The public keys this pack trusts for the pointer, beside this file: `{ keys: [{ keyId, publicKey (PEM) }] }`. */
export const PACK_KEYS_FILE = "pack-keys.json";
/** Where the pack lived until v0.14.x; the monorepo's release of it is the first above 3.0.0. */
export const OLD_REPO = "automagik-dev/automagik-herdr";
/** The folder that carries the pack's VERSION, update.mjs and the CLI. */
export const PACK_NAME = "am-sidebar";
/**
 * That folder's name before the rename (v0.2.0 to v0.4.x): what a v1 marker installed, where an
 * older install keeps its CLI, its first pack (`<name>.before-install`) and its briefing. Kept
 * here, not imported from migrate.js, because release.yml imports this file on its own.
 */
export const OLD_PACK_NAME = "spaces-agents";
/**
 * Every mod folder the pack ships (D3, D10): the tarball's top level is exactly these plus
 * `layouts/automagik.json`, and release.yml asserts it. It ships inside the tarball it checks, so
 * it guards against packaging bugs, not tampering (the signed pointer covers that). Pocket
 * Link is never one of them: Pocket owns it.
 */
export const PACK_MODS = Object.freeze(["am-automations", "am-footer", "am-markdown", "am-mods", "am-new-menu", "am-quota",
  "am-sidebar", "am-status", "am-tabs"]);
export const POCKET_LINK = "pocket-link";
/**
 * The usagemeter release install.sh installs to ~/.local/bin/usagemeter (Group 6c): the binary for
 * `<os>-<arch>`, checked against that release's SHA256SUMS and against the sha256 pinned here (the
 * release's SHA256SUMS proves the download is whole, `sha256` that it is the build this pack
 * pinned). install.sh carries the same version and hashes (a test keeps them equal), and
 * `node scripts/usagemeter-pin.mjs` (CI) checks them against the release itself. The binary is
 * shared with Pocket Link: never downgraded.
 */
export const USAGEMETER = Object.freeze({
  repo: "automagik-dev/usagemeter",
  version: "0.3.0",
  assets: Object.freeze({
    "darwin-arm64": "usagemeter-darwin-arm64", "darwin-x86_64": "usagemeter-darwin-x86_64",
    "linux-x86_64": "usagemeter-linux-x86_64", "linux-aarch64": "usagemeter-linux-aarch64",
  }),
  sha256: Object.freeze({
    "usagemeter-darwin-arm64": "80542d40e71369359cc1048c2d3a00b5703a10657651ca36e4207dfcf7d9824f",
    "usagemeter-darwin-x86_64": "f44107b3b5482b58e8592d482a01299c559ab71ded4d68a5c76b597c96ae6670",
    "usagemeter-linux-aarch64": "fa08460ebba5f4670bfa5777340c9ac20c89788f560bfadd24aeb30babdcfff4",
    "usagemeter-linux-x86_64": "25094c783abf14081d03547596e109b8601b7b47b8efccf76fa4473141cc26c6",
  }),
});
/** The one layout the pack ships, beside the mod folders in the tarball. */
export const PACK_LAYOUT = "layouts/automagik.json";
/** sha256 of the bots-only layout v0.2.0–v0.2.2 installed: only that copy is replaced (D8). */
export const V020_LAYOUT_SHA256 = "5a479f72db788826acb2413df7d32721fbbb9fd070caaf1c7096c6b84778a8a3";
/** The pack's keys (the repository's keys.json, which a test keeps equal): merged only where free. */
export const PACK_KEYS = Object.freeze({ global: Object.freeze({ "cmd-shift-m": "mod.open:am-mods" }) });
/** What the mod manager lists; mods/am-mods/core.js's CATALOG_URL is kept equal by a test. */
export const CATALOG_URL = "https://raw.githubusercontent.com/automagik-dev/automagik/dev/herdr/catalog/index.json";
/**
 * Every catalog URL a pack has written (the current one first): the monorepo's on `main`, and the
 * old repository's on `dev` and `main`. A copy holding one of them is the pack's to rewrite; any
 * other URL is the person's. core.js keeps the same list (a test keeps them equal).
 */
export const PACK_CATALOG_URLS = Object.freeze([
  CATALOG_URL,
  "https://raw.githubusercontent.com/automagik-dev/automagik/main/herdr/catalog/index.json",
  `https://raw.githubusercontent.com/${OLD_REPO}/dev/catalog/index.json`,
  `https://raw.githubusercontent.com/${OLD_REPO}/main/catalog/index.json`,
]);
/** The pack's tarball on release `version` (release.yml's "Pack the herdr pack" step). */
export const tarballName = (version) => `automagik-herdr-pack-${version}.tgz`;
/** Its sha256, `sha256sum` output for the tarball alone, beside it on the same release (for --version). */
export const sumsName = (version) => `${tarballName(version)}.sha256`;

/**
 * The installer's ownership record (`<app home>/automagik-herdr/installed-by-install.sh`) as data.
 * v2: `version=`, `mods=<comma list>`, `layout=added|kept|removed` (removed: `am uninstall herdr.layout`
 * took it out, and no install or update puts it back), `before=kept|none`, and
 * `adopted=<mod>:<path under automagik-herdr/>,…` for folders moved to backup/ on --adopt, and
 * `migrated=backup/<name>,…`, the rename migration's journals (oldest first) that a rollback across
 * the rename reverts, `installed=<ISO time>` when update.mjs last put the pack's folders in place
 * (the mod manager's INSTALLED column; am-mods/core.js parsePackMarker reads it too),
 * `sequence=<n>`, the signed pointer's sequence when the installed release came through it
 * (install.sh refuses an older pointer), `off=<mods>` in a kept set's .pack only: the folders it
 * holds that were switched off (mods-disabled/) when kept, so a rollback puts them back off,
 * `usagemeter=<version>` when install.sh put the usagemeter binary in ~/.local/bin (--uninstall
 * removes only that one), `usagemeter-machines=<machine>:<version>,…` for the linked machines the
 * pack put it on (meterFleet.js), and `usagemeter-scope=all|local|none`, what the person chose
 * (install.sh: all by default, local with --usagemeter-local-only, none with --no-usagemeter;
 * `automagik-herdr meter install` sets all, or local with --local). An older install.sh wrote no
 * scope, not even for --no-usagemeter: meterFleet.js meterScope reads that as local when it shows
 * `usagemeter=`, else as "not asked"; never as all. A v1 marker (v0.2.x: no `mods=`) installed only OLD_PACK_NAME.
 */
/** Where an adopted folder may be kept: `backup/<name>`, a plain name (install.sh checks the same). */
export const ADOPTED_PATH = /^backup\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function parseMarker(text) {
  if (typeof text !== "string") return null;
  const get = (key) => (new RegExp(`^${key}=(.*)$`, "m").exec(text)?.[1] ?? "").trim();
  const list = (value) => value.split(",").map((s) => s.trim()).filter(Boolean);
  const v1 = !/^mods=/m.test(text);
  return {
    v1,
    version: get("version") || null,
    mods: v1 ? [OLD_PACK_NAME] : list(get("mods")),
    layout: get("layout") || null,
    before: get("before") || "none",
    adopted: list(get("adopted")).map((e) => ({ mod: e.slice(0, e.indexOf(":")), path: e.slice(e.indexOf(":") + 1) }))
      .filter((a) => /^[a-z0-9][a-z0-9-]*$/.test(a.mod) && a.mod !== POCKET_LINK && ADOPTED_PATH.test(a.path)),
    migrated: list(get("migrated")).filter((p) => ADOPTED_PATH.test(p)),
    installed: ISO_TIME.test(get("installed")) ? get("installed") : null,
    usagemeter: /^\d+\.\d+\.\d+$/.test(get("usagemeter")) ? get("usagemeter") : null,
    usagemeterOn: Object.fromEntries(list(get("usagemeter-machines")).map((e) => [e.slice(0, e.lastIndexOf(":")), e.slice(e.lastIndexOf(":") + 1)])
      .filter(([m, v]) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(m) && /^\d+\.\d+\.\d+$/.test(v))),
    usagemeterScope: ["all", "local", "none"].includes(get("usagemeter-scope")) ? get("usagemeter-scope") : null,
    sequence: /^\d{1,15}$/.test(get("sequence")) ? Number(get("sequence")) : null,
    off: list(get("off")).filter((m) => /^[a-z0-9][a-z0-9-]*$/.test(m) && m !== POCKET_LINK),
  };
}

/** What `installed=` may hold: `new Date().toISOString()`. */
export const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

export const formatMarker = ({ version, mods, layout, before = "none", adopted = [], migrated = [], installed = null, sequence = null,
  usagemeter = null, usagemeterOn = {}, usagemeterScope = null, off = [] }) =>
  [`version=${version}`, `mods=${mods.join(",")}`, ...(layout ? [`layout=${layout}`] : []), `before=${before}`,
    ...(adopted.length ? [`adopted=${adopted.map((a) => `${a.mod}:${a.path}`).join(",")}`] : []),
    ...(migrated.length ? [`migrated=${migrated.join(",")}`] : []),
    ...(installed ? [`installed=${installed}`] : []),
    // sequence before the usagemeter lines, which install.sh writes last: a rewrite keeps the bytes.
    ...(Number.isSafeInteger(sequence) ? [`sequence=${sequence}`] : []),
    ...(off?.length ? [`off=${off.join(",")}`] : []),
    ...(usagemeter ? [`usagemeter=${usagemeter}`] : []),
    ...(Object.keys(usagemeterOn ?? {}).length ? [`usagemeter-machines=${Object.entries(usagemeterOn).map(([m, v]) => `${m}:${v}`).join(",")}`] : []),
    ...(usagemeterScope ? [`usagemeter-scope=${usagemeterScope}`] : [])].join("\n") + "\n";
/** Set to 1 to never ask GitHub (the CLI's update --check, the mod's notice). */
export const NO_UPDATE_ENV = "AUTOMAGIK_HERDR_NO_UPDATE";
export const FIRST_CHECK_MS = 20_000;
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
export const RETRY_MS = 30 * 60 * 1000;
export const TIMEOUT_MS = 15_000;

export const updatesOff = (env = {}) => String(env?.[NO_UPDATE_ENV] ?? "").trim() === "1";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Semver precedence: negative when `a` is older than `b`, 0 when equal, NaN when either is not a version. */
export function compareVersions(a, b) {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) return Number.NaN;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d !== 0) return Math.sign(d);
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const p = x[4].split(".");
  const q = y[4].split(".");
  for (let i = 0; i < Math.min(p.length, q.length); i++) {
    if (p[i] === q[i]) continue;
    const pn = /^\d+$/.test(p[i]);
    const qn = /^\d+$/.test(q[i]);
    if (pn && qn) return Math.sign(Number(p[i]) - Number(q[i]));
    if (pn !== qn) return pn ? -1 : 1;
    return p[i] < q[i] ? -1 : 1;
  }
  return Math.sign(p.length - q.length);
}

/**
 * The update a pointer (pack.json, parsed, its signature already checked) names: `{ version, tag,
 * page, sequence, tarball: { name, url }, sha256, size }`. Throws when it is not this pack's
 * pointer: another schema or part, a version that is not X.Y.Z, no whole-number sequence, a tarball
 * of another name, or a sha256 that is not 64 hex.
 */
export function packOfPointer(pointer) {
  const bad = (why) => { throw new Error(`the pack pointer ${why}: refusing it`); };
  if (!pointer || typeof pointer !== "object") bad("is not JSON");
  if (pointer.schemaVersion !== POINTER_SCHEMA) bad(`has schema ${pointer.schemaVersion}, not ${POINTER_SCHEMA}`);
  if (pointer.part !== "herdr") bad(`names part ${pointer.part}, not herdr`);
  const version = pointer.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) bad(`names version ${version}`);
  const tarball = pointer.tarball ?? {};
  if (tarball.name !== tarballName(version)) bad(`names ${tarball.name}, not ${tarballName(version)}`);
  if (typeof tarball.url !== "string" || !/^(https|file):\/\//.test(tarball.url)) bad("has no tarball URL");
  if (typeof tarball.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(tarball.sha256)) bad("has no sha256 of 64 hex");
  if (!Number.isSafeInteger(pointer.sequence) || pointer.sequence < 0) bad("has no sequence");
  const tag = `v${version}`;
  return {
    version, tag, page: `https://github.com/${REPO}/releases/tag/${tag}`, sequence: pointer.sequence,
    tarball: { name: tarball.name, url: tarball.url }, sha256: tarball.sha256, size: Number.isInteger(tarball.size) ? tarball.size : null,
  };
}

/** The update `pack` (packOfPointer's) offers over `current`: itself when newer, else null. */
export const pickUpdate = (current, pack) => (pack && compareVersions(pack.version, current) > 0 ? pack : null);

/** `sha256sum` output (`<hex>  <name>`, `*<name>` in binary mode) as a Map name → lowercase hex. */
export function parseSums(text) {
  const sums = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/** The mod's notice for `update` (from pickUpdate). */
export const noticeText = (update) =>
  `Automagik Herdr ${update.version} is out. Run \`automagik-herdr update\` to install it (${update.page}).`;
