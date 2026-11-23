// @vitest-environment jsdom
// BOS-2330: on the real Board and Decisions screens, j/k move focus between cards (on the Board down a lane, then
// the next lane), Enter opens the focused card, nothing fires in a text box or over a dialog, and the "?" list
// has a section for the screen.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Decision } from "../src/api";
import { Shortcuts, screenKeys } from "../src/components/Shortcuts";
import { Board } from "../src/pages/Board";
import { Decisions } from "../src/pages/Decisions";

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.location.hash = "";
  document.body.innerHTML = "";
});

const press = (key: string, target: Element | Window = window) => fireEvent.keyDown(target, { key });
const focusedCardText = () => (document.activeElement as HTMLElement).closest("[data-shortcut-card]")?.querySelector("h3, h2")?.textContent;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", ticketPrefix: "APP", mission: null, paused: false, agents: [{ id: "a1", name: "Developer" }] } as Company;
const tk = (n: number, title: string, state: string) => ({ id: `t${n}`, number: n, title, systemState: state, outcome: null, assigneeAgentId: "a1", assignedToOwner: false, dueDate: null, blockedBy: [], branch: null, risk: null, planFirst: false, plan: null, planApprovedAt: null, lastActivityAt: "2026-11-20T09:00:00Z", featureId: null, featureTitle: null });

async function openBoard() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "Site", repoUrl: null }]);
      if (url.includes("/board"))
        return json({
          project: { id: "p1", companyId: "c1", name: "Site" },
          doneTotal: 0,
          columns: [
            { id: "c1", name: "Backlog", systemState: "backlog", wipLimit: null, tickets: [tk(1, "Alpha", "backlog"), tk(2, "Bravo", "backlog")] },
            { id: "c2", name: "In progress", systemState: "in_progress", wipLimit: null, tickets: [tk(3, "Charlie", "in_progress")] },
          ],
        });
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
      return json([]);
    }),
  );
  window.location.hash = "#/board/p1";
  render(<><Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} /><Shortcuts go={() => {}} hasProjects /></>);
  await screen.findByText("Charlie");
}

const decision = (id: string, question: string): Decision => ({
  id,
  companyId: "c1",
  kind: "question",
  question,
  options: ["Yes", "No"],
  recommendedOption: "Yes",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "Moss",
  blocks: [],
  about: [],
  score: 0,
  parts: { blocking: 0, urgency: 0, age: 0, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
});

describe("card shortcuts on the Board (BOS-2330)", () => {
  it("j goes down a lane then on to the next lane, k goes back, and it stops at the ends", async () => {
    await openBoard();
    press("j");
    expect(focusedCardText()).toBe("Alpha");
    press("j");
    expect(focusedCardText()).toBe("Bravo");
    press("j");
    expect(focusedCardText()).toBe("Charlie");
    press("j");
    expect(focusedCardText()).toBe("Charlie");
    press("k");
    expect(focusedCardText()).toBe("Bravo");
  });

  it("k with no card focused starts at the last card, and the focused card is scrolled into view", async () => {
    await openBoard();
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    press("k");
    expect(focusedCardText()).toBe("Charlie");
    expect(scroll).toHaveBeenCalledWith({ block: "nearest", inline: "nearest" });
    expect(scroll.mock.contexts[0]).toBe(document.activeElement);
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it("Enter opens the focused card's task, as clicking its title would", async () => {
    await openBoard();
    const clicked: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.getAttribute("href")!);
    });
    press("j");
    press("j");
    expect(press("Enter", document.activeElement!)).toBe(false); // handled: preventDefault was called
    expect(clicked).toEqual(["#/tickets/t2"]);
  });

  it("Enter on a link inside a card is left to the link, and Enter with no card focused does nothing", async () => {
    await openBoard();
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click");
    expect(press("Enter")).toBe(true);
    const title = screen.getByRole("link", { name: "Alpha" });
    title.focus();
    expect(press("Enter", title)).toBe(true);
    expect(click).not.toHaveBeenCalled();
  });

  it("does nothing while typing in the search box or with a dialog open", async () => {
    await openBoard();
    const box = screen.getByRole("searchbox", { name: "Search tasks" });
    box.focus();
    expect(press("j", box)).toBe(true);
    expect(document.activeElement).toBe(box);
    box.blur();
    const other = document.createElement("div");
    other.setAttribute("role", "dialog");
    other.setAttribute("aria-modal", "true");
    document.body.appendChild(other);
    press("j");
    expect(document.activeElement).toBe(document.body);
  });

  it("the '?' list has a section for the Board", async () => {
    await openBoard();
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    const section = screen.getByRole("dialog", { name: "Keyboard shortcuts" }).querySelector("dl[aria-label='On the Board']");
    expect(section?.textContent).toMatch(/j\s*Next card \(down the lane, then the next lane\)/);
    expect(section?.textContent).toMatch(/k\s*Previous card/);
    expect(section?.textContent).toMatch(/Enter\s*Open the card's task/);
  });
});

describe("card shortcuts on Decisions (BOS-2330)", () => {
  const show = () => {
    window.location.hash = "#/decisions";
    render(<><Decisions decisions={[decision("d1", "First question?"), decision("d2", "Second question?")]} companies={[company]} loaded agentsWorking={0} onAnswered={() => {}} /><Shortcuts go={() => {}} hasProjects /></>);
  };

  it("j/k move between cards in queue order and Enter goes to the card's answer buttons without answering", () => {
    const answered = vi.fn();
    vi.stubGlobal("fetch", answered);
    show();
    press("j");
    expect(focusedCardText()).toContain("First question?");
    press("j");
    expect(focusedCardText()).toContain("Second question?");
    press("k");
    expect(focusedCardText()).toContain("First question?");
    press("Enter", document.activeElement!);
    const focused = document.activeElement as HTMLElement;
    expect(focused.tagName).toBe("BUTTON");
    expect(focused.textContent).toContain("Yes");
    expect(focused.closest("[data-shortcut-card]")?.id).toBe("decision-d1");
    // Focusing a card marks it opened (BOS-1691), as tabbing into it does; no answer is sent.
    expect(answered.mock.calls.map((c) => c[0]).filter((u: string) => u.endsWith("/answer"))).toEqual([]);
    // From inside the card, j still moves on to the next card.
    press("j", focused);
    expect(focusedCardText()).toContain("Second question?");
  });

  it("the '?' list has a section for Decisions", () => {
    show();
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    const section = screen.getByRole("dialog", { name: "Keyboard shortcuts" }).querySelector("dl[aria-label='On Decisions']");
    expect(section?.textContent).toMatch(/Enter\s*Go to the card's answer buttons/);
  });
});

describe("screens without cards (BOS-2330)", () => {
  it("j does nothing and the '?' list has no screen section", () => {
    window.location.hash = "#/dashboard";
    render(<Shortcuts go={() => {}} hasProjects />);
    expect(press("j")).toBe(true);
    expect(screenKeys("#/dashboard")).toBeNull();
    expect(screenKeys("#/boardroom")).toBeNull();
    expect(screenKeys("#/board")?.title).toBe("On the Board");
    expect(screenKeys("#/decisions/abc123")?.title).toBe("On Decisions");
    fireEvent.keyDown(window, { key: "?", shiftKey: true });
    expect(screen.getByRole("dialog").querySelector("h3")).toBeNull();
  });
});
