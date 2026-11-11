// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewBuildBanner } from "../src/App";
import { mainScriptOf, newerBuild } from "../src/new-build";
import { clearAllDrafts, saveDraft } from "../src/drafts";

// An open tab kept running the old screens after an update, so a new card's commands showed as raw text (BOS-550).

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const page = (script: string) => `<!doctype html><html><head><script type="module" crossorigin src="${script}"></script><link rel="stylesheet" href="/assets/index-c.css"></head><body><div id="root"></div></body></html>`;
const serve = (html: string, ok = true) => vi.stubGlobal("fetch", vi.fn(async () => ({ ok, text: async () => html })));

describe("noticing newer screens on the server (BOS-550)", () => {
  it("reads the built page's main script", () => {
    expect(mainScriptOf(page("/assets/index-abc123.js"))).toBe("/assets/index-abc123.js");
    expect(mainScriptOf('<script src="/other.js"></script><script type="module" src="./assets/index-x.js"></script>')).toBe("/assets/index-x.js");
    expect(mainScriptOf("<p>no script</p>")).toBeNull();
  });

  it("says so when the server's page names a different script from the one this tab runs", async () => {
    serve(page("/assets/index-new.js"));
    expect(await newerBuild(new AbortController().signal, "/assets/index-old.js")).toBe(true);
  });

  it("stays quiet for the same script, a failed fetch, a page with no script, or a tab that can't tell", async () => {
    serve(page("/assets/index-old.js"));
    expect(await newerBuild(new AbortController().signal, "/assets/index-old.js")).toBe(false);
    serve(page("/assets/index-new.js"), false);
    expect(await newerBuild(new AbortController().signal, "/assets/index-old.js")).toBe(false);
    serve("<p>maintenance</p>");
    expect(await newerBuild(new AbortController().signal, "/assets/index-old.js")).toBe(false);
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    expect(await newerBuild(new AbortController().signal, null)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("shows a banner with a Reload button only when newer screens are there", () => {
    const { rerender } = render(<NewBuildBanner newer={false} />);
    expect(screen.queryByRole("status")).toBeNull();
    const reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    rerender(<NewBuildBanner newer />);
    expect(screen.getByRole("status").textContent).toMatch(/has been updated since this page was opened/);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalled();
  });

  it("says the owner's text is kept when this browser holds a draft, so the prompt doesn't warn them off (BOS-773)", () => {
    saveDraft("new-task/c1/p1", "half a task");
    render(<NewBuildBanner newer />);
    expect(screen.getByRole("status").textContent).toMatch(/What you've typed is kept/);
    cleanup();
    clearAllDrafts();
    // Every owner text box keeps a draft by construction (BOS-784, DR-045), so it says so even with none
    // typed yet: reloading can't lose anything.
    render(<NewBuildBanner newer />);
    expect(screen.getByRole("status").textContent).toMatch(/every text box keeps a draft/);
  });
});
