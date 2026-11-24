// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { filterTeam } from "../src/chat-team-filter";
import { ChatPage } from "../src/pages/Chat";

// BOS-2490: "Find a teammate" and "Unread only" on Chat's team list.
Element.prototype.scrollIntoView = () => {};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const team = [
  { name: "Radagast", role: "CEO", unread: false },
  { name: "Bungle", role: "Web Developer", unread: true },
  { name: "Yaffle", role: "QA", unread: true },
];
const role = (t: (typeof team)[number]) => t.role;
const unread = (t: (typeof team)[number]) => t.unread;

describe("filterTeam", () => {
  it("matches name or role, ignoring case, and keeps order", () => {
    expect(filterTeam(team, "  BUN", false, role, unread).map((t) => t.name)).toEqual(["Bungle"]);
    expect(filterTeam(team, "developer", false, role, unread).map((t) => t.name)).toEqual(["Bungle"]);
    expect(filterTeam(team, "", false, role, unread).map((t) => t.name)).toEqual(["Radagast", "Bungle", "Yaffle"]);
  });
  it("narrows to unread, and combines with the text", () => {
    expect(filterTeam(team, "", true, role, unread).map((t) => t.name)).toEqual(["Bungle", "Yaffle"]);
    expect(filterTeam(team, "qa", true, role, unread).map((t) => t.name)).toEqual(["Yaffle"]);
    expect(filterTeam(team, "radagast", true, role, unread)).toEqual([]);
  });
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company = { id: "c1", name: "App Co", agents: [] } as unknown as Company;
const thread = (id: string, name: string, role: string, last: unknown) => ({ id, name, role, duty: null, state: "idle", last });

describe("Chat team list filter", () => {
  it("filters, says No one matches with Clear, and Unread only shows the dot rows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/chat/threads")) {
          return json([
            thread("a1", "Radagast", "ceo", null),
            thread("a2", "Bungle", "worker", { role: "assistant", text: "Done", createdAt: "2026-11-21T10:00:00Z" }),
          ]);
        }
        return json([]);
      }),
    );
    render(<ChatPage companies={[company]} companyId="c1" agentId={undefined} go={() => {}} onChanged={() => {}} />);
    const box = await screen.findByRole("searchbox", { name: "Find a teammate" });
    expect(within(screen.getByRole("navigation", { name: "Team" })).getAllByRole("link")).toHaveLength(2);
    fireEvent.click(screen.getByRole("switch", { name: "Unread only" }));
    expect(within(screen.getByRole("navigation", { name: "Team" })).getAllByRole("link")).toHaveLength(1);
    expect(within(screen.getByRole("navigation", { name: "Team" })).getByRole("link").textContent).toContain("Bungle");
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText(/No one matches/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(within(screen.getByRole("navigation", { name: "Team" })).getAllByRole("link")).toHaveLength(2);
    expect((box as HTMLInputElement).value).toBe("");
  });
});
