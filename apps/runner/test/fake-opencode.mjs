#!/usr/bin/env node
// A stand-in for `opencode acp`: records its argv, the config it was given and the model it was told to use.
import { writeFileSync } from "node:fs";
import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const dump = { argv: process.argv.slice(2), config: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "null"), autoupdateOff: process.env.OPENCODE_DISABLE_AUTOUPDATE, browserArgs: process.env.AGENT_BROWSER_ARGS ?? null, runnerOnly: process.env.SOME_RUNNER_ONLY_SETTING ?? null, model: null, effort: null, mcpServers: null };
// Like OpenCode, the effort option lists the current model's variants.
const options = [
  { id: "model", name: "Model", category: "model", currentValue: "a/one", options: [{ value: "a/one", name: "One" }, { value: "b/two", name: "Two" }, ...(process.env.FAKE_MODELS ? JSON.parse(process.env.FAKE_MODELS).map((v) => ({ value: v, name: v })) : [])] },
  { id: "effort", name: "Effort", category: "thought_level", type: "select", currentValue: "medium", options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }] },
];
const save = () => writeFileSync(process.env.DUMP, JSON.stringify(dump));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, authMethods: [{ id: "opencode-login" }], agentCapabilities: { mcpCapabilities: JSON.parse(process.env.MCP_CAPS ?? "{}") } } });
  else if (msg.method === "session/new") (dump.mcpServers = msg.params.mcpServers), send({ id: msg.id, result: { sessionId: "s1", configOptions: options } });
  else if (msg.method === "session/set_config_option") (dump[msg.params.configId === "effort" ? "effort" : "model"] = msg.params.value), save(), send({ id: msg.id, result: { configOptions: options } });
  else if (msg.method === "session/prompt") save(), send({ id: msg.id, result: { stopReason: "end_turn" } });
  else if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
