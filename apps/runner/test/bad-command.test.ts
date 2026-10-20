// A run start the runner can't read must end the run, not leave it "starting" forever.
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { Journal } from "../src/journal.js";
import { RunnerConnection } from "../src/connection.js";

describe("an unreadable run start", () => {
  it("is reported as ended with the reason", async () => {
    const wss = new WebSocketServer({ port: 0 });
    const port = (wss.address() as { port: number }).port;
    const runId = randomUUID();
    wss.on("connection", (ws) => ws.send(JSON.stringify({ type: "command", id: "c1", command: { type: "run.start", runId, bogus: true } })));
    const journal = new Journal(path.join(mkdtempSync(path.join(tmpdir(), "bm-bad-")), "j.jsonl"));
    const logs: string[] = [];
    const conn = new RunnerConnection({ url: `ws://127.0.0.1:${port}`, token: "t", journal, runnerVersion: "test", onCommand: () => {}, log: (m) => logs.push(m) });
    conn.start();
    for (let i = 0; i < 100 && !journal.pending().length; i++) await new Promise((r) => setTimeout(r, 20));
    conn.stop();
    wss.close();
    const ended = journal.pending().map((e) => e.event).find((e) => e.type === "run.ended");
    expect(ended).toMatchObject({ type: "run.ended", runId, stopReason: null });
    expect((ended as { error: string }).error).toMatch(/couldn't read the run's start command/);
    expect(logs.join("\n")).toMatch(/ignored a malformed server message: /);
  });
});
