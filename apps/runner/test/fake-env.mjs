#!/usr/bin/env node
// Prints the OpenCode settings it was started with, then exits, so a test can see what a probe passes.
process.stdin.once("data", () => {
  process.stderr.write(`config=${process.env.OPENCODE_CONFIG_CONTENT}\n`);
  process.exit(1);
});
