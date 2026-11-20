// @vitest-environment jsdom
// BOS-1975: the "Waits on" panel says when it couldn't load, names each Remove button, uses plain words
// for the kind, shows milestone dates as "1 Dec" and can't send Add twice.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TicketLinks } from "../src/components/TicketLinks";
import type { TicketDetail } from "../src/api";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const t = { id: "t1", companyId: "c1", featureId: null, milestoneId: null } as unknown as TicketDetail;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const wait = (kind: string, title: string, n: number) => ({ dependencyId: `d${n}`, kind, id: `x${n}`, title, state: "ready", open: true, link: `#/tickets/x${n}` });
const links = (waitsOn: unknown[]) => ({ data: { waitsOn } as never, error: null, reload: () => {} });

describe("Ticket page: Waits on", () => {
  it("shows an alert when the links request failed, not 'Nothing.'", () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    render(<TicketLinks t={t} onChanged={() => {}} bare links={{ data: null, error: { message: "boom" }, reload: () => {} }} />);
    expect(screen.getByRole("alert").textContent).toBe("Couldn't load what this waits on.");
    expect(screen.queryByText("Nothing.")).toBeNull();
  });

  it("names each Remove button and uses plain words for the kind", () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([])));
    render(<TicketLinks t={t} onChanged={() => {}} bare links={links([wait("ticket", "Fix login", 1), wait("engagement", "Logo", 2), wait("decision", "Pick", 3)])} />);
    expect(screen.getByRole("button", { name: "Remove wait on Fix login" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove wait on Logo" })).toBeTruthy();
    expect(screen.getByText("Task")).toBeTruthy();
    expect(screen.getByText("Another company's work")).toBeTruthy();
    expect(screen.getByText("Your decision")).toBeTruthy();
    expect(screen.queryByText("engagement")).toBeNull();
  });

  it("formats the milestone date and sends Add only once on a double click", async () => {
    let posts = 0;
    let release: () => void = () => {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posts++;
          await new Promise<void>((r) => (release = r));
          return json({});
        }
        if (url.endsWith("/objectives")) return json([{ id: "o1", title: "Obj", status: "active", milestones: [{ id: "m1", title: "Launch", targetDate: "2026-12-01" }] }]);
        if (url.endsWith("/open-tickets")) return json([{ id: "b1", title: "Blocker", state: "ready", project: "P" }]);
        return json({ features: [] });
      }),
    );
    render(<TicketLinks t={t} onChanged={() => {}} bare links={links([])} />);
    expect((await screen.findByRole("option", { name: /^Launch \(.*\)$/ })).textContent).not.toContain("2026");
    fireEvent.focus(screen.getByLabelText("Make it wait on"));
    await screen.findByRole("option", { name: /Blocker/ });
    fireEvent.change(screen.getByLabelText("Make it wait on"), { target: { value: "b1" } });
    const add = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    fireEvent.click(add);
    fireEvent.click(add);
    await waitFor(() => expect(add.disabled).toBe(true));
    expect(posts).toBe(1);
    release();
  });
});
