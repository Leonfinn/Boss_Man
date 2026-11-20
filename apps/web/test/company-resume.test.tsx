// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RightNow } from "../src/components/DashboardPanels";
import { CompanyPause } from "../src/pages/settings/Team";
import type { Company } from "../src/api";

// BOS-2120: a paused company can be resumed from the Dashboard notice and from Settings → Team.
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Resume a paused company", () => {
  it("the Dashboard notice's Resume button calls onResume and links to the Team tab", async () => {
    const onResume = vi.fn(async () => {});
    render(<RightNow lines={[]} paused companyId="c1" onResume={onResume} />);
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe("#/settings/c1/team");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(1));
  });

  it("the Dashboard notice shows the failure message and the button works again", async () => {
    const onResume = vi.fn(async () => {
      throw new Error("The server could not resume.");
    });
    render(<RightNow lines={[]} paused companyId="c1" onResume={onResume} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect((await screen.findByRole("alert")).textContent).toContain("The server could not resume.");
    expect((screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the Team control shows the failure message when the server refuses", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "internal_error" }), { status: 500, headers: { "content-type": "application/json" } })));
    const onChanged = vi.fn();
    render(<CompanyPause company={{ id: "c1", name: "Co", mission: null, paused: true, agents: [] } as Company} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume company" }));
    expect((await screen.findByRole("alert")).textContent).not.toBe("");
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("the Team control posts paused:false to the company's pause endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ paused: false }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<CompanyPause company={{ id: "c1", name: "Co", mission: null, paused: true, agents: [] } as Company} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Resume company" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/api/companies/c1/pause");
    expect(JSON.parse(String(init.body))).toEqual({ paused: false });
  });
});
