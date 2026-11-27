// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";
import { stubFetchByUrl } from "./stub-fetch";

// BOS-2742: on 26 Nov the owner pressed "Done, screenshot of the result attached" on a card (BOS-2597); it closed at
// once with nowhere to put the picture. A card option that promises a screenshot now shows a box to paste or attach
// it, refuses the press with nothing attached ("Attach the screenshot first") and sends the picture's link in the note.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const DONE_SHOT = "Done, screenshot of the result attached";
const IMAGE_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const MARKDOWN = `![live-test.png](/api/ticket-images/${IMAGE_ID})`;
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const card = (over: Partial<Decision> = {}): Decision => ({
  id: "d1",
  companyId: "c1",
  kind: "question",
  question: "Run Google's live test on the sitemap.",
  options: [DONE_SHOT, "It failed"],
  recommendedOption: DONE_SHOT,
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "Engineer",
  blocks: [{ ticketId: "t1", title: "Submit the sitemap", ref: "BOS-2597" }] as Decision["blocks"],
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
  const uploads: Array<Record<string, unknown>> = [];
  const fetchMock = stubFetchByUrl({
    "/api/decisions/tally*": { open: 1, waiting: 0 },
    "/api/companies/c1/images": (_: string, init?: RequestInit) => {
      uploads.push(JSON.parse(String(init?.body)));
      return { id: IMAGE_ID, markdown: MARKDOWN };
    },
    "/api/decisions/d1/answer": (_: string, init?: RequestInit) => {
      answers.push(JSON.parse(String(init?.body)));
      return { id: "d1" };
    },
    "/api/decisions/d1/opened": {},
  });
  return { fetchMock, answers, uploads };
}

const paste = (el: HTMLElement) => {
  const file = new File([new Uint8Array([137, 80, 78, 71])], "live-test.png", { type: "image/png" });
  fireEvent.paste(el, { clipboardData: { files: [file], getData: () => "" } });
};

describe("an option that promises a screenshot (BOS-2742)", () => {
  it("shows a box to paste it in, and pressing the option with nothing attached keeps the card open", async () => {
    const s = stub();
    const onAnswered = vi.fn();
    render(<Decisions decisions={[card()]} companies={[company]} loaded agentsWorking={0} onAnswered={onAnswered} />);
    const box = screen.getByLabelText(/Screenshot for "Done, screenshot of the result attached": paste it here or use Attach file\./);
    expect(screen.getByRole("button", { name: "Attach file" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: `${DONE_SHOT}, recommended` }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/^Attach the screenshot first/);
    expect(s.answers).toEqual([]);
    expect(onAnswered).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(box);
  });

  it("sends the pasted screenshot's link in the note, uploaded to the card's ticket", async () => {
    const s = stub();
    render(<Decisions decisions={[card()]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    const box = screen.getByLabelText(/Screenshot for/);
    fireEvent.change(box, { target: { value: "It passed." } });
    paste(box);
    await waitFor(() => expect(screen.getByRole("img", { name: "live-test.png" })).toBeTruthy());
    expect(s.uploads[0]).toMatchObject({ ticketId: "t1" });
    fireEvent.click(screen.getByRole("button", { name: `${DONE_SHOT}, recommended` }));
    await waitFor(() => expect(s.answers).toHaveLength(1));
    expect(s.answers[0]).toMatchObject({ answer: DONE_SHOT });
    expect(String(s.answers[0]!.note)).toContain("It passed.");
    expect(String(s.answers[0]!.note)).toContain(MARKDOWN);
  });

  it("an option the raiser flagged needs one too, and a plain card shows no attach box", () => {
    stub();
    const { unmount } = render(<Decisions decisions={[card({ options: ["Sent", "Not now"], recommendedOption: "Sent", context: { type: "question", attachOptions: ["Sent"] } })]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    expect(screen.getByLabelText(/Screenshot for "Sent"/)).toBeTruthy();
    unmount();
    render(<Decisions decisions={[card({ options: ["Yes", "No"], recommendedOption: "Yes" })]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    expect(screen.queryByTestId("card-attach")).toBeNull();
  });

  it("the to-do's 'What went wrong' box takes a pasted picture, sent with 'A step failed'", async () => {
    const s = stub();
    const todo = card({ options: ["Done", "My screen looks different (I'll attach a screenshot)", "A step failed"], recommendedOption: "Done", context: { type: "owner_todo", steps: ["Open GitHub."], attachOptions: ["My screen looks different (I'll attach a screenshot)"] } });
    render(<Decisions decisions={[todo]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    const box = screen.getByLabelText(/^What went wrong \(if a step failed\)\. Screenshot for "My screen looks different/);
    paste(box);
    await waitFor(() => expect(screen.getByRole("img", { name: "live-test.png" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "A step failed" }));
    await waitFor(() => expect(s.answers).toHaveLength(1));
    expect(s.answers[0]).toMatchObject({ answer: "A step failed" });
    expect(String(s.answers[0]!.note)).toContain(MARKDOWN);
  });
});
