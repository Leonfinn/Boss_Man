// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";
import { stubFetchByUrl } from "./stub-fetch";

// BOS-2798: on 27 Nov the owner pressed "Done, output pasted in my note" on a card (BOS-2775); it closed at once with no
// note, so the output never reached the agent. An option that says its answer is in the note now shows the note box
// open, refuses the press with an empty note ("Paste it in the note first") and sends what is written there.

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
  context: { type: "question" },
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

describe("an option that says its answer is in the note (BOS-2798)", () => {
  it("shows the note box open, and pressing the option with an empty note keeps the card open", async () => {
    const s = stub();
    const onAnswered = vi.fn();
    render(<Decisions decisions={[card()]} companies={[company]} loaded agentsWorking={0} onAnswered={onAnswered} />);
    const box = screen.getByLabelText(/^Your note for "Done, output pasted in my note": paste the output or write your answer here, then press it\./);
    // Spaces only count as empty.
    fireEvent.change(box, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: `${PASTED}, recommended` }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Paste it in the note first/);
    expect(s.answers).toEqual([]);
    expect(onAnswered).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(box);
  });

  it("sends what is in the note with the option", async () => {
    const s = stub();
    render(<Decisions decisions={[card()]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    const output = "Filesystem  Size  Used Avail Use% Mounted on\n/dev/sda1  100G  42G  58G  42% /";
    fireEvent.change(screen.getByLabelText(/^Your note for/), { target: { value: output } });
    fireEvent.click(screen.getByRole("button", { name: `${PASTED}, recommended` }));
    await waitFor(() => expect(s.answers).toHaveLength(1));
    expect(s.answers[0]).toMatchObject({ answer: PASTED, note: output });
  });

  it("an option the raiser flagged needs a note too; the other options and a plain card don't", async () => {
    const s = stub();
    const { unmount } = render(<Decisions decisions={[card({ options: ["Sent", "Not now"], recommendedOption: "Sent", context: { type: "question", noteOptions: ["Sent"] } })]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    expect(screen.getByLabelText(/^Your note for "Sent"/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(s.answers).toHaveLength(1));
    expect(s.answers[0]).toMatchObject({ answer: "Not now" });
    unmount();
    render(<Decisions decisions={[card({ id: "d2", options: ["Yes", "No"], recommendedOption: "Yes" })]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    expect(screen.queryByTestId("card-note")).toBeNull();
  });
});
