// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Funding } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("funding source provider", () => {
  it("only offers Anthropic and OpenAI for a subscription, and resets an invalid provider", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    render(<Funding company={{ id: "c1", name: "Co", mission: null, paused: false, agents: [] } as Company} onChanged={() => {}} />);
    const provider = (await screen.findByLabelText("Provider")) as HTMLSelectElement;
    const options = () => [...provider.options].map((o) => o.value);
    expect(options()).toEqual(["anthropic", "openai"]);
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "api_payg" } });
    expect(options()).toContain("bedrock");
    fireEvent.change(provider, { target: { value: "bedrock" } });
    fireEvent.change(screen.getByLabelText("Kind"), { target: { value: "subscription" } });
    expect(provider.value).toBe("anthropic");
    expect(screen.getByText("What the provider controls")).toBeTruthy();
  });
});
