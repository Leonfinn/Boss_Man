// BOS-2500: the deploy history's "Download CSV" rows and file name.
import { describe, expect, it } from "vitest";
import { deploysCsvName, deploysToCsv, type DeployHistoryRow } from "../src/pages/settings/Tools";

const row = (over: Partial<DeployHistoryRow["deploy"]>, agentName: string | null = "Zebedee", ticketRef: string | null = "BOS-1"): DeployHistoryRow => ({
  id: "d1",
  deploy: { id: "d1", ref: "main", commit: "abc1234def", notes: null, status: "succeeded", outcome: null, ticketId: "t1", tagName: "live", tagResult: "moved", createdAt: "2026-11-20T10:00:00.000Z", finishedAt: "2026-11-20T10:03:00.000Z", redeployOf: null, ...over },
  agentName,
  ticketRef,
});

describe("deploysToCsv", () => {
  it("writes the header and one line per deploy with plain status words and minutes", () => {
    const lines = deploysToCsv([row({}), row({ id: "d2", status: "rejected", finishedAt: null, outcome: "no, thanks", notes: "a,b", redeployOf: "d1" }, null, null)]).split("\r\n");
    expect(lines[0]).toBe("started_at,finished_at,minutes,ref,commit,status,outcome,redeploy_of,agent,ticket,tag,tag_result,notes");
    expect(lines[1]).toBe("2026-11-20T10:00:00.000Z,2026-11-20T10:03:00.000Z,3,main,abc1234def,succeeded,,,Zebedee,BOS-1,live,moved,");
    expect(lines[2]).toBe('2026-11-20T10:00:00.000Z,,,main,abc1234def,refused,"no, thanks",d1,,,live,moved,"a,b"');
  });
  it("is just the header when nothing is loaded", () => {
    expect(deploysToCsv([])).toBe("started_at,finished_at,minutes,ref,commit,status,outcome,redeploy_of,agent,ticket,tag,tag_result,notes\r\n");
  });
});

describe("deploysCsvName", () => {
  it("names the file by target and date", () => {
    expect(deploysCsvName("Staging box", new Date("2026-11-24T23:00:00Z"))).toBe("deploys-Staging-box-2026-11-24.csv");
    expect(deploysCsvName("///", new Date("2026-11-24T00:00:00Z"))).toBe("deploys-target-2026-11-24.csv");
  });
});
