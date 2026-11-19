#!/usr/bin/env node
// A stand-in ACP adapter for cost tests (BOS-1865): can reopen a session (loadSession), and each prompt reports one
// usage_update whose cumulative cost is COSTS (a comma list, in dollars), one figure per prompt, then ends the turn.
import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const costs = (process.env.COSTS ?? "").split(",").filter(Boolean).map(Number);
let sessionId = "s1";
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } } });
  else if (msg.method === "session/new") send({ id: msg.id, result: { sessionId: "s1", configOptions: [] } });
  else if (msg.method === "session/load") {
    sessionId = msg.params.sessionId;
    send({ id: msg.id, result: { configOptions: [] } });
  } else if (msg.method === "session/prompt") {
    const amount = costs.shift();
    if (amount !== undefined) send({ method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", used: 100, size: 1000, cost: { amount, currency: "USD" } } } });
    send({ id: msg.id, result: { stopReason: "end_turn" } });
  } else if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
