import { describe, expect, it } from "vitest";
import { endsInOpenFence, fenceLine } from "../src/services/wiki.js";

describe("fenceLine", () => {
  it("reads a backtick fence and its length", () => {
    expect(fenceLine("```")).toEqual({ char: "`", len: 3 });
  });

  it("reads a fence that carries a language", () => {
    expect(fenceLine("```ts")).toEqual({ char: "`", len: 3 });
  });

  it("reads a tilde fence and its length", () => {
    expect(fenceLine("~~~~")).toEqual({ char: "~", len: 4 });
  });

  it("allows up to 3 leading spaces", () => {
    expect(fenceLine("   ```")).toEqual({ char: "`", len: 3 });
  });

  it("does not treat 4 leading spaces as a fence", () => {
    expect(fenceLine("    ```")).toBeNull();
  });

  it("gives null for two marks, plain text, an empty line and a fence not at the start", () => {
    expect(fenceLine("``")).toBeNull();
    expect(fenceLine("plain text")).toBeNull();
    expect(fenceLine("")).toBeNull();
    expect(fenceLine("text ```")).toBeNull();
  });
});

describe("endsInOpenFence", () => {
  it("is false for no lines or no fences", () => {
    expect(endsInOpenFence([])).toBe(false);
    expect(endsInOpenFence(["just", "text"])).toBe(false);
  });

  it("is false when the block is closed and true when it is not", () => {
    expect(endsInOpenFence(["```", "code", "```"])).toBe(false);
    expect(endsInOpenFence(["```", "code"])).toBe(true);
  });

  it("keeps a ``` block open when only ~~~ follows, and the other way round", () => {
    expect(endsInOpenFence(["```", "code", "~~~"])).toBe(true);
    expect(endsInOpenFence(["~~~", "code", "```"])).toBe(true);
  });

  it("needs a closer at least as long as the opener", () => {
    expect(endsInOpenFence(["````", "code", "```"])).toBe(true);
    expect(endsInOpenFence(["````", "code", "`````"])).toBe(false);
  });

  it("handles several blocks in a row", () => {
    const two = ["```", "a", "```", "~~~", "b", "~~~"];
    expect(endsInOpenFence(two)).toBe(false);
    expect(endsInOpenFence([...two, "```"])).toBe(true);
  });

  it("does not open a second block for a ~~~ line inside an open ``` block", () => {
    expect(endsInOpenFence(["```", "~~~", "```"])).toBe(false);
  });
});
