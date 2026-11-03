#!/usr/bin/env node
// Every herdr part's entry (RFC 0012): each part.json under herdr/ and herdr-layout/ names this file
// in its `entry` argv, relative to the part's folder in the pack tarball.
//
//   node part.mjs install   <id>            the part in place (idempotent)
//   node part.mjs uninstall <id> [--purge]  the part out (idempotent); user data stays unless --purge
//   node part.mjs doctor    <id>            read-only: one JSON line per check
//                                           {part, check, ok, detail, fix}
//
// Exit 0 healthy (done), 1 broken (failed), 2 not applicable (not macOS; doctor: a mod switched off,
// or a layout uninstalled), 64 a usage error. install and uninstall print what they did on stderr,
// then one line on stdout: JSON `{part, ok, changed, detail}` with AM_JSON=1, else the detail. am runs it with
// AM_HOME, AM_PART_DIR (`<extracted pack>/<select>`), AM_ARTIFACT (the verified tarball), AM_VERSION,
// AM_SEQUENCE (the signed pointer's, recorded in the marker) and AM_JSON (parts.mjs packSource reads
// the artifact; contextOf the rest). Apache-2.0.

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { PART_IDS, contextOf, doctor, install, packSource, partOf, uninstall } from "../parts.mjs";

export const USAGE = `usage: node part.mjs install <id> | uninstall <id> [--purge] | doctor <id>   (id: ${PART_IDS.join(", ")})`;

/** `{ verb, part, purge }`, or throws a usage error (exit 64, EX_USAGE: 2 means not applicable). */
export function parseArgs(argv) {
  const [verb, id, ...rest] = argv;
  const part = partOf(id);
  const usage = () => Object.assign(new Error(USAGE), { usage: true });
  if (!["install", "uninstall", "doctor"].includes(verb) || !part) throw usage();
  if (rest.some((a) => !(verb === "uninstall" && a === "--purge"))) throw usage();
  return { verb, part, purge: rest.includes("--purge") };
}

/** Runs one entry; returns the exit code. `out` takes stdout lines. */
export function main(argv, { ctx = contextOf(), out = (line) => process.stdout.write(`${line}\n`), source = packSource } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (error) { ctx.log(error.message); return 64; }
  const { verb, part, purge } = args;
  if (verb === "doctor") {
    const r = doctor(ctx, part);
    for (const c of r.checks) out(JSON.stringify(c));
    return r.code;
  }
  const json = ctx.env.AM_JSON === "1";
  const say = (r) => out(json ? JSON.stringify({ part: part.id, ...r }) : r.detail);
  if (ctx.platform !== "darwin") {
    say({ ok: false, changed: false, detail: `not applicable: Automagik Herdr runs on macOS; this is ${ctx.platform}` });
    return 2;
  }
  try {
    say(verb === "install" ? install(ctx, part, source) : uninstall(ctx, part, { purge }));
    return 0;
  } catch (error) {
    say({ ok: false, changed: false, detail: error.message });
    return 1;
  }
}

const invoked = (() => { try { return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (invoked) process.exitCode = main(process.argv.slice(2));
