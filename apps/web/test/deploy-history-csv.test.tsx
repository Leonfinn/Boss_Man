// @vitest-environment jsdom
// BOS-2500: the deploy history's "Download CSV" rows and file name.
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { DeployTargets, deploysCsvName, deploysToCsv, type DeployHistoryRow } from "../src/pages/settings/Tools";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company: Company = { id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [] };
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

describe("Download CSV button", () => {
  async function openWith(all: DeployHistoryRow[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/deploys/summary")) return json({ days: 30, total: all.length, succeeded: 0, failedOrRejected: 0, medianSeconds: null, lastSuccessAt: null });
        if (url.startsWith("/api/deploys")) {
          const q = new URLSearchParams(url.split("?")[1]);
          const st = q.get("status");
          const before = q.get("before");
          let rows = [...all].sort((a, b) => b.deploy.id.localeCompare(a.deploy.id));
          if (st === "failed") rows = rows.filter((r) => r.deploy.status === "failed" || r.deploy.status === "rejected");
          if (before) rows = rows.filter((r) => r.deploy.id < before);
          return json(rows.slice(0, Number(q.get("limit"))));
        }
        return json(url.endsWith("/deploy-targets") ? [{ id: "t1", companyId: "c1", name: "Staging", kind: "ssh", endpoint: "deploy@example.com", isProduction: false, rules: {}, lastDeploy: null }] : []);
      }),
    );
    const saved: Blob[] = [];
    URL.createObjectURL = ((b: Blob) => (saved.push(b), "blob:x")) as typeof URL.createObjectURL;
    URL.revokeObjectURL = () => {};
    render(<DeployTargets company={company} />);
    const details = (await screen.findByText("Deploys")).closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    return { details, saved };
  }
  const mk = (n: number, status = "succeeded") => row({ id: `d${String(n).padStart(3, "0")}`, ref: `v${n}`, status });

  it("with the Failed filter on, the file holds only the failed rows", async () => {
    const { details, saved } = await openWith([mk(1), mk(2, "failed"), mk(3, "rejected")]);
    await within(details).findAllByRole("listitem");
    fireEvent.change(within(details).getByRole("combobox"), { target: { value: "failed" } });
    await vi.waitFor(() => expect(within(details).getAllByRole("listitem")).toHaveLength(2));
    fireEvent.click(within(details).getByRole("button", { name: "Download CSV" }));
    const lines = (await saved[0]!.text()).trim().split("\r\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain(",v3,");
    expect(lines[2]).toContain(",v2,");
    expect(lines.join("")).not.toContain(",v1,");
  });

  it("after Show older, the file holds both pages, newest first", async () => {
    const { details, saved } = await openWith(Array.from({ length: 25 }, (_, i) => mk(i + 1)));
    expect(await within(details).findAllByRole("listitem")).toHaveLength(20);
    fireEvent.click(within(details).getByRole("button", { name: "Show older" }));
    await vi.waitFor(() => expect(within(details).getAllByRole("listitem")).toHaveLength(25));
    fireEvent.click(within(details).getByRole("button", { name: "Download CSV" }));
    const lines = (await saved[0]!.text()).trim().split("\r\n");
    expect(lines).toHaveLength(26);
    expect(lines[1]).toContain(",v25,");
    expect(lines[25]).toContain(",v1,");
  });
});

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
  it("quotes notes holding quotes and line breaks", () => {
    const text = deploysToCsv([row({ notes: 'say "hi"\nthere' })]);
    expect(text).toContain('"say ""hi""\nthere"');
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
