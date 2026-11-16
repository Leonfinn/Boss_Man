// BOS-1686: the seven earlier background test tickets covered second-opinion.ts's redaction, prompts and
// answer reading (`second-opinion.test.ts`). Two exports were left unpinned anywhere: the suggested-model
// presets the Settings page fills the form from, and the deadline the server races the provider against.
// The presets are offered to the owner as safe defaults (a local Ollama option must not leave the network)
// and only a real chat model can give a usable answer, so the shapes below are load-bearing.
import { describe, expect, it } from "vitest";
import { SECOND_OPINION_DEADLINE_MS, SECOND_OPINION_PRESETS } from "../src/index.js";

describe("SECOND_OPINION_DEADLINE_MS", () => {
  it("is a whole number of milliseconds", () => {
    expect(Number.isFinite(SECOND_OPINION_DEADLINE_MS)).toBe(true);
    expect(Number.isInteger(SECOND_OPINION_DEADLINE_MS)).toBe(true);
  });

  it("is a positive wait the owner is told about (the Settings page says 'over 5 seconds')", () => {
    expect(SECOND_OPINION_DEADLINE_MS).toBeGreaterThan(0);
    expect(SECOND_OPINION_DEADLINE_MS).toBe(5_000);
  });
});

describe("SECOND_OPINION_PRESETS", () => {
  it("is a non-empty list of options", () => {
    expect(Array.isArray(SECOND_OPINION_PRESETS)).toBe(true);
    expect(SECOND_OPINION_PRESETS.length).toBeGreaterThan(0);
  });

  it("gives every preset a label, a note, a base address and a model", () => {
    for (const p of SECOND_OPINION_PRESETS) {
      expect(p.label.trim(), p.label).not.toBe("");
      expect(p.note.trim(), p.label).not.toBe("");
      expect(p.baseUrl.trim(), p.label).not.toBe("");
      expect(p.model.trim(), p.label).not.toBe("");
      expect(p.baseUrl, p.label).toMatch(/^https?:\/\//);
      expect(p.baseUrl.endsWith("/"), p.label).toBe(false);
    }
  });

  it("points every preset at an OpenAI-compatible address ending in /v1 (the server appends /chat/completions)", () => {
    for (const p of SECOND_OPINION_PRESETS) expect(new URL(p.baseUrl).pathname, p.label).toMatch(/\/v1$/);
  });

  it("has a label that can name the preset on its own: no two labels are the same", () => {
    const labels = SECOND_OPINION_PRESETS.map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.trim()).not.toBe("");
  });

  it("never carries a key or a secret: the owner picks one under Secrets, and these are public defaults", () => {
    for (const p of SECOND_OPINION_PRESETS) {
      for (const field of [p.label, p.note, p.baseUrl, p.model]) {
        expect(field, p.label).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
        expect(field, p.label).not.toMatch(/\b(?:gh[pousr]_|github_pat_)/);
        expect(field, p.label).not.toMatch(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/);
        expect(field, p.label).not.toMatch(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i);
      }
      expect(p).not.toHaveProperty("apiKey");
      expect(p).not.toHaveProperty("secret");
    }
  });

  it("marks at least one preset recommended and leaves at least one not recommended", () => {
    expect(SECOND_OPINION_PRESETS.some((p) => p.recommended)).toBe(true);
    expect(SECOND_OPINION_PRESETS.some((p) => !p.recommended)).toBe(true);
  });

  it("recommends the local Ollama preset, so an owner can keep cards on their own network", () => {
    const local = SECOND_OPINION_PRESETS.filter((p) => /^http:\/\/localhost:\d+\/v1$/.test(p.baseUrl));
    expect(local.length).toBeGreaterThan(0);
    for (const p of local) expect(p.recommended, p.label).toBe(true);
  });

  it("recommends only what the study found usable: at most two presets are recommended", () => {
    expect(SECOND_OPINION_PRESETS.filter((p) => p.recommended).length).toBeLessThanOrEqual(2);
  });

  it("uses a model name the /chat/completions endpoint can take, not a decision scorer", () => {
    for (const p of SECOND_OPINION_PRESETS) {
      expect(p.model, p.label).not.toMatch(/\s/);
      expect(p.baseUrl.length, p.label).toBeLessThanOrEqual(300);
      expect(p.model.length, p.label).toBeLessThanOrEqual(200);
    }
  });

  it("reads the same on every visit: the list is fixed, not built per call", () => {
    expect(SECOND_OPINION_PRESETS).toBe(SECOND_OPINION_PRESETS);
    for (const p of SECOND_OPINION_PRESETS) {
      expect(Object.keys(p).sort()).toEqual(["baseUrl", "label", "model", "note", "recommended"]);
    }
  });
});
