#!/usr/bin/env node
// Reports, as one short line on stderr, the names of the env it was started with (and whether one
// control name is set), so a test can see what a probe passes to the adapter without a huge env dump.
// Only names and a set/missing flag are printed: never a value, so running this by hand can't leak a
// live key. The test compares the names against the real filter, so a name added there is covered too (BOS-396).
process.stdin.once("data", () => {
  const names = Object.keys(process.env).sort().join(",");
  const control = "ANTHROPIC_API_KEY" in process.env ? "set" : "missing";
  process.stderr.write(`envnames=${names};control=${control}\n`);
  process.exit(1);
});
