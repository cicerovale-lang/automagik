// scripts/parts.mjs: every herdr part.json valid, and what it names there. The checker runs over an
// injected file list and reader; the last test reads this checkout's own (git ls-files), never a home.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PACK_ARTIFACT, globRe, repoPathOf, validateParts } from "../scripts/parts.mjs";
import { PACK_MODS } from "../mods/am-sidebar/release.js";

const MODS = ["am-sidebar", "am-tabs"];
const argv = (script, id) => Object.fromEntries(["install", "uninstall", "doctor"].map((v) => [v, ["node", script, v, id]]));
const modPart = (m, extra = {}) => ({
  id: `herdr.${m}`, title: m, kind: "herdr-mod", paths: [`herdr/mods/${m}/**`], provides: [`herdr.${m}@1`], requires: [],
  os: ["macos"], targets: "local", artifact: PACK_ARTIFACT, select: `${m}/`,
  entry: argv(m === "am-sidebar" ? "bin/part.mjs" : "../am-sidebar/bin/part.mjs", `herdr.${m}`), writes: [], set: ["code"], ...extra,
});
const layoutPart = (extra = {}) => ({
  id: "herdr.layout", title: "layout", kind: "herdr-layout", paths: ["herdr-layout/automagik.json"], provides: ["herdr.layout@1"],
  requires: [{ cap: "herdr.am-tabs", major: 1 }], os: ["macos"], targets: "local", artifact: PACK_ARTIFACT, select: "layouts/",
  entry: argv("../am-sidebar/bin/part.mjs", "herdr.layout"), writes: ["~/.config/herdr-app/layouts/automagik.json"], set: ["code"], ...extra,
});

/** A tree as git lists it: each mod's main.js, the entry script, the layout, and these part.json bodies. */
function tree(parts) {
  const files = { "herdr/mods/am-sidebar/main.js": "", "herdr/mods/am-tabs/main.js": "", "herdr/mods/am-sidebar/bin/part.mjs": "", "herdr-layout/automagik.json": "{}" };
  for (const [path, part] of Object.entries(parts)) files[path] = typeof part === "string" ? part : JSON.stringify(part);
  return { files: Object.keys(files), read: (f) => { if (!(f in files)) throw new Error(`ENOENT ${f}`); return files[f]; }, packMods: MODS };
}
const valid = () => ({
  "herdr/mods/am-sidebar/part.json": modPart("am-sidebar"),
  "herdr/mods/am-tabs/part.json": modPart("am-tabs"),
  "herdr-layout/part.json": layoutPart(),
});
const problemsOf = (parts) => validateParts(tree(parts)).problems;

test("repoPathOf maps the tarball's paths to the repository's; globRe matches as paths globs do", () => {
  assert.equal(repoPathOf("am-footer/"), "herdr/mods/am-footer/");
  assert.equal(repoPathOf("am-sidebar/bin/part.mjs"), "herdr/mods/am-sidebar/bin/part.mjs");
  assert.equal(repoPathOf("layouts/"), "herdr-layout/");
  assert.equal(repoPathOf("layouts/automagik.json"), "herdr-layout/automagik.json");
  assert.ok(globRe("herdr/mods/am-tabs/**").test("herdr/mods/am-tabs/a/b.js"));
  assert.ok(!globRe("herdr/mods/am-tabs/*").test("herdr/mods/am-tabs/a/b.js"));
  assert.ok(globRe("herdr/**/x.js").test("herdr/x.js"));
  assert.ok(!globRe("herdr/mods/am-tab?/**").test("herdr/mods/am-tabs2/x"));
});

test("a valid set passes, every part listed", () => {
  const r = validateParts(tree(valid()));
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.parts.map((p) => p.id).sort(), ["herdr.am-sidebar", "herdr.am-tabs", "herdr.layout"]);
});

test("the fields: a version, an unknown or missing field, a bad id, kind, os, targets, set or requires is named", () => {
  const cases = [
    [{ version: "3.0.0" }, /has a version/],
    [{ extra: 1 }, /unknown field extra/],
    [{ id: "Herdr Tabs" }, /id "Herdr Tabs"/],
    [{ kind: "plugin" }, /kind "plugin"/],
    [{ os: ["macos", "macos"] }, /os /],
    [{ os: ["beos"] }, /os /],
    [{ targets: "everywhere" }, /targets "everywhere"/],
    [{ set: ["play"] }, /set /],
    [{ requires: [{ cap: "bots.cli" }] }, /requires .*not \{ cap, major \}/],
    [{ requires: [{ cap: "bots.cli", major: 0 }] }, /requires/],
    [{ provides: ["herdr.tabs"] }, /provides herdr.tabs: not <capability>@<major>/],
    [{ replaces: ["Not An Id"] }, /replaces/],
  ];
  for (const [extra, want] of cases) {
    const parts = valid();
    parts["herdr/mods/am-tabs/part.json"] = modPart("am-tabs", extra);
    assert.match(problemsOf(parts).join("\n"), want, JSON.stringify(extra));
  }
  const parts = valid();
  const { title, ...untitled } = modPart("am-tabs");
  parts["herdr/mods/am-tabs/part.json"] = untitled;
  assert.match(problemsOf(parts).join("\n"), /has no title/);
  parts["herdr/mods/am-tabs/part.json"] = "{ not json";
  assert.match(problemsOf(parts).join("\n"), /am-tabs\/part.json: not JSON/);
});

test("two parts with one id or one capability are refused", () => {
  const parts = valid();
  parts["herdr/mods/am-tabs/part.json"] = modPart("am-tabs", { id: "herdr.am-sidebar", entry: argv("../am-sidebar/bin/part.mjs", "herdr.am-sidebar") });
  assert.match(problemsOf(parts).join("\n"), /id herdr.am-sidebar is herdr\/mods\/am-sidebar\/part.json's too/);
  const caps = valid();
  caps["herdr/mods/am-tabs/part.json"] = modPart("am-tabs", { provides: ["herdr.am-sidebar@1"] });
  assert.match(problemsOf(caps).join("\n"), /provides herdr.am-sidebar, which herdr.am-sidebar provides too/);
});

test("what a part names must exist: its paths, its own folder as select, its entry script in the tarball", () => {
  const cases = [
    [{ paths: ["herdr/mods/am-gone/**"] }, /path herdr\/mods\/am-gone\/\*\* matches no file git tracks/],
    [{ paths: ["/abs/**"] }, /not relative/],
    [{ select: "am-sidebar/" }, /select am-sidebar\/ is herdr\/mods\/am-sidebar\/ in the repository, not this part's folder herdr\/mods\/am-tabs\//],
    [{ select: "am-tabs" }, /select "am-tabs" is not a folder/],
    [{ artifact: "am-tabs.tgz" }, /artifact "am-tabs.tgz"/],
    [{ entry: argv("../am-sidebar/bin/nope.mjs", "herdr.am-tabs") }, /herdr\/mods\/am-sidebar\/bin\/nope.mjs here, which git does not track/],
    [{ entry: argv("../../../x.mjs", "herdr.am-tabs") }, /outside the tarball/],
    [{ entry: { ...argv("../am-sidebar/bin/part.mjs", "herdr.am-tabs"), install: ["/usr/bin/node", "../am-sidebar/bin/part.mjs", "install", "herdr.am-tabs"] } }, /name a program \(node\), not a path/],
    [{ entry: argv("../am-sidebar/bin/part.mjs", "herdr.am-footer") }, /must be \["node", "..\/am-sidebar\/bin\/part.mjs", "install", "herdr.am-tabs"\]/],
    [{ entry: { install: ["node", "../am-sidebar/bin/part.mjs", "install", "herdr.am-tabs"] } }, /entry.uninstall is not an argv array/],
    [{ entry: { ...argv("../am-sidebar/bin/part.mjs", "herdr.am-tabs"), upgrade: ["node"] } }, /entry.upgrade is not install, uninstall, doctor or rollback/],
  ];
  for (const [extra, want] of cases) {
    const parts = valid();
    parts["herdr/mods/am-tabs/part.json"] = modPart("am-tabs", extra);
    assert.match(problemsOf(parts).join("\n"), want, JSON.stringify(extra));
  }
  // An optional rollback entry is checked like the others.
  const parts = valid();
  parts["herdr/mods/am-tabs/part.json"] = modPart("am-tabs", { entry: { ...argv("../am-sidebar/bin/part.mjs", "herdr.am-tabs"), rollback: ["node", "../am-sidebar/bin/part.mjs", "rollback", "herdr.am-tabs"] } });
  assert.deepEqual(problemsOf(parts), []);
});

test("writes: Herdr's shared.json and data/, Pocket Link, a LaunchAgent or a machine's own path are refused", () => {
  for (const [w, want] of [
    ["~/.config/herdr-app/shared.json", /Herdr's shared.json/],
    ["~/.config/herdr-app/shared.json#am.sidebar.projects", /Herdr's shared.json/],
    ["~/.config/herdr-app/data/am-mods/catalog.json", /Herdr's data\//],
    ["~/.config/herdr-app/mods/pocket-link/**", /Pocket Link/],
    ["~/Library/LaunchAgents/ai.namastex.pocket-link.plist", /a LaunchAgent/],
    ["~/.config/herdr-app/**", /can match ~\/.config\/herdr-app\/shared.json/],
    ["~/.config/herdr-app/*.json", /can match ~\/.config\/herdr-app\/shared.json/],
    ["~/.config/herdr-app/d*/**", /can match ~\/.config\/herdr-app\/data\/x: Herdr's data\//],
    ["~/.config/herdr-app/layouts/../shared.json", /a path with \.\. is not a part's to write/],
    ["~/**", /can match/],
    ["~/.config/herdr-app/mods/pocket-*/**", /Pocket Link/],
    ["/Users/someone/.local/bin/x", /start it with ~\/ \(the home\) or \*\*\/ \(any project\)/],
  ]) {
    const parts = valid();
    parts["herdr/mods/am-tabs/part.json"] = modPart("am-tabs", { writes: [w] });
    assert.match(problemsOf(parts).join("\n"), want, w);
  }
});

test("every pack mod needs a part.json; Pocket Link never has one", () => {
  const parts = valid();
  delete parts["herdr/mods/am-tabs/part.json"];
  assert.match(problemsOf(parts).join("\n"), /herdr\/mods\/am-tabs: a pack mod with no part.json/);
  const pocket = valid();
  pocket["herdr/mods/pocket-link/part.json"] = modPart("pocket-link");
  assert.match(problemsOf(pocket).join("\n"), /pocket-link\/part.json: Pocket Link is Pocket's part/);
});

test("this checkout's part.json files are valid (what CI runs: node scripts/parts.mjs --check)", () => {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: top, encoding: "utf8" }).split("\0").filter(Boolean);
  const r = validateParts({ files, read: (f) => readFileSync(join(top, f), "utf8"), packMods: PACK_MODS });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.parts.map((p) => p.id).sort(), [...PACK_MODS.map((m) => `herdr.${m}`), "herdr.layout"].sort());
  // The commands are the am part's (RFC 0012, D34): no herdr part ships or claims them, but the sidebar's
  // pack still links automagik-herdr as install.sh does until am ships.
  assert.ok(!files.includes("herdr/mods/am-sidebar/bin/part.json"), "herdr.cli is retired, never released");
  const sidebar = JSON.parse(readFileSync(join(top, "herdr/mods/am-sidebar/part.json"), "utf8"));
  assert.ok(sidebar.writes.includes("~/.local/bin/automagik-herdr"));
  assert.ok(!sidebar.writes.includes("~/.local/bin/am"));
  for (const cap of ["bots.cli", "bots.attach-ledger", "bots.whois-json"]) {
    for (const p of r.parts) assert.ok(!JSON.parse(readFileSync(join(top, p.file), "utf8")).provides.some((c) => c.startsWith(`${cap}@`)), `${p.id} provides ${cap}`);
  }
});
