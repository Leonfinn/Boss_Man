// The runner's durable outbox (R31). Every event is appended (and fsynced) before it is
// sent, and stays until the server acknowledges it, so a dropped connection or a server
// restart loses nothing. Acked entries are compacted away.
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { JournalEntry, type RunnerEvent } from "@boss-man/shared";

type State = { lastSeq: number; ackedUpTo: number };

export class Journal {
  private entries: JournalEntry[] = [];
  private state: State = { lastSeq: 0, ackedUpTo: 0 };
  private readonly statePath: string;

  constructor(
    private readonly path: string,
    private readonly compactEvery = 500,
  ) {
    this.statePath = `${path}.state.json`;
    if (existsSync(this.statePath)) this.state = JSON.parse(readFileSync(this.statePath, "utf8")) as State;
    if (existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JournalEntry.parse(JSON.parse(line));
          this.entries.push(e);
          if (e.seq > this.state.lastSeq) this.state.lastSeq = e.seq;
        } catch {
          // A torn final line from a crash mid-write: everything before it is intact.
        }
      }
    }
    this.entries = this.entries.filter((e) => e.seq > this.state.ackedUpTo);
  }

  get lastSeq() {
    return this.state.lastSeq;
  }

  get ackedUpTo() {
    return this.state.ackedUpTo;
  }

  append(event: RunnerEvent, at = new Date()): JournalEntry {
    const entry: JournalEntry = { seq: this.state.lastSeq + 1, at: at.toISOString(), event };
    const fd = openSync(this.path, "a");
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.state.lastSeq = entry.seq;
    this.entries.push(entry);
    this.saveState();
    return entry;
  }

  /** Entries the server hasn't stored yet. */
  pending(afterSeq = this.state.ackedUpTo): JournalEntry[] {
    return this.entries.filter((e) => e.seq > afterSeq);
  }

  ack(upTo: number) {
    if (upTo <= this.state.ackedUpTo) return;
    this.state.ackedUpTo = Math.min(upTo, this.state.lastSeq);
    const before = this.entries.length;
    this.entries = this.entries.filter((e) => e.seq > this.state.ackedUpTo);
    this.saveState();
    if (before - this.entries.length > 0 && (this.entries.length === 0 || before >= this.compactEvery)) this.compact();
  }

  private saveState() {
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.statePath);
  }

  /** Rewrites the journal with only unacked entries. */
  private compact() {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, this.entries.map((e) => `${JSON.stringify(e)}\n`).join(""));
    renameSync(tmp, this.path);
  }
}
