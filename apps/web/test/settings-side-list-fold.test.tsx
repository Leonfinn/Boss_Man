// @vitest-environment jsdom
// BOS-1655: the Settings side list marks the group you are in, and gives each other group one fold row (CSS shows
// it only on a short window). The old one-page address lands on Updates, so "Server and runner" is the current group.
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Settings, settingsRedirect } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, ticketPrefix: "BOSS", nextTicketNumber: 1, agents: [], projects: [] } as never;

function menu(tab: string | undefined) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })));
  const { container } = render(<Settings companies={[company]} companyId="c1" tab={tab} go={() => {}} onChanged={() => {}} />);
  return container;
}

describe("Settings side list groups", () => {
  it("after the old /system address, Server and runner is the current group and the others have a fold row", () => {
    const tab = settingsRedirect(["settings", "c1", "system"], "c1")!.split("/")[2];
    const c = menu(tab);
    const current = c.querySelectorAll(".set-group-current");
    expect(current).toHaveLength(1);
    expect(current[0]!.querySelector(".set-group-label")!.textContent).toBe("Server and runner");
    expect(current[0]!.querySelector(".set-group-fold")).toBeNull();
    const folds = [...c.querySelectorAll<HTMLAnchorElement>(".set-group-fold")];
    expect(folds.map((a) => a.textContent)).toEqual(["Money and access›", "How the team works›"]);
    expect(folds[0]!.getAttribute("href")).toBe("#/settings/c1/funding");
  });

  it("the bare menu (no page open) shows every group in full, with no fold rows", () => {
    const c = menu(undefined);
    expect(c.querySelectorAll(".set-group-fold")).toHaveLength(0);
    expect(c.querySelectorAll(".set-group-current")).toHaveLength(0);
    expect(c.querySelectorAll(".set-nav li")).toHaveLength(15);
  });
});
