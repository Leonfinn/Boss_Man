// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WipLimits } from "../src/pages/Settings";
import type { Company } from "../src/api";

// BOS-1944: the in-progress limits and the merge / quick-check holds are one section with one Save, and that Save is
// muted until something changes.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const company = { id: "c1", holdStartsMergesWaiting: 20, holdStartsQuickChecksQueued: null } as unknown as Company;

describe("Tickets in progress section", () => {
  it("has one Save, muted until a field changes, and saves both endpoints together", async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method, body: init?.body as string | undefined });
        return json({ agent: 2, company: null, defaultAgent: 2 });
      }),
    );
    render(<WipLimits company={company} onChanged={() => {}} />);
    await screen.findByLabelText(/Tickets in progress, whole company/);
    const saves = screen.getAllByRole("button", { name: /^Save/ }) as HTMLButtonElement[];
    const save = saves[0]!;
    expect(saves).toHaveLength(1);
    expect(save.disabled).toBe(true);
    expect(save.className).not.toContain("primary");

    fireEvent.change(screen.getByLabelText(/whole company/), { target: { value: "5" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(save.className).toContain("primary");
    fireEvent.change(screen.getByLabelText(/whole company/), { target: { value: "" } });
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/quick checks are queued/), { target: { value: "7" } });
    fireEvent.click(save);
    await waitFor(() => expect(calls.some((c) => c.url.includes("/api/companies/c1") && c.method === "PATCH")).toBe(true));
    expect(calls.some((c) => c.url.includes("/api/wip-limits") && c.method === "PUT")).toBe(true);
    expect(calls.find((c) => c.method === "PATCH")!.body).toContain('"holdStartsQuickChecksQueued":7');
  });

  // BOS-2196: the third limit, cards that need the owner, saves with the same one Save and is off (null) when empty.
  it("saves the 'need you' limit with the other two, and an empty box sends null", async () => {
    const calls: { method?: string; body?: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push({ method: init?.method, body: init?.body as string | undefined });
        return json({ agent: 2, company: null, defaultAgent: 2 });
      }),
    );
    render(<WipLimits company={company} onChanged={() => {}} />);
    const box = (await screen.findByLabelText(/Hold new starts when this many need you/)) as HTMLInputElement;
    expect(box.value).toBe("");
    fireEvent.change(box, { target: { value: "5" } });
    fireEvent.click(screen.getAllByRole("button", { name: /^Save/ })[0]!);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    const body = JSON.parse(calls.find((c) => c.method === "PATCH")!.body!) as Record<string, unknown>;
    expect(body).toMatchObject({ holdStartsMergesWaiting: 20, holdStartsQuickChecksQueued: null, holdStartsOwnerWaiting: 5 });
  });
});
