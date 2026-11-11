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
  ageReason: "",
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

describe("labelled fences render as command blocks, wherever they sit (BOS-550)", () => {
  it("shows a labelled fence inside a numbered list item as a command with its Copy button, and no raw fence text", async () => {
    setSecure(true);
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const step = "1. Read the deployer folder from your settings file:\n   ```sh host=\"app01\" as=\"root\"\n   D=$(sed -n 's/^DEPLOYER=//p' .env)\n   ```";
    const { container } = render(<Decisions decisions={[card([step])]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    expect(line(/^On app01, as root\.$/)).toBeTruthy();
    expect(container.querySelector("[data-steps]")!.textContent).not.toMatch(/```|host=|as="/);
    fireEvent.click(screen.getByRole("button", { name: "Copy this command" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("D=$(sed -n 's/^DEPLOYER=//p' .env)"));
  });

  it("a 'Ready to use' card shows no raw fence anywhere: its question's copy of the steps is not shown as text", () => {
    // raiseOwnerSetup writes the steps into the question as "1. <step>" lines as well as into context.steps.
    const steps = ["Turn it on:\n```sh host=\"app01\" as=\"root\"\nsystemctl start thing\n```", "Settings → Thing → Save"];
    const d: Decision = { ...card(steps), question: `"Thing" is live. To start using it:\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join("\n")}`, options: ["Done"], context: { type: "owner_setup", steps } };
    const { container } = render(<Decisions decisions={[d]} companies={[company]} loaded agentsWorking={0} onAnswered={vi.fn()} />);
    expect(container.textContent).not.toMatch(/```|host=|as="/);
    expect(screen.getByText(/"Thing" is live\. To start using it:/)).toBeTruthy();
    expect(line(/^On app01, as root\.$/)).toBeTruthy();
    expect(screen.getAllByText("systemctl start thing")).toHaveLength(1);
  });
});
