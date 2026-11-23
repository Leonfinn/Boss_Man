// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrumMasterLog } from "../src/components/ScrumMasterLog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const mk = (id: string, over: Record<string, unknown>) => ({ id, kind: "nudge", ticketId: "t" + id, reason: "r", actorName: "Scrum Master", createdAt: "2026-10-27T10:00:00Z", undoable: false, undoneAt: null, after: null, ...over });
const rows = [
  mk("1", { ticketRef: "BOS-123", reason: "Review looks stuck", issueKey: "k1", issueStatus: "open", issueLabel: "1st warning" }),
  mk("2", { ticketRef: "BOS-123", reason: "Asked Penfold for an update", targetName: "Penfold", issueKey: "k1", issueStatus: "open" }),
  mk("3", { ticketRef: "BOS-9", reason: "Nothing moved for a day" }),
];

describe("Scrum Master log filter", () => {
  it("narrows rows by ticket, agent or reason (every word), and says when nothing matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(rows)));
    render(<ScrumMasterLog companyId="c1" filterable />);
    const box = (await screen.findByLabelText("Filter")) as HTMLInputElement;
    await screen.findByText("Nothing moved for a day");

    fireEvent.change(box, { target: { value: "bos-123" } });
    expect(screen.getByText("Review looks stuck")).toBeTruthy();
    expect(screen.queryByText("Nothing moved for a day")).toBeNull();

    fireEvent.change(box, { target: { value: "PENFOLD update" } });
    expect(screen.getByText("Asked Penfold for an update")).toBeTruthy();
    expect(screen.queryByText("Review looks stuck")).toBeNull();

    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText("Nothing in the loaded log matches.")).toBeTruthy();

    fireEvent.change(box, { target: { value: "" } });
    expect(screen.getByText("Nothing moved for a day")).toBeTruthy();
    expect(screen.getByText("Review looks stuck")).toBeTruthy();
  });

  it("shows no box unless asked", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(rows)));
    render(<ScrumMasterLog companyId="c1" />);
    await screen.findByText("Nothing moved for a day");
    expect(screen.queryByLabelText("Filter")).toBeNull();
  });
});
