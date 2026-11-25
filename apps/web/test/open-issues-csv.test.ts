// The Scrum Master log's "Download CSV": one line per open warning, in the order shown.
import { describe, expect, it } from "vitest";
import type { OpenIssue } from "../src/components/OpenIssues";
import { openIssuesCsv } from "../src/components/OpenIssues";

const issue = (over: Partial<OpenIssue> = {}): OpenIssue => ({
  id: "i1",
  source: "flag",
  ticketId: "t1",
  ticketRef: "BOS-1",
  ticketTitle: "Fix the merge",
  warning: "Stuck in review",
  rule: null,
  holder: "owner",
  since: "2026-11-23T09:00:00Z",
  done: [],
  nextAt: null,
  nextText: "Checks again",
  openedAt: "2026-11-23T08:00:00Z",
  ...over,
});

describe("openIssuesCsv", () => {
  it("writes the header and one line per warning, with who holds it and what was done", () => {
    const lines = openIssuesCsv([
      issue(),
      issue({
        id: "i2",
        source: "alert",
        ticketRef: null,
        ticketTitle: "Old alert",
        warning: "Waiting",
        holder: "scrum_master",
        since: "2026-11-23T10:00:00Z",
        done: [{ label: "Nudged", reason: "asked", at: "2026-11-23T11:00:00Z" }],
        nextText: "Nothing yet",
        nextAt: "2026-11-24T09:00:00Z",
      }),
    ]).split("\r\n");
    expect(lines).toEqual([
      "ticket,title,warning,with,since,done so far,next,next at",
      "BOS-1,Fix the merge,Stuck in review,you,2026-11-23T09:00:00Z,,Checks again,",
      ",Old alert,Waiting,Scrum Master,2026-11-23T10:00:00Z,Nudged at 2026-11-23T11:00:00Z: asked,Nothing yet,2026-11-24T09:00:00Z",
      "",
    ]);
  });

  it("writes just the header when nothing is open", () => {
    expect(openIssuesCsv([])).toBe("ticket,title,warning,with,since,done so far,next,next at\r\n");
  });

  it("quotes a title holding a comma and a quote", () => {
    expect(openIssuesCsv([issue({ ticketTitle: 'Fix the, "thing"' })])).toContain(',"Fix the, ""thing""",');
  });
});
