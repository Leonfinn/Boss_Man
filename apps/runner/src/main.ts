// Runner daemon entry point. Phase 2a: connects and keeps its journal flowing; the ACP
// session manager that acts on commands arrives in Phase 2b.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { Journal } from "./journal.js";
import { RunnerConnection } from "./connection.js";

const env = process.env;
const url = env.BOSSMAN_URL ?? "ws://boss-man-server:3100/api/runner/connect";
const token = env.BOSSMAN_RUNNER_TOKEN;
if (!token) throw new Error("Set BOSSMAN_RUNNER_TOKEN (issued by POST /api/companies/:id/runner).");

const dataDir = env.BOSSMAN_RUNNER_DATA ?? "/home/node/runner-data";
mkdirSync(dataDir, { recursive: true });
const journal = new Journal(path.join(dataDir, "journal.jsonl"));

const connection = new RunnerConnection({
  url,
  token,
  journal,
  runnerVersion: "0.0.0",
  imageVersion: env.BOSSMAN_IMAGE_VERSION ?? null,
  log: (m) => console.log(`[runner] ${m}`),
  onCommand: (command) => {
    console.log(`[runner] command ${command.type} received; the session manager arrives in Phase 2b`);
  },
});

connection.start();
const stop = () => {
  connection.stop();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
