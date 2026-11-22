// @vitest-environment jsdom
// BOS-2185: "Permissions in this run" on the Run page, in plain words.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Run } from "../src/pages/Run";
import { permissionAnsweredBy, permissionOutcome, permissionRule } from "../src/permissions-in-run";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company = { id: "c1", name: "App Co", agents: [] } as unknown as Company;
const row = (o: object) => ({ id: "x", at: "2026-01-05T10:00:00Z", title: "Bash: ls", kind: "execute", rule: "Read-only shell", position: 3, outcome: "allow", tier: "allow", answeredBy: null, answeredAt: null, ...o });
function stub(entries: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      new Response(
        JSON.stringify(
          url.includes("/permissions")
            ? { entries, truncated: false }
            : url.includes("/transcript")
              ? { run: { id: "r1", companyId: "c1", agent: "Ada", agentId: "a1", ticketId: null, ticket: null, startedAt: "2026-01-05T10:00:00Z", endedAt: "2026-01-05T11:00:00Z" }, items: [], next: 0, more: false }
              : [],
        ),
        { status: 200 },
      ),
    ),
  );
}

describe("permissions in this run (BOS-2185)", () => {
  it("says so when the run had no permission checks", async () => {
    stub([]);
    render(<Run runId="r1" companies={[company]} />);
    expect(await screen.findByText("No permission checks in this run.")).toBeTruthy();
  });
  it("lists a row per decision in plain words", async () => {
    stub([row({}), row({ id: "y", title: "Bash: make", rule: "Anything else", position: 0, outcome: "owner", tier: "owner", answeredBy: "owner" })]);
    render(<Run runId="r1" companies={[company]} />);
    expect(await screen.findByText("Bash: make")).toBeTruthy();
    expect(screen.getByText("Allowed")).toBeTruthy();
    expect(screen.getByText("Asked you")).toBeTruthy();
    expect(screen.getByText("no rule: asked")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
  });
  it("wording helpers", () => {
    expect(permissionOutcome({ outcome: "deny", tier: "deny" })).toBe("Refused");
    expect(permissionOutcome({ outcome: "ceo", tier: "ceo" })).toBe("Asked the CEO");
    // A paused CEO: the rule said ceo, the card went to the owner.
    expect(permissionOutcome({ outcome: "ceo", tier: "owner" })).toBe("Asked you");
    expect(permissionRule({ rule: "R", position: 2, outcome: "allow", tier: "allow" })).toBe("R");
    expect(permissionAnsweredBy({ tier: "ceo", answeredBy: null })).toBe("Not answered yet");
    expect(permissionAnsweredBy({ tier: "allow", answeredBy: null })).toBe("");
  });
});
