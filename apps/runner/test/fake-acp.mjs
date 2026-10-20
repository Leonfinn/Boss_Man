#!/usr/bin/env node
// A stand-in ACP adapter: answers initialize and session/new with a model option, and records nothing else.
import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: {} } });
  else if (msg.method === "session/new") {
    send({ id: msg.id, result: { sessionId: "s1", configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "sonnet", name: "Sonnet", description: "Fast" }] }] } });
  } else if (msg.method === "session/prompt") process.exit(3); // a probe must never prompt
  else if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
