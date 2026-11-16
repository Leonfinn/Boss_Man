// The owner's private-details list as the merge-line scan reads it (BOS-979, BOS-1093, BOS-1614).
// A list that can't be read must not stop the line: the scan runs its secret rules only, and the
// owner hears once per failure streak, never the values or the reason. An empty or unset list is
// silent. Nothing here touches a DB or the network: the reader only takes injected functions.
import { describe, expect, it } from "vitest";
import { scanListReader, type ScanListWarning } from "../src/services/scan-list.js";

type NotifyInput = Parameters<NonNullable<ScanListWarning["notify"]>>[0];

function setup(
  o: {
    list?: string | null;
    read?: () => Promise<string | null>;
    isSet?: () => Promise<boolean>;
    notify?: (n: NotifyInput) => Promise<unknown>;
  } = {},
) {
  const logs: string[] = [];
  const notes: NotifyInput[] = [];
  const reader = scanListReader({
    read: o.read ?? (async () => o.list ?? null),
    ...(o.isSet ? { isSet: o.isSet } : {}),
    log: (msg) => logs.push(msg),
    notify: o.notify ?? (async (n) => notes.push(n)),
  });
  return { reader, logs, notes };
}

describe("scanListReader", () => {
  it("hands the runner the list as it was saved, without a word", async () => {
    const { reader, logs, notes } = setup({ list: "192.168.1.50\nwiki.example.com" });

    await expect(reader.forScan()).resolves.toBe("192.168.1.50\nwiki.example.com");
    expect(logs).toEqual([]);
    expect(notes).toEqual([]);
  });

  it("stays silent when the list is empty or unset", async () => {
    for (const list of [null, ""]) {
      const { reader, logs, notes } = setup({ list });

      expect(await reader.forScan()).toBeFalsy();
      expect(logs).toEqual([]);
      expect(notes).toEqual([]);
    }
  });

  it("reads a failing list as no list, so the scan runs its secret rules only", async () => {
    const { reader, logs, notes } = setup({
      read: async () => {
        throw new Error("master key mismatch");
      },
    });

    await expect(reader.forScan()).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  it("logs the reason but never puts it (or the values) in the owner's notification", async () => {
    const { reader, logs, notes } = setup({
      read: async () => {
        throw new Error("master key mismatch");
      },
    });

    await reader.forScan();

    expect(logs[0]).toContain("could not be read");
    expect(logs[0]).toContain("master key mismatch");
    expect(notes[0]).toMatchObject({ level: "note", title: "The private-details list couldn't be read", link: "#/settings" });
    expect(notes[0]?.body).toContain("Private details");
    expect(notes[0]?.body).not.toContain("master key mismatch");
    expect(notes[0]?.body).not.toContain("192.168.1.50");
  });

  it("says unknown error when the failure carries no message", async () => {
    const { reader, logs } = setup({
      read: async () => {
        throw "boom";
      },
    });

    await reader.forScan();

    expect(logs[0]).toContain("unknown error");
  });

  it("warns once per failure streak, not once per merge", async () => {
    const { reader, logs, notes } = setup({
      read: async () => {
        throw new Error("master key mismatch");
      },
    });

    await reader.forScan();
    await reader.forScan();
    await reader.forScan();

    expect(logs).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  it("says so once when the list can be read again, and warns again if it breaks anew", async () => {
    let fail = true;
    const { reader, logs, notes } = setup({
      read: async () => {
        if (fail) throw new Error("master key mismatch");
        return "192.168.1.50";
      },
    });

    await reader.forScan();
    fail = false;
    await expect(reader.forScan()).resolves.toBe("192.168.1.50");
    await expect(reader.forScan()).resolves.toBe("192.168.1.50");
    fail = true;
    await reader.forScan();

    expect(logs).toHaveLength(3);
    expect(logs[1]).toContain("can be read again");
    expect(notes).toHaveLength(2);
  });

  it("logs a failure but does not tell the owner when no list was ever saved", async () => {
    const { reader, logs, notes } = setup({
      read: async () => {
        throw new Error("master key mismatch");
      },
      isSet: async () => false,
    });

    await expect(reader.forScan()).resolves.toBeUndefined();
    expect(logs).toHaveLength(1);
    expect(notes).toEqual([]);
  });

  it("treats an unreadable isSet as set, so the owner is told", async () => {
    const { reader, notes } = setup({
      read: async () => {
        throw new Error("master key mismatch");
      },
      isSet: async () => {
        throw new Error("db is down");
      },
    });

    await reader.forScan();

    expect(notes).toHaveLength(1);
  });

  it("keeps scanning when the notification itself fails, and does not retry it in the same streak", async () => {
    const attempts: NotifyInput[] = [];
    const { reader, logs } = setup({
      read: async () => {
        throw new Error("master key mismatch");
      },
      notify: async (n) => {
        attempts.push(n);
        throw new Error("ntfy is down");
      },
    });

    await expect(reader.forScan()).resolves.toBeUndefined();
    await expect(reader.forScan()).resolves.toBeUndefined();

    expect(attempts).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  it("works with no logger and no notifier wired in", async () => {
    const reader = scanListReader({
      read: async () => {
        throw new Error("master key mismatch");
      },
    });

    await expect(reader.forScan()).resolves.toBeUndefined();
  });
});
