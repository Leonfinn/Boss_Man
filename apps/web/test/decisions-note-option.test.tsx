// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";
import { stubFetchByUrl } from "./stub-fetch";

// BOS-2798 (DR-078): on 27 Nov the owner pressed "Done, output pasted in my note" on a card (BOS-2775); it closed at once
// with no note, so the output never reached the agent. An option that needs a note now has the note box above the
// buttons, named for it, and stays disabled until the box has text; then it sends what is written there.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const PASTED = "Done, output pasted in my note";
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const card = (over: Partial<Decision> = {}): Decision => ({
  id: "d1",
  companyId: "c1",
  kind: "question",
  question: "Run df -h on the host and paste the output.",
  options: [PASTED, "It failed"],
  recommendedOption: PASTED,
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "Engineer",
  blocks: [{ ticketId: "t1", title: "Read the disk usage", ref: "BOS-2775" }] as Decision["blocks"],
  score: 10,
  parts: { blocking: 0, urgency: 0, age: 10, liveRun: 0 },
  reasons: [],
  ageReason: "",
  dueDate: null,
  context: { type: "question", noteOptions: [PASTED] },
  ...over,
});

function stub() {
  const answers: Array<Record<string, unknown>> = [];
  stubFetchByUrl({
    "/api/decisions/tally*": { open: 1, waiting: 0 },
    "/api/decisions/d1/answer": (_: string, init?: RequestInit) => {
      answers.push(JSON.parse(String(init?.body)));
      return { id: "d1" };
    },
    "/api/decisions/d1/opened": {},
  });
  return { answers };
}

const pasted = () => screen.getByRole("button", { name: `${PASTED}, recommended` }) as HTMLButtonElement;

describe("an option that needs a note (BOS-2798, DR-078)", () => {
  it("shows the box above the buttons, named for the option, and keeps the option disabled while the note is blank", () => {
    const s = stub();
    render(<Decisions decisions={[card()]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    const box = screen.getByLabelText(`Paste your output here for "${PASTED}"`);
    // Above the buttons in the page order.
    expect(box.compareDocumentPosition(pasted()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(pasted().disabled).toBe(true);
    expect(screen.getByText(/^Paste it in the note first:/)).toBeTruthy();
    // Spaces only still count as empty.
    fireEvent.change(box, { target: { value: "   " } });
    expect(pasted().disabled).toBe(true);
    fireEvent.click(pasted());
    expect(s.answers).toEqual([]);
    // The other option needs nothing.
    expect((screen.getByRole("button", { name: "It failed" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends what is in the note with the option once there is text", async () => {
    const s = stub();
    render(<Decisions decisions={[card()]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    const output = "Filesystem  Size  Used Avail Use% Mounted on\n/dev/sda1  100G  42G  58G  42% /";
    fireEvent.change(screen.getByLabelText(/^Paste your output here for/), { target: { value: output } });
    expect(pasted().disabled).toBe(false);
    expect(screen.queryByText(/^Paste it in the note first:/)).toBeNull();
    fireEvent.click(pasted());
    await waitFor(() => expect(s.answers).toHaveLength(1));
    expect(s.answers[0]).toMatchObject({ answer: PASTED, note: output });
  });

  it("an older card with no flag is held by the option's words too", () => {
    stub();
    render(<Decisions decisions={[card({ context: { type: "question" } })]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    expect(screen.getByLabelText(`Paste your output here for "${PASTED}"`)).toBeTruthy();
    expect(pasted().disabled).toBe(true);
  });

  it("on a to-do the box is above the buttons for the option, not hidden under 'What went wrong'", () => {
    stub();
    const todo = card({ options: ["Done, output in my note", "A step failed"], recommendedOption: "Done, output in my note", context: { type: "owner_todo", steps: ["Run df -h on the host."], noteOptions: ["Done, output in my note"] } });
    render(<Decisions decisions={[todo]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    const box = screen.getByLabelText(/^Paste your output here for "Done, output in my note"/);
    const done = screen.getByRole("button", { name: "Done, output in my note, recommended" }) as HTMLButtonElement;
    expect(box.compareDocumentPosition(done) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(done.disabled).toBe(true);
    expect(screen.queryByLabelText(/^What went wrong/)).toBeNull();
  });

  it("a plain card shows no note box", () => {
    stub();
    render(<Decisions decisions={[card({ options: ["Yes", "No"], recommendedOption: "Yes", context: { type: "question" } })]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    expect(screen.queryByTestId("card-note")).toBeNull();
  });
});
