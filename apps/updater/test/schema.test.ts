import { describe, expect, test } from "vitest";
import { UpdaterError } from "../src/config.js";
import { compareVersions, parseInstruction, parseRelease } from "../src/schema.js";
import { FIXTURE_REGISTRY, fixture, sha } from "./helpers.js";

const refuse = (fn: () => unknown): UpdaterError => {
  try {
    fn();
  } catch (e) {
    return e as UpdaterError;
  }
  throw new Error("expected a refusal");
};

describe("the instruction", () => {
  const ok = { version: "0.1.0-beta.2", serverDigest: sha("a") };
  test("exactly version and serverDigest is accepted", () => expect(parseInstruction(ok)).toEqual(ok));
  test.each([
    ["extra field", { ...ok, image: "x" }],
    ["a registry field", { ...ok, registry: "evil.example" }],
    ["missing digest", { version: "0.1.0" }],
    ["version with a v", { ...ok, version: "v0.1.0" }],
    ["version with a path", { ...ok, version: "0.1.0/../x" }],
    ["short digest", { ...ok, serverDigest: "sha256:abc" }],
    ["upper-case digest", { ...ok, serverDigest: sha("A") }],
    ["wrong algorithm", { ...ok, serverDigest: `sha512:${"a".repeat(64)}` }],
    ["numbers", { version: 1, serverDigest: 2 }],
    ["an array", [ok]],
    ["null", null],
  ])("refuses %s", (_n, body) => expect(refuse(() => parseInstruction(body)).code).toBe("bad_request"));
});

describe("release numbers", () => {
  test("order", () => {
    expect(compareVersions("0.1.0-beta.1", "0.1.0-beta.2")).toBe(-1);
    expect(compareVersions("0.1.0-beta.2", "0.1.0-beta.10")).toBe(-1);
    expect(compareVersions("0.1.0-beta.9", "0.1.0")).toBe(-1);
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });
});

describe("release.json contents", () => {
  const image = (name: string, c: string) => ({ name, digest: sha(c), platforms: { "linux/amd64": sha("1"), "linux/arm64": sha("2") } });
  const all = ["boss-man-server", "boss-man-launcher", "boss-man-netguard", "boss-man-runner", "boss-man-updater"];
  const good = (over: Record<string, unknown> = {}) => ({ schema: 1, version: "0.2.0", commit: "a".repeat(40), registries: [FIXTURE_REGISTRY], images: all.map((n, i) => image(n, String(i))), packHash: "0123456789abcdef01234567", installLayout: 1, ...over });
  const parse = (j: unknown) => parseRelease(j, { version: "0.2.0", registry: FIXTURE_REGISTRY, arch: "arm64" });

  test("a full release parses, with the digest for this machine's architecture", () => {
    const r = parse(good());
    expect(r.missing).toEqual([]);
    expect(r.packHash).toBe("0123456789abcdef01234567");
    expect(r.installLayout).toBe(1);
    expect(r.images["boss-man-runner"]!.platformDigest).toBe(sha("2"));
  });

  test("the real beta.1 file (no packHash, no installLayout, no updater image) still parses; the caller decides", () => {
    const r = parseRelease(JSON.parse(fixture("release.json").toString("utf8")), { version: "0.1.0-beta.1", registry: FIXTURE_REGISTRY, arch: "arm64" });
    expect(r.packHash).toBeNull();
    expect(r.installLayout).toBeNull();
    expect(r.missing).toContain("boss-man-updater");
  });

  test.each([
    ["schema 2", good({ schema: 2 })],
    ["another version", good({ version: "0.2.1" })],
    ["a registry this install does not use", good({ registries: ["docker.io/other"] })],
    ["no images", good({ images: [] })],
    ["an unknown image", good({ images: [image("boss-man-evil", "9")] })],
    ["a short digest", good({ images: [{ ...image("boss-man-server", "1"), digest: "sha256:12" }] })],
    ["no image for this architecture", good({ images: [{ name: "boss-man-server", digest: sha("1"), platforms: { "linux/amd64": sha("1") } }] })],
    ["a duplicate image", good({ images: [image("boss-man-server", "1"), image("boss-man-server", "2")] })],
    ["a bad commit", good({ commit: "nope" })],
    ["a bad packHash", good({ packHash: "XYZ" })],
    ["a bad installLayout", good({ installLayout: 0 })],
  ])("refuses %s", (_n, json) => expect(refuse(() => parse(json)).code).toBe("bad_release"));
});
