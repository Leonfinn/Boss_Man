#!/usr/bin/env node
// An agent that dies on its first message, like opencode when its data folder isn't writable.
process.stdin.once("data", () => {
  process.stderr.write("EACCES: permission denied, mkdir '/home/node/.local/share/opencode/repos'\n");
  process.exit(1);
});
