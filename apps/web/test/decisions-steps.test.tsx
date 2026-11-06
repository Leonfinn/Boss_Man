// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company, Decision } from "../src/api";
import { Decisions } from "../src/pages/Decisions";

// Where a command runs and as whom (BOS-427): the card shows a line above each command, and the Copy button
// copies only the command, never that line.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const setSecure = (secure: boolean) => Object.defineProperty(window, "isSecureContext", { configurable: true, value: secure });
const card = (steps: string[]): Decision => ({
  id: "d1",
  companyId: "c1",
  kind: "question",
  question: "Move Boss Man?",
  options: ["Done", "It failed"],
  recommendedOption: "Done",
  tier: "owner",
  createdAt: new Date().toISOString(),
  companyName: "App Co",
  agentName: "Engineer",
  blocks: [],
  score: 10,
  parts: { blocking: 0, urgency: 0, age: 10, liveRun: 0 },
  reasons: [],
  dueDate: null,
  context: { steps },
});
const line = (re: RegExp) => screen.getByText((_, el) => el?.tagName === "DIV" && re.test(el.textContent ?? ""));

describe("command blocks say where and as whom (BOS-427)", () => {
  it("shows 'On <host>, as <account>' above the command, and copies only the command", async () => {
    setSecure(true);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    render(<Decisions decisions={[card(['List the backups:\n\n```sh host="nas01" as="root"\nls -l /mnt/backups\n```'])]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    expect(line(/^On nas01, as root\.$/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy this command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ls -l /mnt/backups"));
  });

  it("says 'the logged-in account' for an as=login block", () => {
    render(<Decisions decisions={[card(['Check it:\n\n```sh host="nas01" as="login"\nid\n```'])]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    expect(line(/^On nas01, as the logged-in account\.$/)).toBeTruthy();
  });

  it("shows no host line for a block that names neither (R6 refuses such cards before they reach the owner)", () => {
    render(<Decisions decisions={[card(["Run:\n\n```sh\nls\n```"])]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    expect(screen.queryByText((_, el) => el?.tagName === "DIV" && /^On \S/.test(el.textContent ?? ""))).toBeNull();
    expect(screen.getByText("ls")).toBeTruthy();
  });

  it("accepts the same host names as the server: a plain name only (BOS-541)", () => {
    // The server's fenceWhere allows letters, digits, dot, dash and underscore, starting with a letter or digit.
    render(<Decisions decisions={[card(['Check it:\n\n```sh host="nas-01.home_lab" as="root"\nid\n```'])]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    expect(line(/^On nas-01\.home_lab, as root\.$/)).toBeTruthy();
    cleanup();
    // A host with a space is not one the server can name, so the app must not read it as one either.
    render(<Decisions decisions={[card(['Check it:\n\n```sh host="nas 01" as="root"\nid\n```'])]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    expect(screen.queryByText((_, el) => el?.tagName === "DIV" && /^On \S/.test(el.textContent ?? ""))).toBeNull();
  });
});
