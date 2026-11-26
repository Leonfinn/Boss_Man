// Small pure helpers: the host architecture, an image reference and the digest of an inspected container.
// No Docker, network or disk is touched: these are plain calls.
import { describe, expect, test } from "vitest";
import { hostArch, UpdaterError } from "../src/config.js";
import type { ContainerInfo } from "../src/docker.js";
import { imageRef } from "../src/pull.js";
import { digestOfInfo } from "../src/selfupdate.js";

const HEX = "a".repeat(64);
const DIGEST = `sha256:${HEX}`;

const refuseArch = (nodeArch: string): UpdaterError => {
  try {
    hostArch(nodeArch);
  } catch (e) {
    return e as UpdaterError;
  }
  throw new Error("expected a refusal");
};

const info = (image?: string): ContainerInfo => ({ Id: "made-up", Config: { Labels: {}, Image: image }, State: {} });

describe("hostArch", () => {
  test("x64 is published as amd64", () => expect(hostArch("x64")).toBe("amd64"));
  test("arm64 is published as arm64", () => expect(hostArch("arm64")).toBe("arm64"));

  test.each([["ia32"], [""]])("refuses %j as unsupported_arch and names the value", (nodeArch) => {
    const err = refuseArch(nodeArch);
    expect(err).toBeInstanceOf(UpdaterError);
    expect(err.code).toBe("unsupported_arch");
    expect(err.message).toContain(`(${nodeArch})`);
  });
});

describe("imageRef", () => {
  test("joins the registry, name and digest", () => {
    expect(imageRef("registry.example.com", "boss-man-server", DIGEST)).toBe(`registry.example.com/boss-man-server@${DIGEST}`);
  });
});

describe("digestOfInfo", () => {
  test("returns the digest of an image referenced by digest", () => {
    expect(digestOfInfo(info(`registry.example.com/boss-man-updater@${DIGEST}`))).toBe(DIGEST);
  });

  test("returns null when there is no container info", () => expect(digestOfInfo(null)).toBeNull());

  test("returns null for an image with a tag and no digest", () => {
    expect(digestOfInfo(info("registry.example.com/boss-man-updater:0.1.0"))).toBeNull();
  });

  test("returns null for a digest that is too short", () => {
    expect(digestOfInfo(info(`registry.example.com/boss-man-updater@sha256:${"a".repeat(63)}`))).toBeNull();
  });

  test("returns null when more text follows the digest", () => {
    expect(digestOfInfo(info(`registry.example.com/boss-man-updater@${DIGEST}-extra`))).toBeNull();
  });
});
