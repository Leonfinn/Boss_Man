// BOS-279: Synthetic's Infinite mode is a model alias, not a provider, so it is recognised from the model
// id alone, however OpenCode spells the provider around it.
import { describe, expect, it } from "vitest";
import { INFINITE_MODEL, INFINITE_MODEL_CHOICE, infiniteLaunchModel, isInfiniteModel } from "../src/funding.js";

describe("isInfiniteModel", () => {
  it("recognises the alias under any provider name", () => {
    for (const model of ["synthetic/infinite:small:vision", "hf/infinite:small:vision", "infinite:small:vision", "synthetic/infinite:anything"]) expect(isInfiniteModel(model)).toBe(true);
  });

  it("leaves normal models and empty values alone", () => {
    for (const model of ["synthetic/hf:deepseek-ai/DeepSeek-V4.1-Flash-1017", "claude-opus-4-6", "openrouter/anthropic/claude-sonnet-4", "not-infinite:small:vision", "", null, undefined]) expect(isInfiniteModel(model)).toBe(false);
  });

  it("launches the stored model on the hf provider the runner adds", () => {
    expect(infiniteLaunchModel("synthetic/infinite:small:vision")).toBe("hf/infinite:small:vision");
    expect(infiniteLaunchModel("synthetic/infinite:other:alias")).toBe("hf/infinite:other:alias");
    expect(isInfiniteModel(infiniteLaunchModel(INFINITE_MODEL_CHOICE.value))).toBe(true);
  });

  it("offers it in the picker under the name the server stores, labelled free and slow", () => {
    expect(INFINITE_MODEL_CHOICE.value).toBe(`synthetic/${INFINITE_MODEL}`);
    expect(INFINITE_MODEL_CHOICE.name).toContain("free");
    expect(INFINITE_MODEL_CHOICE.name).toContain("slow");
  });
});
