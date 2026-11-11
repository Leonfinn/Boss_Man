#!/usr/bin/env node
// A stand-in ACP adapter: answers initialize and session/new with a model option, and records nothing else.
// With FAKE_PERMISSION_OPTIONS (a JSON list of permission options) a prompt asks for one permission with
// those options, writes the answer it got to DUMP and ends the turn; without it a prompt is an error.
import { writeFileSync } from "node:fs";
import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
let promptId;
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: {} } });
  else if (msg.method === "session/new") {
    send({ id: msg.id, result: { sessionId: "s1", configOptions: [{ id: "model", name: "Model", category: "model", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }, { value: "sonnet", name: "Sonnet", description: "Fast" }] }] } });
  } else if (msg.method === "session/prompt") {
    if (!process.env.FAKE_PERMISSION_OPTIONS) process.exit(3); // a probe must never prompt
    promptId = msg.id;
    const options = JSON.parse(process.env.FAKE_PERMISSION_OPTIONS);
    send({ id: "perm-1", method: "session/request_permission", params: { sessionId: "s1", toolCall: { toolCallId: "tc-1", title: "touch /tmp/x", kind: "execute", rawInput: { command: "touch /tmp/x" } }, options } });
  } else if (msg.id === "perm-1" && !msg.method) {
    writeFileSync(process.env.DUMP, JSON.stringify(msg.result ?? msg.error));
    send({ id: promptId, result: { stopReason: "end_turn" } });
  } else if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
