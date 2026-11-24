// @vitest-environment jsdom
// BOS-2491: the Scrum Master log's "Undone only" switch and "Download CSV" of the entries shown.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScrumMasterLog, actionsToCsv, type SmAction } from "../src/components/ScrumMasterLog";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const mk = (id: string, over: Partial<SmAction>): SmAction => ({ id, kind: "nudge", ticketId: "t" + id, reason: "r " + id, actorName: "Scrum Master", createdAt: "2026-10-27T10:00:00Z", undoable: true, undoneAt: null, after: null, ticketRef: "BOS-" + id, ...over });
const data = [
  mk("1", { reason: "Kept, one" }),
  mk("2", { reason: "Was undone", undoneAt: "2026-10-27T11:00:00Z" }),
  mk("3", { reason: "Undone and other", undoneAt: "2026-10-27T12:00:00Z", recorded: true, targetName: "Penfold" }),
];
const stub = () => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } })));

describe("actionsToCsv", () => {
  it("writes the eight columns with ISO times and a blank undone time", () => {
    const [head, a, , c] = actionsToCsv(data).split("\r\n");
    expect(head).toBe("time,kind,ticket,agent,target,reason,recorded_only,undone_at");
    expect(a).toBe('2026-10-27T10:00:00.000Z,nudge,t1,Scrum Master,,"Kept, one",no,');
    expect(actionsToCsv([mk("4", { reason: 'said "hi", twice' })]).split("\r\n")[1]).toContain('"said ""hi"", twice"');
    expect(c).toBe("2026-10-27T10:00:00.000Z,nudge,t3,Scrum Master,Penfold,Undone and other,yes,2026-10-27T12:00:00.000Z");
  });
});

describe("Undone only and Download CSV", () => {
  it("shows only undone entries, combines with the text filter, and downloads what is shown", async () => {
    stub();
    let saved: Blob | null = null;
    URL.createObjectURL = ((b: Blob) => ((saved = b), "blob:x")) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    const click = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};
    try {
      render(<ScrumMasterLog companyId="c1" filterable />);
      await screen.findByText("Kept, one");
      fireEvent.click(screen.getByLabelText("Undone only"));
      expect(screen.queryByText("Kept, one")).toBeNull();
      expect(screen.getByText("Was undone")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "zzz" } });
      expect(screen.getByText("Nothing in the loaded log matches.")).toBeTruthy();
      fireEvent.change(screen.getByLabelText("Filter"), { target: { value: "other" } });
      expect(screen.queryByText("Was undone")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
      await waitFor(() => expect(saved).not.toBeNull());
      const text = await (saved as unknown as Blob).text();
      expect(text).toContain("Undone and other");
      expect(text).not.toContain("Was undone");
      expect(text).not.toContain("Kept, one");
    } finally {
      HTMLAnchorElement.prototype.click = click;
    }
  });

  it("is absent on the folded view and when not filterable", async () => {
    stub();
    render(<ScrumMasterLog companyId="c1" ticketId="t1" folded filterable />);
    await screen.findByText(/Scrum Master/);
    expect(screen.queryByLabelText("Undone only")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
  });
});
