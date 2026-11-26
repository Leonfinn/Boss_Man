// Tests for updater helpers that had no test: the colour names and layout check (spec.ts),
// the digest of a container reference and the previous release's helper digests (helpers.ts),
// and the empty state (state.ts). Pure calls only: no Docker, network or disk is touched.
import { describe, expect, test } from "vitest";
import { UpdaterError } from "../src/config.js";
import type { ContainerInfo } from "../src/docker.js";
import { digestOfRef, previousOf, type ReleaseCurrent } from "../src/helpers.js";
import { checkLayout, colourName, frontAlias, guardCheckSpec, LAYOUT, otherColour, type SwapReady } from "../src/spec.js";
import { emptyState } from "../src/state.js";

const hex = (c: string) => c.repeat(64);
const digest = (c: string) => `sha256:${hex(c)}`;
const DIGEST = digest("a");

const refuseLayout = (installLayout: number): UpdaterError => {
  try {
    checkLayout(installLayout);
  } catch (e) {
    return e as UpdaterError;
  }
  throw new Error("expected a refusal");
};

describe("otherColour", () => {
  test("blue gives green", () => expect(otherColour("blue")).toBe("green"));
  test("green gives blue", () => expect(otherColour("green")).toBe("blue"));
});

describe("colourName and frontAlias", () => {
  test("blue names and aliases", () => {
    expect(colourName("blue")).toBe("server-blue");
    expect(frontAlias("blue")).toBe("server-blue-front");
  });

  test("green names and aliases", () => {
    expect(colourName("green")).toBe("server-green");
    expect(frontAlias("green")).toBe("server-green-front");
  });
});

describe("checkLayout", () => {
  test("null returns without throwing", () => expect(() => checkLayout(null)).not.toThrow());
  test("the current LAYOUT returns without throwing", () => expect(() => checkLayout(LAYOUT)).not.toThrow());

  test("LAYOUT + 1 throws layout_newer", () => {
    const err = refuseLayout(LAYOUT + 1);
    expect(err).toBeInstanceOf(UpdaterError);
    expect(err.code).toBe("layout_newer");
  });
});

describe("guardCheckSpec", () => {
  const cfg = { installLabel: "com.example.install=demo", network: "demo-network" } as unknown as SwapReady;
  const image = `registry.example.com/boss-man-netguard@${DIGEST}`;

  test("runs the image once in print mode with the install's label and network", () => {
    const body = guardCheckSpec(cfg, image, "1.2.3");
    expect(body.Image).toBe(image);
    expect(body.Cmd).toEqual(["--print"]);
    expect(body.Labels["com.example.install"]).toBe("demo");
    expect(body.Labels["com.bossman.guardcheck"]).toBe("1.2.3");
    expect(body.HostConfig.NetworkMode).toBe("demo-network");
    expect(body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(body.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(body.HostConfig.Privileged).toBe(false);
  });

  test("a label with no = becomes a key with an empty value", () => {
    const noValue = { installLabel: "com.example.install", network: "demo-network" } as unknown as SwapReady;
    const body = guardCheckSpec(noValue, image, "1.2.3");
    expect(body.Labels["com.example.install"]).toBe("");
  });
});

describe("digestOfRef", () => {
  test("returns the digest part of a name@digest reference", () => {
    expect(digestOfRef(`registry.example.com/boss-man-runner@${DIGEST}`)).toBe(DIGEST);
  });

  test("returns null for undefined", () => expect(digestOfRef(undefined)).toBeNull());
  test("returns null for null", () => expect(digestOfRef(null)).toBeNull());

  test("returns null for a tag with no digest", () => {
    expect(digestOfRef("registry.example.com/boss-man-runner:0.1.0")).toBeNull();
  });

  test("returns null for a digest that is too short", () => {
    expect(digestOfRef(`registry.example.com/boss-man-runner@sha256:${"a".repeat(63)}`)).toBeNull();
  });

  test("returns null when more text follows the digest", () => {
    expect(digestOfRef(`registry.example.com/boss-man-runner@${DIGEST}-extra`)).toBeNull();
  });
});

describe("previousOf", () => {
  const info = (image?: string, env?: string[]): ContainerInfo => ({ Id: "made-up", Config: { Labels: {}, Image: image, Env: env }, State: {} });

  const file: ReleaseCurrent = {
    version: "1.2.3",
    runner: `registry.example.com/boss-man-runner@${digest("b")}`,
    netguard: `registry.example.com/boss-man-netguard@${digest("c")}`,
    at: "2026-11-26T00:00:00Z",
  };
  const env = [`BOSSMAN_RUNNER_IMAGE=registry.example.com/boss-man-runner@${digest("d")}`, `BOSSMAN_NETGUARD_IMAGE=registry.example.com/boss-man-netguard@${digest("e")}`];

  test("reads the launcher digest from the old launcher's image", () => {
    const prev = previousOf(info(`registry.example.com/boss-man-launcher@${DIGEST}`), null);
    expect(prev.launcher).toBe(DIGEST);
  });

  test("reads the runner and netguard digests from the release file when it is given", () => {
    const prev = previousOf(info(undefined, env), file);
    expect(prev.runner).toBe(digest("b"));
    expect(prev.netguard).toBe(digest("c"));
  });

  test("falls back to the launcher's environment when there is no file", () => {
    const prev = previousOf(info(undefined, env), null);
    expect(prev.runner).toBe(digest("d"));
    expect(prev.netguard).toBe(digest("e"));
  });

  test("the release file wins over the launcher's environment", () => {
    const prev = previousOf(info(undefined, env), file);
    expect(prev.runner).toBe(digest("b"));
    expect(prev.netguard).toBe(digest("c"));
  });

  test("all null when there is neither an old launcher nor a file", () => {
    expect(previousOf(null, null)).toEqual({ launcher: null, runner: null, netguard: null });
  });
});

describe("emptyState", () => {
  test("is idle at the given time with no helpers", () => {
    const state = emptyState("2026-11-26T00:00:00Z");
    expect(state.stage).toBe("idle");
    expect(state.updatedAt).toBe("2026-11-26T00:00:00Z");
    expect(state.helpers.status).toBe("none");
  });

  test("two calls give separate objects", () => {
    const first = emptyState("2026-11-26T00:00:00Z");
    const second = emptyState("2026-11-26T00:00:00Z");
    expect(first).not.toBe(second);
    expect(first.helpers).not.toBe(second.helpers);
    first.stage = "done";
    first.helpers.status = "moved";
    expect(second.stage).toBe("idle");
    expect(second.helpers.status).toBe("none");
  });
});
