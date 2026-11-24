import { describe, expect, it } from "vitest";
import { engagementsToCsv } from "../src/pages/Engagements";

// BOS-2492: the Engagements "Download CSV" of the rows shown.

const row = (over: Record<string, unknown>) => ({ id: "e1", title: "Logo", status: "in_progress", requester: "Acme", provider: "Pixel Co", budgetCapUsd: 20, stateSince: "2026-11-20T10:00:00.000Z", ...over });

describe("engagementsToCsv", () => {
  it("writes a header and one line per row, finished only for a finished row", () => {
    const csv = engagementsToCsv([
      row({}),
      row({ id: "e2", title: "Audit", status: "signed_off", budgetCapUsd: null, stateSince: "2026-11-22T09:30:00.000Z" }),
    ]);
    expect(csv.split("\r\n")).toEqual([
      "Title,Requester (asked),Provider (did the work),State,In this state since,Finished,Cap (USD)",
      "Logo,Acme,Pixel Co,In progress,2026-11-20T10:00:00.000Z,,20.00",
      "Audit,Acme,Pixel Co,Signed off,2026-11-22T09:30:00.000Z,2026-11-22T09:30:00.000Z,",
      "",
    ]);
  });
  it("quotes commas and quotes, and defuses a formula-looking title like the other downloads", () => {
    const csv = engagementsToCsv([row({ title: '=HYPERLINK("x"), now', status: "rejected" })]);
    expect(csv.split("\r\n")[1]).toBe(`"'=HYPERLINK(""x""), now",Acme,Pixel Co,Declined,2026-11-20T10:00:00.000Z,2026-11-20T10:00:00.000Z,20.00`);
  });
  it("writes only the header for no rows", () => {
    expect(engagementsToCsv([])).toBe("Title,Requester (asked),Provider (did the work),State,In this state since,Finished,Cap (USD)\r\n");
  });
});
