// @vitest-environment jsdom
// BOS-2708: the ticket page shows a ticket's size in points, and its help says what a point is.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Ticket } from "../src/pages/Ticket";
import { stubFetchByUrl } from "./stub-fetch";

Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const at = new Date().toISOString();
const ticket = { id: "t1", title: "Fix typo", systemState: "in_progress", risk: "low", size: 3, projectId: "p1", project: "App", companyId: "c1", assignee: "Engineer", assigneeAgentId: "a1", createdAt: at, lastActivityAt: at, monitorAttempts: 0, monitorMax: 5, body: "Words", acceptanceCriteria: [] };

describe("a ticket's size on its page (BOS-2708)", () => {
  it("shows the size as points and explains points behind the Size help", async () => {
    stubFetchByUrl({
      "/api/tickets/t1": ticket,
      "/api/tickets/t1/links": { waitsOn: [], blocks: [], blockedBy: [] },
      "/api/tickets/t1/messages": { live: null, items: [] },
      "/api/tickets/t1/*": [],
      "/api/companies/c1/*": [],
      "/api/risk-tiers": [],
    });
    // jsdom is 1024 px wide, where the Work panel starts folded; open it as an owner who unfolded it would see it.
    localStorage.setItem("bossman.ticket.workCollapsed", "0");
    render(<Ticket id="t1" companies={[company]} />);
    const size = (await screen.findByLabelText("Size")) as HTMLSelectElement;
    expect(size.value).toBe("3");
    expect(size.selectedOptions[0]!.textContent).toBe("3 points");
    fireEvent.click(screen.getByRole("button", { name: "About Size" }));
    expect(await screen.findByText(/Each ticket is sized 1, 2, 3, 5 or 8 points by how much work it is/)).toBeTruthy();
  });
});
