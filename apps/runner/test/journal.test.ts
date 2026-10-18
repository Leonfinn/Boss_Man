import { appendFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Journal } from "../src/journal.js";

const log = (message: string) => ({ type: "runner.log" as const, level: "info" as const, message });
const tmpJournal = () => path.join(mkdtempSync(path.join(tmpdir(), "bm-journal-")), "journal.jsonl");

describe("Journal", () => {
  it("numbers events and keeps them until acknowledged", () => {
    const j = new Journal(tmpJournal());
    expect(j.append(log("a")).seq).toBe(1);
    expect(j.append(log("b")).seq).toBe(2);
    expect(j.append(log("c")).seq).toBe(3);
    j.ack(2);
    expect(j.pending().map((e) => e.seq)).toEqual([3]);
    expect(j.pending(1).map((e) => e.seq)).toEqual([3]);
  });

  it("survives a restart: sequence numbers continue and unacked entries remain", () => {
    const p = tmpJournal();
    const j1 = new Journal(p);
    j1.append(log("a"));
    j1.append(log("b"));
    j1.ack(1);
    const j2 = new Journal(p);
    expect(j2.lastSeq).toBe(2);
    expect(j2.pending().map((e) => e.seq)).toEqual([2]);
    expect(j2.append(log("c")).seq).toBe(3);
  });

  it("keeps numbering after everything is acked and compacted", () => {
    const p = tmpJournal();
    const j1 = new Journal(p);
    j1.append(log("a"));
    j1.ack(1);
    expect(readFileSync(p, "utf8")).toBe("");
    expect(new Journal(p).append(log("b")).seq).toBe(2);
  });

  it("ignores a torn last line left by a crash", () => {
    const p = tmpJournal();
    const j1 = new Journal(p);
    j1.append(log("a"));
    appendFileSync(p, '{"seq":2,"at":"2026-10');
    const j2 = new Journal(p);
    expect(j2.pending().map((e) => e.seq)).toEqual([1]);
    expect(j2.append(log("b")).seq).toBe(2);
  });

  it("renumbers a new journal's events after what the server already holds", () => {
    const file = tmpJournal();
    const j = new Journal(file);
    j.append(log("a"));
    j.append(log("b"));
    j.rebase(5000);
    expect(j.pending(5000).map((e) => [e.seq, (e.event as { message: string }).message])).toEqual([
      [5001, "a"],
      [5002, "b"],
    ]);
    expect(j.append(log("c")).seq).toBe(5003);
    // It survives a restart with the new numbers.
    const again = new Journal(file);
    expect(again.pending(5000).map((e) => e.seq)).toEqual([5001, 5002, 5003]);
    expect(again.append(log("d")).seq).toBe(5004);
    // A journal that's ahead of the server is left alone.
    again.rebase(10);
    expect(again.lastSeq).toBe(5004);
  });

  it("never acks past what it has written", () => {
    const j = new Journal(tmpJournal());
    j.append(log("a"));
    j.ack(10);
    expect(j.ackedUpTo).toBe(1);
  });
});
