#!/usr/bin/env node
// An agent that dies on its first message the way opencode (a Bun binary) does when its data folder isn't writable.
process.stdin.once("data", () => {
  process.stderr.write("EACCES: permission denied, mkdir '/home/node/.local/share/opencode/repos'\n    path: \"/home/node/.local/share/opencode/repos\",\n syscall: \"mkdir\",\n   errno: -13,\n    code: \"EACCES\"\n\n\nBun v1.3.14 (Linux x64 baseline)\n");
  process.exit(1);
});
