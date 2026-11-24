import { describe, expect, it } from "vitest";
import { buttonLabels, fieldLabels } from "../src/services/guard-scan.js";

// BOS-2522 security review: the move to review runs these scanners on the server's event loop over up to 25 of an
// agent's branch .tsx files, each read up to 256 KB. The first version searched to the end of the file from every
// unclosed `<label>`: 64 KB of `<label>x` took 12.5 s and 2.4 GB, and 256 KB got the process killed. Each hostile text
// below is timed against a plain file of the same size made of ordinary closed buttons, run in turn on the same machine
// (best of a few runs each), not against a fixed number of ms, so a slow or busy machine (GitHub's runners) slows both
// sides together. A linear scan stays within a small multiple of the baseline; a quadratic one is hundreds of times
// slower at this size, far past the limit.
const SIZE = 256 * 1024;
const SLOWDOWN_LIMIT = 30;
const fill = (unit: string) => unit.repeat(Math.ceil(SIZE / unit.length)).slice(0, SIZE);
const scan = (src: string) => [...buttonLabels(src), ...fieldLabels(src)];

describe("guard-scan stays linear on hostile branch files", () => {
  const plain = fill('<button onClick={() => save("a")}>Save</button>\n');
  it.each([
    ["unclosed labels", fill("<label>x")],
    ["unclosed buttons", fill("<button>x")],
    ["opening tags with no >", fill("<button ")],
    ["unclosed strings in tags", fill('<button "')],
    ["unbalanced braces", fill("<label>{")],
    ["field components with no >", fill("<CheckPicker ")],
    ["one long expression of strings", `<button>{${fill("'a' ")}}</button>`],
    ["one long run of marks", `<button>A${fill("!")}</button>`],
  ])("%s", (_name, hostile) => {
    const time = (src: string) => {
      const t = performance.now();
      scan(src);
      return performance.now() - t;
    };
    let slow = Infinity;
    let baseline = Infinity;
    for (let i = 0; i < 3; i++) {
      slow = Math.min(slow, time(hostile));
      baseline = Math.min(baseline, time(plain));
    }
    // The floor keeps a timer-resolution baseline from inflating the ratio.
    expect(slow / Math.max(baseline, 1)).toBeLessThan(SLOWDOWN_LIMIT);
  });

  it("still reads real buttons and fields", () => {
    const src = `<label>Name <input /></label><button>{x ? "Stop" : "Start"} ✓</button><CheckPicker value={v} label="Checks" />`;
    expect(buttonLabels(src)).toEqual(["Stop", "Start"]);
    expect(fieldLabels(src)).toEqual(["Name", "Checks"]);
  });
});
