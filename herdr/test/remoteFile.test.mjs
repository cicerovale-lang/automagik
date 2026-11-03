// remoteFile.js: another machine's file read and written through herdr-core with the local
// compare-and-swap rule. The "machine" is a temp folder here: its shell lines run for real
// (sh), and hc's file ops are a stand-in with hc's answers (exit 3 not_found, 1 edit_failed,
// 4 machine_unknown, errors as JSON on stderr). Never the real hc.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REMOTE_TEXT_MAX, RemoteFileError, StaleSnapshot, readRemoteText, removeRemoteText, utf8Length, writeRemoteText } from "../mods/am-sidebar/remoteFile.js";

const fail = (code, kind, message) => ({ code, stdout: "", stderr: `${JSON.stringify({ error: { kind, message, hint: "h" } })}\n` });

/** hc's file read/edit on machine "vm" (any other name is unknown; `down` makes it unavailable). */
function fakeIo({ down = false, before = null } = {}) {
  const calls = [];
  const known = (m) => m === "vm";
  const hc = async (args) => {
    calls.push(args);
    const on = args[args.indexOf("--on") + 1];
    if (!known(on)) return fail(4, "machine_unknown", `unknown machine "${on}"`);
    if (down) return fail(1, "unavailable", `${on} isn't connected`);
    const path = args[args.length - 1];
    if (args[1] === "read") {
      let text;
      try { text = readFileSync(path, "utf8"); } catch { return fail(3, "not_found", `no file ${path}`); }
      const lines = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
      return { code: 0, stdout: JSON.stringify({ first: 1, last: lines, lines, text }), stderr: "" };
    }
    if (args[1] === "edit") {
      const old = args.find((a) => a.startsWith("--old=")).slice(6), now = args.find((a) => a.startsWith("--new=")).slice(6);
      await before?.(path);
      let text;
      try { text = readFileSync(path, "utf8"); } catch { return fail(3, "not_found", `no file ${path}`); }
      const at = text.indexOf(old);
      if (at < 0 || text.indexOf(old, at + 1) >= 0) return fail(1, "edit_failed", "the old text is not in the file");
      writeFileSync(path, text.slice(0, at) + now + text.slice(at + old.length));
      return { code: 0, stdout: JSON.stringify({ bytes: now.length, path }), stderr: "" };
    }
    return fail(2, "invalid_params", "no such op");
  };
  const exec = (command, args, machine) => {
    calls.push(["exec", machine, command, ...args]);
    if (!known(machine) || down) return Promise.reject(new Error(`${machine} is unreachable`));
    return new Promise((done) => execFile(command, args, (err, stdout, stderr) => done({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr })));
  };
  return { hc, exec, calls };
}

function scratch(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hb-remote-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("read: the text; no file is null; any other answer throws, so it never reads as no file", async (t) => {
  const root = scratch(t);
  const path = join(root, "bots.json");
  assert.equal(await readRemoteText(fakeIo(), "vm", path), null);
  writeFileSync(path, "{\n}\n");
  assert.equal(await readRemoteText(fakeIo(), "vm", path), "{\n}\n");
  await assert.rejects(readRemoteText(fakeIo({ down: true }), "vm", path), (e) => e instanceof RemoteFileError && e.kind === "unavailable");
  await assert.rejects(readRemoteText(fakeIo(), "nosuch", path), (e) => e.kind === "machine_unknown" && !(e instanceof StaleSnapshot));
  // A read cut short at hc's cap is refused, never used as the whole file.
  const cut = { hc: async () => ({ code: 0, stdout: JSON.stringify({ first: 1, last: 2, lines: 9, text: "a\nb\n" }), stderr: "" }) };
  await assert.rejects(readRemoteText(cut, "vm", path), (e) => e.kind === "too_large");
  // hc missing or the call itself failing is a failure too.
  await assert.rejects(readRemoteText({ hc: async () => { throw new Error("spawn hc ENOENT"); } }, "vm", path), (e) => e.kind === "unavailable");
});

test("create: folders made, the file written only when it isn't there", async (t) => {
  const root = scratch(t);
  const path = join(root, "proj/.herdr/bots.json");
  const io = fakeIo();
  assert.equal(await writeRemoteText(io, "vm", path, "one\n", null), null);
  assert.equal(readFileSync(path, "utf8"), "one\n");
  // It appeared since the read: refused, the file left as it is.
  await assert.rejects(writeRemoteText(io, "vm", path, "two\n", null), StaleSnapshot);
  assert.equal(readFileSync(path, "utf8"), "one\n");
  // Text that looks like options or holds quotes and newlines goes through as it is.
  const odd = join(root, "odd/bots.json");
  const text = "-n '$HOME' \"x\"\n\\n%s\n";
  await writeRemoteText(io, "vm", odd, text, null);
  assert.equal(readFileSync(odd, "utf8"), text);
  // A dangling link where the file goes is never written through.
  const link = join(root, "link.json");
  symlinkSync(join(root, "elsewhere.json"), link);
  await assert.rejects(writeRemoteText(io, "vm", link, "x", null), StaleSnapshot);
  assert.equal(existsSync(join(root, "elsewhere.json")), false);
  // The machine away: a failure, not stale.
  await assert.rejects(writeRemoteText(fakeIo({ down: true }), "vm", join(root, "z.json"), "x", null),
    (e) => e instanceof RemoteFileError && !(e instanceof StaleSnapshot) && e.kind === "unavailable");
});

test("replace: lands only while the file holds the text read; a change, a removal or the machine away is refused", async (t) => {
  const root = scratch(t);
  const path = join(root, "bots.json");
  writeFileSync(path, "{\"a\":1}\n");
  const io = fakeIo();
  await writeRemoteText(io, "vm", path, "{\"a\":2}\n", "{\"a\":1}\n");
  assert.equal(readFileSync(path, "utf8"), "{\"a\":2}\n");
  const edit = io.calls.find((c) => c[1] === "edit");
  assert.deepEqual(edit.slice(0, 5), ["file", "edit", "--json", "--on", "vm"]);
  assert.equal(edit.at(-1), path);
  // Someone else's edit landed between the read and this write.
  const raced = fakeIo({ before: (p) => writeFileSync(p, "{\"a\":3}\n") });
  await assert.rejects(writeRemoteText(raced, "vm", path, "{\"a\":4}\n", "{\"a\":2}\n"), (e) => e instanceof StaleSnapshot && /changed since/.test(e.message));
  assert.equal(readFileSync(path, "utf8"), "{\"a\":3}\n");
  rmSync(path);
  await assert.rejects(writeRemoteText(io, "vm", path, "x\n", "{\"a\":3}\n"), (e) => e instanceof StaleSnapshot && /gone/.test(e.message));
  assert.equal(existsSync(path), false);
  writeFileSync(path, "{\"a\":3}\n");
  await assert.rejects(writeRemoteText(fakeIo({ down: true }), "vm", path, "x\n", "{\"a\":3}\n"), (e) => !(e instanceof StaleSnapshot) && e.kind === "unavailable");
  assert.equal(readFileSync(path, "utf8"), "{\"a\":3}\n");
});

test("replace: an empty file and text past the cap are refused before anything is sent", async (t) => {
  const io = fakeIo();
  await assert.rejects(writeRemoteText(io, "vm", "/x/bots.json", "y", ""), (e) => e.kind === "empty");
  await assert.rejects(writeRemoteText(io, "vm", "/x/bots.json", "y".repeat(REMOTE_TEXT_MAX + 1), "z"), (e) => e.kind === "too_large");
  assert.equal(io.calls.length, 0);
  await assert.rejects(writeRemoteText(io, "vm", "/x/bots.json", "y"), /pass the text the edit started from/);
});

test("remove: only while the file holds the text read, trailing newlines included", async (t) => {
  const root = scratch(t);
  const path = join(root, "bots.json");
  writeFileSync(path, "keep\n\n");
  const io = fakeIo();
  await assert.rejects(removeRemoteText(io, "vm", path, "keep\n"), StaleSnapshot);
  assert.ok(existsSync(path));
  await removeRemoteText(io, "vm", path, "keep\n\n");
  assert.equal(existsSync(path), false);
  await assert.rejects(removeRemoteText(io, "vm", path, "keep\n\n"), StaleSnapshot);
});

// An answer lost after the call went out: `land` runs the real call or not, then hc's timeout.
const lost = (io, land) => ({
  hc: async (args) => { if (land) await io.hc(args); return { code: 1, stdout: "", stderr: "hc: timed out waiting for vm" }; },
  exec: async (command, args, machine) => { if (land) await io.exec(command, args, machine); return { code: -1, stdout: "", stderr: "timed out after 60 s" }; },
  read: io,
});
const withRead = (l, io) => ({ hc: async (args) => (args[1] === "read" ? io.hc(args) : l.hc(args)), exec: l.exec });

test("an edit or create that landed but lost its answer is a success (a retry never adds a bot twice)", async (t) => {
  const root = scratch(t);
  const path = join(root, "bots.json");
  const io = fakeIo();
  await writeRemoteText(withRead(lost(io, true), io), "vm", path, "made\n", null);
  assert.equal(readFileSync(path, "utf8"), "made\n");
  await writeRemoteText(withRead(lost(io, true), io), "vm", path, "edited\n", "made\n");
  assert.equal(readFileSync(path, "utf8"), "edited\n");
});

test("an edit or create whose answer was lost and that didn't land: State unknown, check before retrying", async (t) => {
  const root = scratch(t);
  const path = join(root, "bots.json");
  const io = fakeIo();
  await assert.rejects(writeRemoteText(withRead(lost(io, false), io), "vm", path, "made\n", null),
    (e) => e.kind === "unknown_state" && /^State unknown: .*check .*bots\.json on vm before trying again/.test(e.message));
  writeFileSync(path, "old\n");
  await assert.rejects(writeRemoteText(withRead(lost(io, false), io), "vm", path, "new\n", "old\n"), (e) => e.kind === "unknown_state");
  // A refusal before anything was written stays a plain failure, never "unknown".
  await assert.rejects(writeRemoteText(fakeIo({ down: true }), "vm", path, "new\n", "old\n"), (e) => e.kind === "unavailable");
});

test("create: a folder it can't write leaves no file and is a failure, not stale", async (t) => {
  const root = scratch(t);
  const dir = join(root, "ro");
  execFileSync("mkdir", ["-p", dir]);
  execFileSync("chmod", ["555", dir]);
  t.after(() => { try { execFileSync("chmod", ["755", dir]); } catch { /* removed already */ } });
  await assert.rejects(writeRemoteText(fakeIo(), "vm", join(dir, "bots.json"), "x\n", null), (e) => !(e instanceof StaleSnapshot) && e.kind !== "unknown_state");
  assert.equal(existsSync(join(dir, "bots.json")), false);
});

test("read: herdr-core's io error is a failure, never 'no file'", async () => {
  const io = { hc: async () => ({ code: 1, stdout: "", stderr: JSON.stringify({ error: { kind: "io", message: "permission denied" } }) }) };
  await assert.rejects(readRemoteText(io, "vm", "/x/bots.json"), (e) => e instanceof RemoteFileError && e.kind === "io" && /permission denied/.test(e.message));
});

test("the cap is per argument in UTF-8 bytes: multibyte text under the character count is still refused", async () => {
  assert.equal(utf8Length("aé€😀"), 1 + 2 + 3 + 4);
  const io = fakeIo();
  const wide = "€".repeat(Math.ceil(REMOTE_TEXT_MAX / 3) + 1); // fewer characters than the cap, more bytes
  assert.ok(wide.length < REMOTE_TEXT_MAX);
  await assert.rejects(writeRemoteText(io, "vm", "/x/bots.json", wide, null), (e) => e.kind === "too_large" && /make the file smaller/.test(e.message));
  assert.equal(io.calls.length, 0);
});
