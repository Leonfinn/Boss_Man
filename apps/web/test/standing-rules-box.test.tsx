// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { StandingRules } from "../src/pages/Settings";

// BOS-1050, the short half: the standing rules box the owner reads when not editing is a read-only text
// element carrying the shared class that gives it the dark theme's text and background (the rendering
// test readonly-text-contrast.test.ts measures the colours in a browser); pressing Edit shows the editor,
// and both read the same text. The page must not go back to an inline near-white box.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const RULES = "First rule: never write a secret to a file.\n\nSecond rule: start from origin/main.";

const renderRules = async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = String(url).includes("standing-rules") ? { text: RULES, by: "CEO", at: new Date().toISOString(), max: 2000 } : [];
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  render(<StandingRules company={company} onChanged={() => {}} />);
  return waitFor(() => screen.getByRole("note", { name: "Standing rules" }));
};

describe("standing rules box (BOS-1050)", () => {
  it("shows the rules as read-only text in the shared read-only class, with no inline background", async () => {
    const box = await renderRules();
    expect(box.tagName).toBe("PRE");
    expect(box.classList.contains("readonly-text")).toBe(true);
    expect(box.style.background).toBe("");
    expect(box.style.backgroundColor).toBe("");
    expect(box.textContent).toContain("First rule");
    expect(box.textContent).toContain("\n\n");
  });

  it("switches to the editor on Edit, which keeps the same text", async () => {
    await renderRules();
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const editor = await screen.findByRole("textbox", { name: "Standing rules" });
    expect(editor.tagName).toBe("TEXTAREA");
    expect((editor as HTMLTextAreaElement).value).toContain("Second rule");
    expect(screen.queryByText("First rule", { selector: "pre" })).toBeNull();
  });
});
