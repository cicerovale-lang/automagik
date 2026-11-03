// The herdr parts' entries (mods/am-sidebar/parts.mjs, bin/part.mjs): install, uninstall and doctor
// of each part, with the pack made from this checkout, in a temp app home and a temp HOME. Programs
// run through an injected exec whose PATH has no herdr-app; doctor gets an exec that fails the test
// if called (it runs nothing). Never the real ~/.config/herdr-app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PART_IDS, contextOf, doctor, install, packSource, partOf, runCommand, uninstall } from "../mods/am-sidebar/parts.mjs";
import { main, parseArgs } from "../mods/am-sidebar/bin/part.mjs";
import { ownHook, withoutHooks } from "../mods/am-sidebar/migrateHooks.mjs";
import { hookCommand } from "../mods/am-sidebar/briefingText.mjs";
import { PACK_MODS } from "../mods/am-sidebar/release.js";
import { placeLayout, readMarker, readVersion } from "../mods/am-sidebar/update.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = readVersion(join(ROOT, "mods", "am-sidebar"));
const P = (id) => partOf(id);

/** A scratch machine: HOME and HERDR_APP_HOME in a temp folder, a PATH with node and tar but no herdr-app. */
function machine(t) {
  const dir = mkdtempSync(join(tmpdir(), "am-parts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const home = join(dir, "home"), app = join(dir, "app");
  mkdirSync(home);
  mkdirSync(app);
  const binDir = join(home, ".local", "bin");
  const env = { HOME: home, HERDR_APP_HOME: app, PATH: `${binDir}:${dirname(process.execPath)}:/usr/bin:/bin`, AM_PART_DIR: join(ROOT, "mods", "am-footer") };
  const logs = [];
  const calls = [];
  const exec = (cmd, args, opts) => { calls.push([cmd, ...args]); return runCommand(cmd, args, opts); };
  const ctx = (extra = {}, opts = {}) => contextOf({ env: { ...env, ...extra }, exec, log: (l) => logs.push(l), platform: "darwin", ...opts });
  return { dir, home, app, binDir, mods: join(app, "mods"), off: join(app, "mods-disabled"), env, logs, calls, ctx };
}
const noExec = () => { throw new Error("doctor ran a program"); };
const doctorOf = (m, id, extra) => doctor(contextOf({ env: { ...m.env, ...extra }, exec: noExec, log: () => {}, platform: "darwin" }), P(id));
const failed = (r) => r.checks.filter((c) => !c.ok).map((c) => c.check);
const ls = (dir) => (existsSync(dir) ? readdirSync(dir).sort() : []);

test("the ids, the argv and the contract around them", () => {
  assert.deepEqual(PART_IDS, [...PACK_MODS.map((m) => `herdr.${m}`), "herdr.layout"]);
  assert.deepEqual(P("herdr.am-sidebar"), { id: "herdr.am-sidebar", kind: "pack", mod: "am-sidebar" });
  assert.deepEqual(P("herdr.am-tabs"), { id: "herdr.am-tabs", kind: "mod", mod: "am-tabs" });
  assert.equal(P("herdr.pocket-link"), null);
  assert.equal(P("me.my-sidebar"), null);
  assert.deepEqual(parseArgs(["uninstall", "herdr.am-tabs", "--purge"]), { verb: "uninstall", part: P("herdr.am-tabs"), purge: true });
  for (const bad of [["install"], ["install", "herdr.nope"], ["remove", "herdr.layout"], ["install", "herdr.layout", "--purge"], ["doctor", "herdr.layout", "-v"], ["install", "herdr.cli"]]) {
    assert.throws(() => parseArgs(bad), /usage: node part.mjs/, bad.join(" "));
  }
});

test("off macOS every entry is not applicable (exit 2) and changes nothing", (t) => {
  const m = machine(t);
  const out = [];
  const ctx = m.ctx({ AM_JSON: "1" }, { platform: "linux" });
  assert.equal(main(["install", "herdr.am-sidebar"], { ctx, out: (l) => out.push(l) }), 2);
  assert.equal(JSON.parse(out[0]).ok, false);
  assert.equal(main(["doctor", "herdr.layout"], { ctx, out: (l) => out.push(l) }), 2);
  assert.match(JSON.parse(out[1]).detail, /not applicable/);
  assert.deepEqual(ls(m.app), []);
  assert.equal(main(["bogus"], { ctx, out: () => {} }), 64, "a usage error (EX_USAGE), never 2 (not applicable)");
});

test("install from a checkout: the whole pack once, the record its marker; a second install is a no-op", (t) => {
  const m = machine(t);
  const out = [];
  assert.equal(main(["install", "herdr.am-footer"], { ctx: m.ctx({ AM_JSON: "1" }), out: (l) => out.push(l) }), 0, m.logs.join("\n"));
  assert.deepEqual(JSON.parse(out[0]), { part: "herdr.am-footer", ok: true, changed: true, detail: `am-footer is on (pack ${VERSION})` });
  const record = readMarker(m.mods);
  assert.equal(record.version, VERSION);
  assert.deepEqual([...record.mods].sort(), [...PACK_MODS].sort());
  assert.deepEqual(ls(m.mods), [...PACK_MODS].sort(), "every pack mod, and nothing else");
  assert.ok(existsSync(join(m.app, "layouts", "automagik.json")), "the layout placed");
  assert.ok(existsSync(join(m.mods, "am-footer", "part.json")), "part.json ships in the mod folder");
  assert.equal(readFileSync(join(m.app, "keys.json"), "utf8").includes("cmd-shift-m"), true);
  const installs = m.calls.filter((c) => c.some((a) => a.endsWith("update.mjs"))).length;
  assert.equal(installs, 1);

  // The pack is in; the sidebar's part also links the command (a change), then nothing changes again.
  assert.equal(install(m.ctx({ AM_VERSION: VERSION }), P("herdr.am-sidebar"), packSource).changed, true);
  for (const id of PART_IDS) {
    const r = install(m.ctx({ AM_VERSION: VERSION }), P(id), packSource);
    assert.equal(r.changed, false, id);
  }
  assert.equal(m.calls.filter((c) => c.some((a) => a.endsWith("update.mjs"))).length, 1, "the same version never reinstalls");
});

test("AM_ARTIFACT: am's verified tarball is installed as it is", (t) => {
  const m = machine(t);
  const src = packSource(m.ctx());
  t.after(src.cleanup);
  const r = install(m.ctx({ AM_ARTIFACT: src.tgz, AM_VERSION: VERSION, AM_PART_DIR: join(m.dir, "nowhere") }), P("herdr.am-sidebar"), packSource);
  assert.equal(r.ok, true);
  assert.equal(readMarker(m.mods).version, VERSION);
  // A version am names that the tarball does not carry is refused by update.mjs, writing nothing more.
  const m2 = machine(t);
  assert.throws(() => install(m2.ctx({ AM_ARTIFACT: src.tgz, AM_VERSION: "9.9.9" }), P("herdr.am-sidebar"), packSource), /was not installed/);
  assert.equal(readMarker(m2.mods), null);
});

test("one mod: uninstall switches it off, an update keeps it off, doctor says not applicable, install switches it on", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.am-tabs"), packSource);
  install(m.ctx(), P("herdr.am-sidebar"), packSource);
  assert.equal(doctorOf(m, "herdr.am-tabs").code, 0);

  const r = uninstall(m.ctx(), P("herdr.am-tabs"));
  assert.equal(r.changed, true);
  assert.ok(!existsSync(join(m.mods, "am-tabs")));
  assert.ok(existsSync(join(m.off, "am-tabs", "main.js")));
  assert.ok(readMarker(m.mods).mods.includes("am-tabs"), "the marker keeps mods= as it is");
  assert.equal(uninstall(m.ctx(), P("herdr.am-tabs")).changed, false, "idempotent");
  const d = doctorOf(m, "herdr.am-tabs");
  assert.equal(d.code, 2);
  assert.deepEqual(d.checks.map((c) => c.check), ["record", "switched-off"]);
  assert.equal(doctorOf(m, "herdr.am-sidebar").code, 0, "the pack is healthy with a mod off");

  assert.equal(install(m.ctx(), P("herdr.am-tabs"), packSource).changed, true);
  assert.ok(existsSync(join(m.mods, "am-tabs", "main.js")));
  assert.deepEqual(ls(m.off), []);
});

test("am-mods: its key goes with it while it is the pack's, a rebound one stays, and install puts it back", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.am-mods"), packSource);
  const keys = () => JSON.parse(readFileSync(join(m.app, "keys.json"), "utf8"));
  uninstall(m.ctx(), P("herdr.am-mods"));
  assert.equal(keys().global["cmd-shift-m"], undefined);
  assert.deepEqual(failed(doctorOf(m, "herdr.am-mods")), [], "off: not checked");
  install(m.ctx(), P("herdr.am-mods"), packSource);
  assert.equal(keys().global["cmd-shift-m"], "mod.open:am-mods");
  assert.equal(doctorOf(m, "herdr.am-mods").code, 0);

  writeFileSync(join(m.app, "keys.json"), JSON.stringify({ global: { "cmd-shift-m": "my.action" } }));
  uninstall(m.ctx(), P("herdr.am-mods"));
  assert.equal(keys().global["cmd-shift-m"], "my.action", "the person's binding stays");
  install(m.ctx(), P("herdr.am-mods"), packSource);
  assert.equal(keys().global["cmd-shift-m"], "my.action");
  assert.match(doctorOf(m, "herdr.am-mods").checks.find((c) => c.check === "keys").detail, /is yours/);
});

test("herdr.am-sidebar links automagik-herdr as install.sh does, leaves someone else's, and records AM_SEQUENCE", (t) => {
  const m = machine(t);
  const r = install(m.ctx({ AM_SEQUENCE: "630001" }), P("herdr.am-sidebar"), packSource);
  assert.equal(r.ok, true);
  assert.equal(readMarker(m.mods).sequence, 630001, "the signed pointer's sequence: install.sh's replay guard stays on");
  const link = join(m.binDir, "automagik-herdr");
  assert.equal(readlinkSync(link), join(m.mods, "am-sidebar", "bin", "automagik-herdr"));
  assert.ok(!existsSync(join(m.binDir, "am")), "am is the am part's (D34), never the pack's");
  const d = doctorOf(m, "herdr.am-sidebar");
  assert.deepEqual(failed(d), [], JSON.stringify(d.checks));
  assert.deepEqual(d.checks.map((c) => c.check), ["record", "folder", "files", "pack-version", "pack-mods", "briefing-entry", "command", "path", "node"]);
  const noPath = doctorOf(m, "herdr.am-sidebar", { PATH: "/usr/bin" });
  assert.equal(noPath.code, 0, "not on PATH is a note, never a rollback");
  assert.match(noPath.checks.find((c) => c.check === "path").fix, /export PATH=/);
  assert.equal(install(m.ctx(), P("herdr.am-sidebar"), packSource).changed, false, "idempotent");

  rmSync(link);
  assert.deepEqual(failed(doctorOf(m, "herdr.am-sidebar")), ["command"]);
  assert.equal(doctorOf(m, "herdr.am-sidebar").checks.find((c) => c.check === "command").fix, "am install herdr.am-sidebar");
  assert.equal(install(m.ctx(), P("herdr.am-sidebar"), packSource).changed, true, "the link comes back");

  rmSync(link);
  symlinkSync("/usr/bin/true", link);
  assert.equal(install(m.ctx(), P("herdr.am-sidebar"), packSource).ok, true);
  assert.ok(m.logs.some((l) => /points at \/usr\/bin\/true, not this install: left alone/.test(l)));
  uninstall(m.ctx(), P("herdr.am-sidebar"));
  assert.equal(readlinkSync(link), "/usr/bin/true", "the person's link stays");
  install(m.ctx(), P("herdr.am-sidebar"), packSource);
  const theirs = doctorOf(m, "herdr.am-sidebar");
  assert.equal(theirs.code, 0, "someone else's link is a note, never a rollback");
  const cmd = theirs.checks.find((c) => c.check === "command");
  assert.match(cmd.detail, /points at \/usr\/bin\/true, not this install: left alone/);
  assert.equal(cmd.fix, `rm ${link} && am install herdr.am-sidebar`);
  rmSync(link);
  writeFileSync(link, "#!/bin/sh\n");
  assert.equal(doctorOf(m, "herdr.am-sidebar").code, 0, "a file of the person's: a note too");
  assert.equal(P("herdr.cli"), null, "herdr.cli is retired (D34)");
});

test("herdr.layout: uninstall removes the pack's copy and no update puts it back; install does; yours stays", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.layout"), packSource);
  const live = join(m.app, "layouts", "automagik.json");
  assert.equal(doctorOf(m, "herdr.layout").code, 0);
  uninstall(m.ctx(), P("herdr.layout"));
  assert.ok(!existsSync(live));
  assert.equal(readMarker(m.mods).layout, "removed");
  assert.equal(doctorOf(m, "herdr.layout").code, 2);

  // What an update or install.sh's repair runs: the layout stays out.
  const src = packSource(m.ctx());
  t.after(src.cleanup);
  const record = readMarker(m.mods);
  assert.equal(placeLayout({ modsDir: m.mods, tgzDir: src.tree, record, log: () => {} }), "removed");
  assert.ok(!existsSync(live));
  assert.equal(readMarker(m.mods).layout, "removed");

  install(m.ctx(), P("herdr.layout"), packSource);
  assert.ok(existsSync(live));
  assert.equal(readMarker(m.mods).layout, "added");

  writeFileSync(live, "{\"mine\": true}\n");
  const r = uninstall(m.ctx(), P("herdr.layout"));
  assert.match(r.detail, /it is yours, left as it is/);
  assert.equal(readFileSync(live, "utf8"), "{\"mine\": true}\n");
  assert.match(doctorOf(m, "herdr.layout").checks.find((c) => c.check === "layout").detail, /is yours/);
});

test("herdr.am-sidebar uninstall: the whole pack out; hooks, entry point, keys and links go; Herdr's and Pocket's files stay", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.am-sidebar"), packSource);
  uninstall(m.ctx(), P("herdr.am-quota"));
  assert.equal(doctorOf(m, "herdr.am-sidebar").code, 0, JSON.stringify(doctorOf(m, "herdr.am-sidebar").checks));

  // A project the CLI knows, with the pack's hook beside a hook of the person's.
  const project = join(m.dir, "project");
  mkdirSync(join(project, ".claude"), { recursive: true });
  const settings = join(project, ".claude", "settings.local.json");
  const theirs = { type: "command", command: "echo mine" };
  writeFileSync(settings, JSON.stringify({ permissions: { allow: ["Bash"] }, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand(m.app) }, theirs] }] } }, null, 2));
  writeFileSync(join(m.app, "am-sidebar-projects.json"), JSON.stringify([project]));
  // Herdr's own files and Pocket Link: never touched.
  writeFileSync(join(m.app, "shared.json"), "{\"herdr\": 1}\n");
  mkdirSync(join(m.mods, "pocket-link"));
  writeFileSync(join(m.mods, "pocket-link", "main.js"), "pocket\n");
  const data = ls(join(m.app, "data"));

  const r = uninstall(m.ctx(), P("herdr.am-sidebar"));
  assert.equal(r.ok, true);
  assert.deepEqual(ls(m.mods), ["pocket-link"]);
  assert.deepEqual(ls(m.off), [], "a switched-off mod leaves too");
  const prev = join(m.app, "automagik-herdr", ".prev");
  assert.deepEqual(ls(prev), [".pack", ...PACK_MODS].sort(), "kept, with its data, without --purge");
  assert.equal(readMarker(m.mods), null, "the record is gone");
  assert.ok(!existsSync(join(m.app, "automagik-herdr", "briefing.mjs")));
  assert.ok(!existsSync(join(m.app, "layouts", "automagik.json")));
  assert.ok(!existsSync(join(m.binDir, "automagik-herdr")));
  assert.equal(JSON.parse(readFileSync(join(m.app, "keys.json"), "utf8")).global["cmd-shift-m"], undefined);
  const after = JSON.parse(readFileSync(settings, "utf8"));
  assert.deepEqual(after, { permissions: { allow: ["Bash"] }, hooks: { UserPromptSubmit: [{ hooks: [theirs] }] } });
  assert.ok(existsSync(`${settings}.am-backup`), "backed up first");
  assert.equal(readFileSync(join(m.app, "shared.json"), "utf8"), "{\"herdr\": 1}\n");
  assert.equal(readFileSync(join(m.mods, "pocket-link", "main.js"), "utf8"), "pocket\n");
  assert.deepEqual(ls(join(m.app, "data")), data);

  assert.match(uninstall(m.ctx(), P("herdr.am-sidebar")).detail, /not installed: nothing to do/, "idempotent");
  for (const id of PART_IDS) assert.equal(uninstall(m.ctx(), P(id)).ok, true, id);
  assert.equal(doctorOf(m, "herdr.am-sidebar").code, 1);
  assert.equal(doctorOf(m, "herdr.am-sidebar").checks[0].fix, "am install herdr.am-sidebar");

  // Reinstalled, then purged: the kept set goes too.
  install(m.ctx(), P("herdr.am-sidebar"), packSource);
  uninstall(m.ctx(), P("herdr.am-sidebar"), { purge: true });
  assert.ok(!existsSync(prev));
  assert.deepEqual(ls(m.mods), ["pocket-link"]);
});

test("doctor reads only: a healthy pack passes every part, a broken one names the check and its fix", (t) => {
  const m = machine(t);
  install(m.ctx(), P("herdr.am-sidebar"), packSource);
  const before = execFileSync("find", [m.dir, "-print"], { encoding: "utf8" });
  for (const id of PART_IDS) {
    const r = doctorOf(m, id, { AM_VERSION: VERSION });
    assert.equal(r.code, 0, `${id}: ${JSON.stringify(r.checks.filter((c) => !c.ok))}`);
    for (const c of r.checks) {
      assert.deepEqual(Object.keys(c), ["part", "check", "ok", "detail", "fix"]);
      assert.equal(c.part, id);
      assert.equal(c.fix, null);
    }
  }
  assert.equal(execFileSync("find", [m.dir, "-print"], { encoding: "utf8" }), before, "nothing written");

  assert.deepEqual(failed(doctorOf(m, "herdr.am-footer", { AM_VERSION: "9.9.9" })), ["version"]);
  rmSync(join(m.app, "automagik-herdr", "briefing.mjs"));
  const d = doctorOf(m, "herdr.am-sidebar");
  assert.deepEqual(failed(d), ["briefing-entry"]);
  assert.equal(d.checks.find((c) => c.check === "briefing-entry").fix, "am install herdr.am-sidebar");
  rmSync(join(m.mods, "am-status", "mod.json"));
  assert.deepEqual(failed(doctorOf(m, "herdr.am-status")), ["files"]);
  rmSync(join(m.mods, "am-tabs"), { recursive: true });
  assert.deepEqual(failed(doctorOf(m, "herdr.am-tabs")), ["folder"]);
  assert.deepEqual(failed(doctorOf(m, "herdr.am-sidebar")), ["pack-mods", "briefing-entry"]);

  // Through the entry: JSON lines, exit 1.
  const out = [];
  const code = main(["doctor", "herdr.am-tabs"], { ctx: contextOf({ env: m.env, exec: noExec, log: () => {}, platform: "darwin" }), out: (l) => out.push(l) });
  assert.equal(code, 1);
  assert.deepEqual(out.map((l) => JSON.parse(l).check), ["record", "folder"]);
});

test("withoutHooks takes out only the pack's own hook for this app home", () => {
  const app = "/tmp/app";
  const other = hookCommand("/tmp/other-app");
  const text = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand(app) }] }, { hooks: [{ type: "command", command: other }] }], Stop: [] } });
  const r = withoutHooks(text, ownHook(app));
  assert.equal(r.removed, 1);
  assert.deepEqual(JSON.parse(r.text), { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: other }] }], Stop: [] } });
  const only = withoutHooks(JSON.stringify({ a: 1, hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: hookCommand(app) }] }] } }), ownHook(app));
  assert.deepEqual(JSON.parse(only.text), { a: 1 }, "an emptied list and hooks go");
  assert.equal(withoutHooks("{}", ownHook(app)).removed, 0);
  assert.match(withoutHooks("{ x", ownHook(app)).error, /not valid JSON/);
  assert.equal(lstatSync(ROOT).isDirectory(), true);
});
