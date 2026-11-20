// Guards BOS-1988: the move guide must not tell owners to check a hard-coded port.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const guide = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "docs", "21-move-to-new-host.md");

// Returns the fenced code blocks, and the text outside them as one more block per paragraph.
export function hardCodedPortBlocks(text) {
  const bad = [];
  const blocks = text.split(/\n\s*\n/);
  for (const b of blocks) {
    if (/:310[01]\/api\//.test(b) && !b.includes("BOSSMAN_HOST_PORT")) bad.push(b);
  }
  return bad;
}

test("flags a hard-coded port with no mention of BOSSMAN_HOST_PORT", () => {
  assert.equal(hardCodedPortBlocks("```sh\ncurl http://h:3100/api/ready\n```").length, 1);
  assert.equal(hardCodedPortBlocks("```sh\nPORT=$BOSSMAN_HOST_PORT; curl http://h:3100/api/ready\n```").length, 0);
});

test("the move guide's checks use the host's own port", () => {
  const text = readFileSync(guide, "utf8");
  assert.deepEqual(hardCodedPortBlocks(text), []);
  assert.match(text, /\$\{PORT:-3100\}\/api\/ready/);
});
