// BOS-1315: the host-token fill in a ticket's owner setup steps (DR-052). What a reported value fills, which values
// are unusable, what a missing fact turns into, tokens inside inline code, unknown keys and names that exist on every
// JS object. Every path here is a made-up example: real ones only ever come from the host deployer's report.
import { describe, expect, it } from "vitest";
import { HOST_FACT_LABELS, fillOwnerSetup } from "../src/services/owner-setup-check.js";

const POINTER = "Settings → Server and runner → This server";
const label = (key: string) => `${HOST_FACT_LABELS[key]} (${POINTER} shows it)`;

describe("fillOwnerSetup: a value the host reported", () => {
  it("fills a known value and leaves generic false", () => {
    const out = fillOwnerSetup(["Open {{host.paths.src}}"], { "paths.src": "/opt/example/src" });
    expect(out).toEqual({ steps: ["Open /opt/example/src"], generic: false });
  });

  it("treats spacing inside the braces the same", () => {
    const out = fillOwnerSetup(["Open {{ host.paths.src }}"], { "paths.src": "/opt/example/src" });
    expect(out).toEqual({ steps: ["Open /opt/example/src"], generic: false });
  });

  it("fills two tokens in one step", () => {
    const out = fillOwnerSetup(["Copy from {{host.paths.src}} to {{host.env.file}}"], { "paths.src": "/opt/example/src", "env.file": "/opt/example/src/.env" });
    expect(out).toEqual({ steps: ["Copy from /opt/example/src to /opt/example/src/.env"], generic: false });
  });

  it("fills the step whose fact it has, and generic follows the step with the missing fact", () => {
    const out = fillOwnerSetup(["Open {{host.paths.src}}", "Open {{host.env.file}}"], { "paths.src": "/opt/example/src" });
    expect(out.steps).toEqual(["Open /opt/example/src", `Open ${label("env.file")}`]);
    expect(out.generic).toBe(true);
  });
});

describe("fillOwnerSetup: a value that would break the step", () => {
  it.each([
    ["a newline", "/opt/example\nsrc"],
    ["a carriage return", "/opt/example\rsrc"],
    ["a backtick", "/opt/example/src`"],
  ])("does not use %s in the words: the label appears and generic is true", (_name, value) => {
    const out = fillOwnerSetup(["Open {{host.paths.src}}"], { "paths.src": value });
    expect(out).toEqual({ steps: [`Open ${label("paths.src")}`], generic: true });
  });

  it.each([
    ["a newline", "/opt/example\nsrc"],
    ["a backtick", "/opt/example/src`"],
  ])("keeps the token inside inline code as written when the value has %s, and generic stays false", (_name, value) => {
    const out = fillOwnerSetup(["Run `cd {{host.paths.src}}`"], { "paths.src": value });
    expect(out).toEqual({ steps: ["Run `cd {{host.paths.src}}`"], generic: false });
  });
});

describe("fillOwnerSetup: a blank value counts as missing", () => {
  it.each([
    ["empty", ""],
    ["spaces", "   "],
    ["a tab", "\t"],
    ["a newline", "\n"],
  ])("%s (%j) becomes the label and generic is true", (_name, value) => {
    const out = fillOwnerSetup(["Open {{host.paths.src}}"], { "paths.src": value });
    expect(out).toEqual({ steps: [`Open ${label("paths.src")}`], generic: true });
  });
});

describe("fillOwnerSetup: tokens it cannot fill", () => {
  it("keeps a known key with no value inside inline code, and generic stays false", () => {
    const out = fillOwnerSetup(["Set it up: `cd {{host.paths.src}}`"], {});
    expect(out).toEqual({ steps: ["Set it up: `cd {{host.paths.src}}`"], generic: false });
  });

  it("keeps an unknown key, and generic stays false", () => {
    const out = fillOwnerSetup(["Open {{host.paths.nowhere}}"], {});
    expect(out).toEqual({ steps: ["Open {{host.paths.nowhere}}"], generic: false });
  });

  it.each([["constructor"], ["toString"], ["__proto__"]])("keeps {{host.%s}} with an empty values object and prints nothing from the object prototype", (key) => {
    const step = `Open {{host.${key}}}`;
    const out = fillOwnerSetup([step], {});
    expect(out.steps).toEqual([step]);
    expect(out.generic).toBe(false);
  });
});
