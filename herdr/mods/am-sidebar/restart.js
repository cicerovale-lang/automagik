// Restart over plain data: what a bot's replacement pane runs (resume the conversation, a
// fresh one, or a swap to another agent or model), why a restart is refused, and the labels
// the replacement carries over from the old pane. The CLI's `restart` runs it with hc; the
// sidebar's Restart runs the CLI. Pure: no `herdr`, so `node --test` runs it. Apache-2.0.

import { canResume, modelArgs, resumeArgs } from "./models.js";
import { SQUAD_LABEL, SQUAD_MARK } from "./launchArgs.js";

/** The pane label the briefing hook sets to the Claude session a terminal runs (workers.js SESSION_LABEL). */
const SESSION = "agent.session";

// A Claude session id is a UUID; anything else (a value starting with "-" would read as a
// flag) is not passed to --resume.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `s` trimmed when it is a session id Restart may resume (UUID-shaped), else null. */
export const sessionId = (s) => (typeof s === "string" && UUID.test(s.trim()) ? s.trim() : null);

/**
 * What the replacement runs. `bot`: { agent, model } as stored; `run`: the target agent's
 * `run` (Herdr's table, programs.json applied); `runningAgent`: the agent key the old pane's
 * foreground runs (agentKeyOfArgv), null when unknown or when nothing runs; `session`: the old
 * pane's agent.session label; `fresh`, `agent`, `model`: the options (undefined: not given).
 * An --agent or --model is a swap, always fresh: a conversation doesn't cross agents. Returns
 * { mode: "resume" | "fresh" | "swap", agent, model, resume (the resume words, [] for a new
 * conversation), argv, note } (`note`: why a resume wasn't possible, else null).
 */
export function restartPlan({ bot, run, runningAgent = null, session = null, fresh = false, agent, model }) {
  const swap = agent !== undefined || model !== undefined;
  const key = agent ?? bot.agent;
  // A new agent without --model starts on its own default: the old pin belongs to the old agent.
  const pin = model !== undefined ? (model || null) : key === bot.agent ? (bot.model ?? null) : null;
  const plan = (mode, extra = [], note = null) => ({ mode, agent: key, model: pin, resume: extra, argv: [...run, ...extra, ...modelArgs(key, pin)], note });
  if (swap) return plan("swap");
  if (fresh) return plan("fresh");
  if (runningAgent && runningAgent !== key) return plan("fresh", [], `its pane runs ${runningAgent}, not ${key}, and a conversation doesn't cross agents`);
  if (!canResume(key)) return plan("fresh", [], `${key} has no resume this pack knows`);
  const id = key === "claude" ? sessionId(session) : null;
  return plan("resume", resumeArgs(key, id));
}

/** The old pane's Claude session id (its agent.session label, UUID-shaped), or null. */
export const sessionOf = (get) => sessionId(get?.labels?.[SESSION]);

/**
 * The last Claude session the workers ledger ties to `terminal` (its session rows, workers.js
 * readLedger): { session, transcript }, or null. For a pane whose label is missing.
 */
export function ledgerSession(rows, terminal) {
  for (let i = (rows?.length ?? 0) - 1; i >= 0; i -= 1) {
    const r = rows[i];
    if (r?.event !== "session" || r.terminal !== terminal) continue;
    const session = sessionId(r.session);
    if (session) return { session, transcript: typeof r.transcript === "string" ? r.transcript : null };
  }
  return null;
}

/**
 * Why Restart won't resume with claude --continue, or null: it takes the folder's latest
 * conversation, which may be a teammate's when another bot's Claude pane runs in that folder.
 * `sharers`: those panes as { address, name }.
 */
export function continueRefusal({ name, old, cwd, sharers = [] }) {
  if (!sharers.length) return null;
  const who = sharers.map((x) => `${x.name} (${x.address})`).join(", ");
  return `${name} has no recorded Claude session (${old.address} has no agent.session label and the ledger has no session row for it), `
    + `and ${who} also ${sharers.length === 1 ? "runs" : "run"} Claude in ${cwd}, so --continue could resume theirs. Nothing was started; `
    + `restart with --fresh for a new conversation.`;
}

/**
 * Why a restart of `old` (hc get of the bot's live pane) is refused, or null. `name`: the
 * bot's name; `helpers`: hc get answers of the live terminals whose parent is the old pane.
 * A pane mid-turn would have the turn cut in half; a helper hc ends with its parent
 * (die_with_parent, as a worker is) would end with it. --force (`force`) overrides both.
 */
export function restartRefusal({ name, old, helpers = [], force = false }) {
  if (force) return null;
  if (old?.status?.state === "working") {
    return `${name} is working in ${old.address}; restarting now would cut its turn in half. Wait until it is idle, or pass --force.`;
  }
  const doomed = helpers.filter((h) => h?.state === "live" && h.die_with_parent !== false).map((h) => h.address);
  if (doomed.length) {
    const one = doomed.length === 1;
    return `${old.address} has ${one ? "a helper that ends" : "helpers that end"} with it: ${doomed.join(", ")}. `
      + `Let ${one ? "it" : "them"} finish, or pass --force to end ${one ? "it" : "them"} with the pane.`;
  }
  return null;
}

/**
 * The labels the replacement carries beyond paneLabels: a squad on the old pane (anyone's,
 * not only one this pack copied) and its mark, so the restart moves the pane, not its squad.
 */
export function carriedLabels(old) {
  const have = old?.labels ?? {};
  const out = {};
  if (have[SQUAD_LABEL]) out[SQUAD_LABEL] = have[SQUAD_LABEL];
  if (have[SQUAD_MARK]) out[SQUAD_MARK] = have[SQUAD_MARK];
  return out;
}

/** One line for the owner: what the replacement does with the conversation. */
export function planText(plan, session) {
  if (plan.mode === "swap") return `on ${plan.agent}${plan.model ? ` (${plan.model})` : ""}, a new conversation`;
  if (plan.mode === "fresh") return plan.note ? `a new conversation (${plan.note})` : "a new conversation";
  if (plan.agent === "claude") return session ? `resuming session ${session}` : "resuming the latest conversation in its folder (--continue)";
  return `resuming its last conversation (${plan.resume.join(" ")})`;
}

// ---- the sidebar's Restart: the CLI, as launch.js runCli runs it ----

/**
 * The CLI arguments the sidebar's Restart passes to launch.js runCli (which adds --json and
 * this app home): `agent`: Restart on… (a swap); `force`: past a working pane or its helpers;
 * `fresh`: a new conversation.
 */
export function restartArgs({ botId, projectKey, agent = null, force = false, fresh = false, machine = null }) {
  return ["restart", botId, "--project", projectKey, ...(machine ? ["--machine", machine] : []),
    ...(agent ? ["--agent", agent] : []), ...(force ? ["--force"] : []), ...(fresh ? ["--fresh"] : [])];
}

/**
 * What runCli's answer ({ code, out, err }) to restartArgs means: { terminal, replaced,
 * warnings } on success, else { refused, forceable, freshable } (the refusal is one --force
 * overrides, or one a new conversation, --fresh, avoids).
 */
export function restartAnswer(r) {
  if (r?.code === 0 && r.out?.terminal) {
    return { terminal: r.out.terminal, replaced: r.out.replaced ?? null, warnings: Array.isArray(r.out.warnings) ? r.out.warnings : [] };
  }
  if (r?.code === 0 && r.out?.running) return { refused: `It is already running in ${r.out.running}.`, forceable: false, freshable: false };
  // The CLI's refusal is its last stderr line (warnings come before it).
  const refused = String(r?.err ?? "").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? `Restart failed (exit ${r?.code ?? "?"}).`;
  return { refused, forceable: /pass --force/.test(refused), freshable: /--fresh\b/.test(refused) };
}
