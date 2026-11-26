// The swap's label readers (row 21): isSwap sends a move down the swap path only when the install defines it, and releaseOf /
// digestOf each read their own label and nothing else. Pure calls only, with made-up values.
import { describe, expect, test } from "vitest";
import type { ContainerInfo } from "../src/docker.js";
import type { MoveDeps } from "../src/move.js";
import { LABEL_DIGEST, LABEL_RELEASE } from "../src/spec.js";
import { digestOf, isSwap, releaseOf } from "../src/swap.js";

/** Only cfg.swap is read, so a minimal object cast to MoveDeps is enough. */
const depsWith = (swap: unknown): MoveDeps => ({ cfg: { swap } }) as unknown as MoveDeps;

const container = (labels: Record<string, string> | null): ContainerInfo => ({
  Id: "container-under-test",
  Config: { Labels: labels },
  State: {},
});

const RELEASE = "7.8.9-test";
const DIGEST = `sha256:${"0123456789abcdef".repeat(4)}`;
const OTHER = "0.0.0-other";

describe("isSwap", () => {
  test("true when the install defines the swap's settings", () => {
    expect(isSwap(depsWith({ frontNetwork: "test_front" }))).toBe(true);
  });

  test("false when it does not", () => {
    expect(isSwap(depsWith(null))).toBe(false);
  });
});

describe("releaseOf", () => {
  test("undefined container: null", () => {
    expect(releaseOf(undefined)).toBeNull();
  });

  test("a container with no labels: null", () => {
    expect(releaseOf(container(null))).toBeNull();
  });

  test("labels without the release key: null", () => {
    expect(releaseOf(container({ [LABEL_DIGEST]: DIGEST }))).toBeNull();
  });

  test("the release label's value", () => {
    expect(releaseOf(container({ [LABEL_RELEASE]: RELEASE }))).toBe(RELEASE);
  });
});

describe("digestOf", () => {
  test("undefined container: null", () => {
    expect(digestOf(undefined)).toBeNull();
  });

  test("a container with no labels: null", () => {
    expect(digestOf(container(null))).toBeNull();
  });

  test("labels without the digest key: null", () => {
    expect(digestOf(container({ [LABEL_RELEASE]: RELEASE }))).toBeNull();
  });

  test("the digest label's value", () => {
    expect(digestOf(container({ [LABEL_DIGEST]: DIGEST }))).toBe(DIGEST);
  });
});

describe("each function reads only its own label", () => {
  test("a container carrying both labels", () => {
    const both = container({ [LABEL_RELEASE]: RELEASE, [LABEL_DIGEST]: DIGEST });
    expect(releaseOf(both)).toBe(RELEASE);
    expect(digestOf(both)).toBe(DIGEST);
    expect(releaseOf(both)).not.toBe(DIGEST);
    expect(digestOf(both)).not.toBe(RELEASE);
  });

  test("a container whose only label is neither: both null", () => {
    const other = container({ "com.example.other": OTHER });
    expect(releaseOf(other)).toBeNull();
    expect(digestOf(other)).toBeNull();
  });
});
