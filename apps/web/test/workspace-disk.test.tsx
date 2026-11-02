// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { WorkspaceDisk } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const company = (over: Partial<Company> = {}): Company => ({ id: "c1", name: "Boss Man Co", mission: null, paused: false, agents: [], ...over });
const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

function stub() {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return json({ id: "c1", diskCapBytes: 60 * 1024 ** 3 });
    }),
  );
  return calls;
}

describe("workspace disk cap setting (BOS-274)", () => {
  it("shows the server default and saves a new cap in GB", async () => {
    const calls = stub();
    render(<WorkspaceDisk company={company({ diskCapBytes: null })} onChanged={() => {}} />);
    expect(screen.getByText("Currently the server default, 20 GB.")).toBeTruthy();
    const input = screen.getByLabelText("Disk cap (GB)") as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await vi.waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toBeTruthy());
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/companies/c1", body: { diskCapGb: 60 } });
    expect(await screen.findByText("Saved. It applies at the next hourly clean-up.")).toBeTruthy();
  });

  it("shows the current cap when one is set", () => {
    stub();
    render(<WorkspaceDisk company={company({ diskCapBytes: 60 * 1024 ** 3 })} onChanged={() => {}} />);
    expect((screen.getByLabelText("Disk cap (GB)") as HTMLInputElement).value).toBe("60");
    expect(screen.getByText("Currently 60.0 GB.")).toBeTruthy();
  });

  it("refuses a cap that isn't a whole number of gigabytes", () => {
    stub();
    render(<WorkspaceDisk company={company()} onChanged={() => {}} />);
    fireEvent.change(screen.getByLabelText("Disk cap (GB)"), { target: { value: "2.5" } });
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
