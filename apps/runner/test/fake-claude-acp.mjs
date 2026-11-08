#!/usr/bin/env node
// A stand-in for the Claude ACP adapter (BOS-553): at session/new it records what it was sent, the MCP config file it was
// pointed at (its mode and the mode of its folder), and how many processes on the machine show the token from that file in their command line or environment.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const procHits = (token) => {
  let hits = 0;
  for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    for (const f of ["cmdline", "environ"]) {
      try {
        if (readFileSync(`/proc/${pid}/${f}`, "latin1").includes(token)) hits++;
      } catch {}
    }
  }
  return hits;
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: { mcpCapabilities: { http: true, sse: true } } } });
  else if (msg.method === "session/new") {
    const file = msg.params._meta?.claudeCode?.options?.extraArgs?.["mcp-config"];
    const dump = { params: msg.params, file: file ?? null, config: file ? readFileSync(file, "utf8") : null, fileMode: file ? statSync(file).mode & 0o777 : null, dirMode: file ? statSync(path.dirname(file)).mode & 0o777 : null, hits: file ? procHits(JSON.parse(readFileSync(file, "utf8")).mcpServers.bossman.headers.Authorization.slice(7)) : -1 };
    writeFileSync(process.env.DUMP, JSON.stringify(dump));
    send({ id: msg.id, result: { sessionId: "s1", configOptions: [] } });
  } else if (msg.method === "session/prompt") {
    // Is the token file still readable once the session is open and the run is going?
    const d = JSON.parse(readFileSync(process.env.DUMP, "utf8"));
    writeFileSync(process.env.DUMP, JSON.stringify({ ...d, fileDuringRun: d.file ? existsSync(d.file) : null }));
    send({ id: msg.id, result: { stopReason: "end_turn" } });
  } else if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
