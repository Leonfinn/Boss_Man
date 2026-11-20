// BOS-2099: every third-party image in the compose files is pinned to an exact digest (or a ${VAR} the owner sets),
// so an upstream update can't change a stack with no change in the repo.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** Images allowed without a digest, each with the reason. Keep this short: a new entry needs a real reason. */
const ALLOWED: { image: RegExp; reason: string }[] = [
  { image: /^boss-man-[a-z-]+:[a-z]+$/, reason: "built from this repo on the host, so there is no registry digest" },
  { image: /^caddy:\d+\.\d+\.\d+$/, reason: "exact version tag in the blue/green overlay; a digest is a follow-up" },
  { image: /^pgvector\/pgvector:[\w.-]+$/, reason: "exact version tag for the main database; a digest is a follow-up" },
];

const files = [
  "docker-compose.yml",
  ...readdirSync(join(ROOT, "deploy")).filter((f) => f.endsWith(".yml")).map((f) => `deploy/${f}`),
];

function images(): { file: string; line: number; image: string }[] {
  const out: { file: string; line: number; image: string }[] = [];
  for (const file of files) {
    readFileSync(join(ROOT, file), "utf8").split("\n").forEach((text, i) => {
      const m = /^\s*image:\s*(\S+)/.exec(text);
      if (m) out.push({ file, line: i + 1, image: m[1]! });
    });
  }
  return out;
}

describe("compose image pins", () => {
  it("finds the compose files and some images", () => {
    expect(images().length).toBeGreaterThan(10);
  });
  it("every image uses a variable, carries @sha256:, or is on the short allow-list", () => {
    const loose = images().filter(
      ({ image }) => !image.includes("${") && !/@sha256:[0-9a-f]{64}$/.test(image) && !ALLOWED.some((a) => a.image.test(image)),
    );
    expect(loose.map((l) => `${l.file}:${l.line} ${l.image}`)).toEqual([]);
  });
  it("the Penpot mail, cache and database images are pinned to an exact version and digest", () => {
    const penpot = images().filter((i) => i.file === "deploy/penpot.yml" && /postgres|valkey|mailpit/.test(i.image));
    expect(penpot).toHaveLength(3);
    for (const { image } of penpot) expect(image).toMatch(/:v?\d+\.\d+(\.\d+)?@sha256:[0-9a-f]{64}$/);
  });
});
