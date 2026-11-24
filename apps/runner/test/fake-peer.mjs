#!/usr/bin/env node
// A stand-in ACP adapter for the cross-run test (BOS-555). Two roles, chosen by PEER_ROLE:
// - holder: keeps a stand-in secret in its temp folder, records where the runner put its MCP config file, and holds
//   session/new open (so that file still exists) until the test writes "release" in its working folder;
// - prober: tries to reach the holder's temp folder, MCP config file and agent home through the file system, and
//   scans every process's command line for the holder's token. It writes what worked to probe.json.
// It only opens files and lists folders: no other process's memory is read.
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const env = process.env;
const cwd = process.cwd();
// The test starts polling the moment a file exists, so a plain write would let it read one that is created but still
// empty or half-written on a slow CPU (the check-worker flake). A temp file renamed into place appears complete.
const writeAtomic = (file, text) => {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
};
const attempt = (fn) => {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
};

if (env.PEER_ROLE === "holder") {
  writeFileSync(path.join(env.TMPDIR, "secret.txt"), env.PEER_SECRET);
}

if (env.PEER_ROLE === "prober") {
  // Command lines are readable to every process of the user (no hidepid without namespaces): the test is that no
  // secret is ever on one (BOS-553), so a run that reads them all still finds nothing.
  let cmdlineHits = 0;
  for (const pid of readdirSync("/proc").filter((n) => /^\d+$/.test(n))) {
    try {
      const text = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (text.includes(env.PEER_TOKEN) || text.includes(env.PEER_SECRET)) cmdlineHits++;
    } catch {
      /* the process ended */
    }
  }
  const probe = {
    listedPeerTmp: attempt(() => readdirSync(env.PEER_TMP)),
    readPeerSecret: attempt(() => readFileSync(path.join(env.PEER_TMP, "secret.txt"))),
    readPeerMcp: attempt(() => readFileSync(env.PEER_MCP)),
    wrotePeerTmp: attempt(() => writeFileSync(path.join(env.PEER_TMP, "planted.txt"), "planted")),
    readPeerHome: attempt(() => readdirSync(env.PEER_HOME)),
    peerMcpExisted: env.PEER_MCP_EXISTS === "1",
    cmdlineHits,
    tmp: env.TMPDIR ?? null,
  };
  writeAtomic(path.join(cwd, "probe.json"), JSON.stringify(probe));
}

const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const holdUntilReleased = (done) => {
  const tick = () => (existsSync(path.join(cwd, "release")) ? done() : setTimeout(tick, 50));
  tick();
};
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.method === "initialize") send({ id: msg.id, result: { protocolVersion: 1, authMethods: [], agentCapabilities: {} } });
  else if (msg.method === "session/new") {
    const file = msg.params?._meta?.claudeCode?.options?.extraArgs?.["mcp-config"] ?? null;
    if (env.PEER_ROLE === "holder") {
      writeAtomic(path.join(cwd, "holder.json"), JSON.stringify({ tmp: env.TMPDIR, mcpConfig: file, mcpConfigExists: !!file && existsSync(file) }));
      holdUntilReleased(() => send({ id: msg.id, result: { sessionId: "s1" } }));
    } else send({ id: msg.id, result: { sessionId: "s1" } });
  } else if (msg.method === "session/prompt") send({ id: msg.id, result: { stopReason: "end_turn" } });
  else if (msg.id !== undefined) send({ id: msg.id, result: {} });
});
