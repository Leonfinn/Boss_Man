// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Ticket } from "../src/pages/Ticket";

Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };
const at = new Date().toISOString();
const base = { id: "t1", title: "Fix typo", systemState: "in_progress", risk: "trivial", projectId: "p1", project: "App", companyId: "c1", assignee: "Engineer", assigneeAgentId: "a1", createdAt: at, lastActivityAt: at, monitorAttempts: 0, monitorMax: 5, body: "Original description", acceptanceCriteria: [] };

function show(ticket: Record<string, unknown>, onPatch: (body: Record<string, unknown>) => Response) {
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/tickets/t1" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        sent.push(body);
        return onPatch(body);
      }
      if (url === "/api/tickets/t1") return json(ticket);
      if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
      if (url.includes("/features")) return json({ features: [] });
      if (url.endsWith("/artifacts") || url.endsWith("/reviews") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
      if (url.includes("/messages")) return json({ live: null, items: [] });
      return json({});
    }),
  );
  render(<Ticket id="t1" companies={[company]} />);
  return sent;
}

describe("an owner's edit of a text field someone else changed (BOS-905)", () => {
  it("sends what the page loaded, keeps the draft and offers a reload when the save is refused", async () => {
    const sent = show(base, () => json({ error: "conflict", field: "body", message: "The description was changed by someone else after you opened it, so your save was refused and nothing was overwritten. Your edit is still here. Reload the ticket to see the latest, then save again if you still want your change." }, 409));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Description, in Markdown"), { target: { value: "The owner's new words" } });
    fireEvent.click(screen.getByRole("button", { name: "Save description" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/changed by someone else/);
    // What the page loaded went with the save, so the server could compare the edited field.
    expect(sent[0]).toMatchObject({ body: "The owner's new words", bodyLoaded: "Original description" });
    // The owner's typing is kept, and there is a way to bring in the latest.
    expect((screen.getByLabelText("Description, in Markdown") as HTMLTextAreaElement).value).toBe("The owner's new words");
    expect(screen.getByRole("button", { name: "Reload the latest" })).toBeTruthy();
  });

  it("clears the conflict and saves when nothing changed on the server", async () => {
    const sent = show(base, (body) => json({ ...base, body: body.body }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("Description, in Markdown"), { target: { value: "Done" } });
    fireEvent.click(screen.getByRole("button", { name: "Save description" }));
    await vi.waitFor(() => expect(sent.length).toBe(1));
    expect(sent[0]).toMatchObject({ bodyLoaded: "Original description" });
    expect(screen.queryByTestId("edit-conflict")).toBeNull();
  });
});
