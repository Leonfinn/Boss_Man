// @vitest-environment jsdom
// BOS-2348: "Find a setting" narrows the Settings list by label, hint, help and jump-entry text.
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings, SETTINGS_PAGES, findSettings } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOSS", nextTicketNumber: 1, agents: [], projects: [] } as never;

function menu() {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  return render(<Settings companies={[company]} companyId="c1" tab={undefined} go={() => {}} onChanged={() => {}} />).container;
}

describe("findSettings", () => {
  it("returns null for an empty or blank query", () => {
    expect(findSettings("")).toBeNull();
    expect(findSettings("   ")).toBeNull();
  });
  it("matches a page by label, ignoring case, and requires every word", () => {
    const hit = findSettings("EMAIL");
    expect(hit!.has("email")).toBe(true);
    expect(findSettings("email zzzznomatch")!.size).toBe(0);
  });
  it("a jump-entry match lists that entry under its page", () => {
    const page = SETTINGS_PAGES.find((p) => p.jump && p.jump.length > 0)!;
    const j = page.jump![0]!;
    const hit = findSettings(j.label);
    expect(hit!.get(page.id)).toContainEqual(j);
  });
});

describe("Find a setting box", () => {
  it("narrows the list, shows a no-match note, and Esc shows every page again", () => {
    const c = menu();
    const total = c.querySelectorAll(".set-nav > .set-group li").length;
    const box = c.querySelector<HTMLInputElement>("input[aria-label='Find a setting']")!;
    fireEvent.change(box, { target: { value: "email" } });
    const shown = c.querySelectorAll(".set-nav > .set-group > ul > li").length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(total);
    fireEvent.change(box, { target: { value: "zzzznomatch" } });
    expect(c.querySelector("[role=status]")!.textContent).toContain("No setting matches");
    expect(c.querySelectorAll(".set-nav > .set-group").length).toBe(0);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(box.value).toBe("");
    expect(c.querySelectorAll(".set-nav > .set-group > ul > li")).toHaveLength(16);
  });
});
