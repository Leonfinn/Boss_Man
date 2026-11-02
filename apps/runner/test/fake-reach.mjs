#!/usr/bin/env node
// A stand-in ACP adapter that first tries to reach outside its fence (BOS-321) and writes what
// worked to reach.json in its working folder, then answers a session and one prompt.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const attempt = (fn) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};
const env = process.env;
const reach = {
  wroteInside: attempt(() => writeFileSync(path.join(process.cwd(), "inside.txt"), "ok")),
  wroteTmp: attempt(() => writeFileSync(path.join(env.TMPDIR ?? "/tmp", "scratch.txt"), "ok")),
  wroteOutside: attempt(() => writeFileSync(env.REACH_OUTSIDE, "changed")),
  readSecret: attempt(() => readFileSync(env.REACH_SECRET)),
  readSharedClaude: attempt(() => readFileSync(env.REACH_SHARED_CLAUDE)),
  // check-all.sh's shared state: the queue must be writable to take part; the results and pair proof must not be.
  wroteQueue: attempt(() => writeFileSync(path.join(path.dirname(env.CHECK_ALL_LOCK), "probe"), "")),
  wroteStore: attempt(() => writeFileSync(path.join(env.BOSSMAN_CHECK_STORE, "forged.json"), '{"status":"pass"}')),
  wroteProof: attempt(() => writeFileSync(env.CHECK_ALL_PAIR_PROOF, "forged")),
  env: Object.fromEntries(["HOME", "TMPDIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "XDG_CACHE_HOME", "npm_config_store_dir", "CHECK_ALL_LOCK", "BOSSMAN_CHECK_STORE", "CHECK_ALL_PAIR_PROOF", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0"].map((k) => [k, env[k] ?? null])),
};
writeFileSync(path.join(process.cwd(), "reach.json"), JSON.stringify(reach));

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: {} } });
  else if (msg.method === "session/new") send({ id: msg.id, result: { sessionId: "s1" } });
  else if (msg.method === "session/prompt") send({ id: msg.id, result: { stopReason: "end_turn" } });
  else if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
