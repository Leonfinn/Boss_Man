#!/usr/bin/env node
// Stand-in for the two `opencode` commands the session prune uses (BOS-616). Sessions live in
// $XDG_DATA_HOME/opencode/sessions.json as [{ id, time_updated }]; every call is logged to calls.log
// and its cwd and environment names to runs.log. The prune passes only the base environment, so
// the controls are in $XDG_DATA_HOME/opencode/fake.json: { "fail": "<id>" } makes deleting that
// session fail, { "listFail": true } makes listing fail.
// Like the real OpenCode, it runs any plugin under .opencode/plugin/ in its cwd or a folder above.
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

for (let at = process.cwd(); ; at = path.dirname(at)) {
  const plugins = path.join(at, ".opencode", "plugin");
  if (existsSync(plugins)) for (const p of readdirSync(plugins)) await import(path.join(plugins, p));
  if (path.dirname(at) === at) break;
}

const dir = path.join(process.env.XDG_DATA_HOME, "opencode");
const file = path.join(dir, "sessions.json");
const sessions = JSON.parse(readFileSync(file, "utf8"));
const control = existsSync(path.join(dir, "fake.json")) ? JSON.parse(readFileSync(path.join(dir, "fake.json"), "utf8")) : {};
const args = process.argv.slice(2);
appendFileSync(path.join(dir, "calls.log"), `${JSON.stringify(args)}\n`);
appendFileSync(path.join(dir, "runs.log"), `${JSON.stringify({ cwd: process.cwd(), env: Object.keys(process.env).sort() })}\n`);

if (args[0] === "db") {
  if (control.listFail) {
    process.stderr.write("database is locked\n");
    process.exit(1);
  }
  const m = args[1].match(/^select id from session where time_updated < (\d+) order by time_updated limit (\d+)$/);
  if (!m || args[2] !== "--format" || args[3] !== "json") {
    process.stderr.write(`unexpected query: ${args.join(" ")}\n`);
    process.exit(2);
  }
  const rows = sessions.filter((s) => s.time_updated < Number(m[1])).sort((a, b) => a.time_updated - b.time_updated).slice(0, Number(m[2]));
  process.stdout.write(JSON.stringify(rows.map((s) => ({ id: s.id })), null, 2));
} else if (args[0] === "session" && args[1] === "delete") {
  if (control.fail === args[2]) {
    process.stderr.write(`Session not found: ${args[2]}\n`);
    process.exit(1);
  }
  writeFileSync(file, JSON.stringify(sessions.filter((s) => s.id !== args[2])));
  process.stdout.write(`Session ${args[2]} deleted\n`);
} else {
  process.exit(3);
}
