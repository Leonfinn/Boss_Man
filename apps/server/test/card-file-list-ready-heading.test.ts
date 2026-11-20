// BOS-2111 (background lane, tests only): two exported pure helpers that no test named.
// `fileList` is the file list on a card, cut at whole names with a count of the rest so a long
// list never looks complete. `readyHeading` is the heading of a deploy card carrying the owner's
// Priority 1 work: "Ready to put live: <symptom> (BOS-n)" plus "; also …" for the rest. No
// database and no clock: both are plain functions of their inputs.
import { describe, expect, it } from "vitest";
import { fileList } from "../src/services/card-check.js";
import { readyHeading } from "../src/services/decisions.js";

describe("fileList", () => {
  it("gives nothing for an empty list", () => {
    expect(fileList([], 10)).toBe("");
  });

  it("lists every name when they all fit", () => {
    expect(fileList(["a.ts", "b.ts"], 100)).toBe("a.ts, b.ts");
  });

  it("cuts at a whole name and counts the rest", () => {
    expect(fileList(["aa", "bbb", "cccc"], 5)).toBe("aa, …and 2 more");
  });

  it("counts every name when the first one alone is longer than max", () => {
    expect(fileList(["abcdefgh"], 3)).toBe("…and 1 more");
    expect(fileList(["abcdefgh", "i"], 3)).toBe("…and 2 more");
  });

  it("keeps a first name exactly as long as max", () => {
    expect(fileList(["abc"], 3)).toBe("abc");
  });

  it("keeps a list exactly as long as max whole", () => {
    expect(fileList(["ab", "cd"], 6)).toBe("ab, cd");
  });

  it("cuts the next whole name that would go one character over max", () => {
    expect(fileList(["ab", "cd"], 5)).toBe("ab, …and 1 more");
  });

  it("counts just the names it left out", () => {
    expect(fileList(["a", "b", "c", "d", "e"], 4)).toBe("a, b, …and 3 more");
  });
});

describe("readyHeading", () => {
  it("gives nothing for no items", () => {
    expect(readyHeading([])).toBe("");
  });

  it("heads a single item", () => {
    expect(readyHeading([{ symptom: "Server freezes", ref: "BOS-1" }])).toBe("Ready to put live: Server freezes (BOS-1)");
  });

  it("names the first item and adds the rest after 'also'", () => {
    expect(
      readyHeading([
        { symptom: "Server freezes", ref: "BOS-1" },
        { symptom: "Deploys stall", ref: "BOS-2" },
        { symptom: "Cards vanish", ref: "BOS-3" },
      ]),
    ).toBe("Ready to put live: Server freezes (BOS-1); also Deploys stall (BOS-2); Cards vanish (BOS-3)");
  });

  it("trims trailing full stops, bangs and spaces from every symptom", () => {
    expect(
      readyHeading([
        { symptom: "Server freezes!!!", ref: "BOS-1" },
        { symptom: "Deploys stall . ! ", ref: "BOS-2" },
      ]),
    ).toBe("Ready to put live: Server freezes (BOS-1); also Deploys stall (BOS-2)");
  });

  it("trims space around a symptom", () => {
    expect(readyHeading([{ symptom: "  Server freezes  ", ref: "BOS-9" }])).toBe("Ready to put live: Server freezes (BOS-9)");
  });

  it("leaves punctuation inside a symptom alone", () => {
    expect(readyHeading([{ symptom: "Settings > Server: freezes at 50%!", ref: "BOS-4" }])).toBe(
      "Ready to put live: Settings > Server: freezes at 50% (BOS-4)",
    );
  });
});
