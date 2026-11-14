#!/usr/bin/env node
// A stand-in ACP adapter for steering (BOS-1016). FAKE_STEER picks how it treats `_session/steering`:
// "none" doesn't advertise steering; "injected", "promptRequired" and "error" advertise it and answer so.
// The first turn ends 800 ms after it starts, so a message sent meanwhile either was steered or waits for it.
// Every session/prompt and steer it gets is appended to DUMP as one JSON line.
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const mode = process.env.FAKE_STEER ?? "none";
const log = (entry) => appendFileSync(process.env.DUMP, JSON.stringify(entry) + "\n");
const text = (params) => (params?.prompt ?? []).map((b) => b.text).join("");
let turns = 0;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") {
    send({ id: msg.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: {}, ...(mode === "none" ? {} : { _meta: { steering: { supported: true } } }) } });
  } else if (msg.method === "session/new") {
    send({ id: msg.id, result: { sessionId: "s1" } });
  } else if (msg.method === "session/prompt") {
    log({ method: msg.method, text: text(msg.params) });
    turns++;
    setTimeout(() => send({ id: msg.id, result: { stopReason: "end_turn" } }), turns === 1 ? 800 : 0);
  } else if (msg.method === "_session/steering") {
    log({ method: msg.method, text: text(msg.params), meta: msg.params?._meta ?? null });
    if (mode === "error") send({ id: msg.id, error: { code: -32603, message: "steer failed" } });
    else send({ id: msg.id, result: mode === "promptRequired" ? { outcome: "promptRequired", reason: "noRunningTurn" } : { outcome: "injected" } });
  } else if (msg.id !== undefined && msg.method) send({ id: msg.id, result: {} });
});
