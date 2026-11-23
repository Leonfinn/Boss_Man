import { afterAll, describe, expect, it } from "vitest";
import { API, launch, openApp, startVite, stubApi } from "./real-page";

// (BOS-1159) The owner pressed "Answer in Decisions" on the Board and found no card, and no pending
// card on the ticket page. In a real browser: one open owner question, flagged "may be out of date"
// because the owner acted on its ticket (the state that folded it out of sight), on an in-progress
// ticket, must be (1) on the Board with a button naming the card, (2) on the Decisions page, shown
// and marked when opened by that link, with its answer buttons, and (3) listed on the ticket page
// with an answer button. A link to a card that is gone must say so.
//
// Skipped, not failed, where no browser or Vite is installed (the runner and CI have both).

const CARD = "92a1d401-6deb-4821-b372-e9bbbbc961f3";
const GONE = "11111111-2222-4333-8444-555555555555";
const TICKET = "tq";
const now = new Date().toISOString();

const card = {
  id: CARD,
  companyId: "c1",
  kind: "question",
  question: "The merge check for BOS-972 has failed three times. Shall I wait for you?",
  options: ["Wait", "Stop"],
  recommendedOption: "Wait",
  tier: "owner",
  createdAt: new Date(Date.now() - 26 * 3_600_000).toISOString(),
  companyName: "Boss Man Co",
  agentName: "Kit",
  blocks: [{ ticketId: TICKET, ref: "BOS-972", title: "Stuck ticket" }],
  about: [{ ticketId: TICKET, ref: "BOS-972", title: "Stuck ticket" }],
  score: 30,
  parts: { blocking: 30, urgency: 0, age: 0, liveRun: 0 },
  reasons: [],
  ageReason: null,
  dueDate: null,
  staleAt: now,
  staleReason: "you replied on the ticket",
  context: { type: "question" },
  refs: {},
};

const base = API["/api/projects/p1/board"] as { columns: Array<{ systemState: string; tickets: unknown[] }> };
const stuck = { ...(base.columns[1]!.tickets[0] as object), id: TICKET, title: "Stuck ticket", number: 972, systemState: "in_progress", waitingOnOwner: true, ownerQuestion: card.question, ownerQuestionId: CARD };
const columns = base.columns.map((c) => (c.systemState === "review" ? { ...c, tickets: [stuck, ...c.tickets] } : c));

const api: Record<string, unknown> = {
  ...API,
  "/api/projects/p1/board": { ...base, columns },
  "/api/decisions": [card],
  [`/api/tickets/${TICKET}`]: { ...stuck, companyId: "c1", projectId: "p1", project: "Development", body: "x", acceptanceCriteria: [], createdAt: now, lastActivityAt: now, landing: "merge", defaultBranch: "main", repoUrl: null, milestoneId: null },
  "/api/risk-tiers": [],
  "/api/companies/c1/objectives": [],
  [`/api/tickets/${TICKET}/related`]: { feature: null, parent: null, subtasks: [], peers: [], waitsOn: [], blocks: [], mentioned: [] },
  "/api/companies/c1/watchdog/actions": [],
  [`/api/tickets/${TICKET}/reviews`]: [],
  [`/api/tickets/${TICKET}/artifacts`]: [],
  [`/api/tickets/${TICKET}/images`]: [],
  [`/api/tickets/${TICKET}/runs`]: [],
  [`/api/tickets/${TICKET}/links`]: { waitsOn: [{ dependencyId: "dep1", kind: "decision", id: CARD, title: card.question, state: "open", open: true, link: `#/decisions/${CARD}` }], blocks: [] },
};

const browser = await launch();
const vite = browser ? await startVite() : null;
const can = !!(browser && vite);
afterAll(async () => {
  await browser?.close();
  await vite?.close();
});

describe.skipIf(!can)("an open owner card is reachable from the Board, Decisions and the ticket page (BOS-1159)", () => {
  it("shows on all three, and the Board's button opens and marks that exact card", async () => {
    const page = await openApp(browser!, vite!, { width: 1280, height: 900 });
    await stubApi(page, api);
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector(".board-scroll .ticket h3");

    // 1. The Board shows it, and its button names the card.
    const href = await page.getAttribute(".ticket a.btn.primary", "href");
    expect(href).toBe(`#/decisions/${CARD}`);

    // 2. That link opens Decisions with the card on it, marked, with its answer buttons.
    await page.click(".ticket a.btn.primary");
    await page.waitForSelector(`#decision-${CARD}`, { timeout: 15_000 });
    expect(await page.getAttribute(`#decision-${CARD}`, "aria-current")).toBe("true");
    expect(await page.textContent(`#decision-${CARD}`)).toContain("Shall I wait for you?");
    expect(await page.locator(`#decision-${CARD} button`, { hasText: "Wait" }).count()).toBeGreaterThan(0);
    expect(await page.locator('[data-testid="linked-card-gone"]').count()).toBe(0);

    // 3. The ticket page lists it with an answer button that goes to the same card.
    await page.evaluate((id: string) => { window.location.hash = `#/tickets/${id}`; }, TICKET);
    await page.waitForSelector('[data-testid="ticket-open-cards"]', { timeout: 15_000 });
    expect(await page.getAttribute('[data-testid="ticket-open-cards"] a', "href")).toBe(`#/decisions/${CARD}`);

    await page.close();
  }, 60_000);

  it("says so plainly when the linked card is not open any more", async () => {
    const page = await openApp(browser!, vite!, { width: 1280, height: 900 });
    await stubApi(page, api);
    await page.evaluate((id: string) => { window.location.hash = `#/decisions/${id}`; }, GONE);
    await page.waitForSelector('[data-testid="linked-card-gone"]', { timeout: 15_000 });
    expect(await page.textContent('[data-testid="linked-card-gone"]')).toMatch(/not open any more/);
    await page.close();
  }, 60_000);

  it("opens the Answered list on a closed card the link names, marked (BOS-2326: a search result for an answered card)", async () => {
    const page = await openApp(browser!, vite!, { width: 1280, height: 900 });
    const answered = { id: GONE, question: "Use the blue theme?", status: "answered", answer: "Yes", by: "owner", byName: null, at: now, ticket: null };
    await stubApi(page, { ...api, "/api/decisions/answered": { items: [answered], next: null } });
    await page.evaluate((id: string) => { window.location.hash = `#/decisions/${id}`; }, GONE);
    await page.waitForSelector(`#decision-${GONE}`, { timeout: 15_000 });
    expect(await page.getAttribute(`#decision-${GONE}`, "aria-current")).toBe("true");
    expect(await page.textContent(`#decision-${GONE}`)).toContain("Use the blue theme?");
    expect(await page.locator('[data-testid="answered-list"]').evaluate((d: Element) => (d as HTMLDetailsElement).open)).toBe(true);
    await page.close();
  }, 60_000);
});
