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
  it("matches a role word by prefix: 'dev' finds Developer, 'man' finds Manager, 'wo' finds Worker", () => {
    expect(filterTeam(team, "QA", false, role, unread).map((t) => t.name)).toEqual(["Yaffle"]);
    expect(filterTeam(team, "ceo", false, role, unread).map((t) => t.name)).toEqual(["Radagast"]);
    expect(filterTeam(team, "dev", false, role, unread).map((t) => t.name)).toEqual(["Bungle"]);
    // The label is matched word by word: a multi-word title is found by the start of any of its words.
    expect(filterTeam(team, "Developer", false, role, unread).map((t) => t.name)).toEqual(["Bungle"]);
  });
  it("'man' finds Manager and 'wo' finds Worker, not a word merely containing them", () => {
    const wider = [
      { name: "Phoebe", role: "manager", unread: false },
      { name: "Zip", role: "worker", unread: false },
      { name: "Nomad", role: "ceo", unread: false },
    ];
    const r = (t: (typeof wider)[number]) => t.role;
    expect(filterTeam(wider, "man", false, r, unread).map((t) => t.name)).toEqual(["Phoebe"]);
    expect(filterTeam(wider, "wo", false, r, unread).map((t) => t.name)).toEqual(["Zip"]);
    expect(filterTeam(wider, "an", false, r, unread)).toEqual([]);
  });
  it("a PA is found by 'pa', though the API stores it as a worker", () => {
    const pa = { name: "Kit", role: "worker", duty: "assistant", unread: false };
    const isPa = (t: typeof pa) => (t.duty === "assistant" ? "PA" : t.role);
    expect(filterTeam([pa], "pa", false, isPa, unread).map((t) => t.name)).toEqual(["Kit"]);
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

describe("Chat team list filter, 5 agents and an open conversation", () => {
  it("narrows by name or role, shows the 2 unread, and leaves the open conversation alone", async () => {
    const reply = { role: "assistant", text: "Hi", createdAt: "2026-11-21T10:00:00Z" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/chat/threads")) {
          return json([
            thread("a1", "Radagast", "ceo", null),
            thread("a2", "Bungle", "worker", reply),
            thread("a3", "Zippy", "worker", null),
            thread("a4", "Yaffle", "worker", reply),
            thread("a5", "Kit", "worker", null),
          ]);
        }
        if (url.includes("/chat?")) return json({ agentId: "a1", state: "idle", items: [{ id: "m1", role: "assistant", text: "Open conversation text", createdAt: "2026-11-21T09:00:00Z" }] });
        return json([]);
      }),
    );
    render(<ChatPage companies={[company]} companyId="c1" agentId="a1" go={() => {}} onChanged={() => {}} />);
    const nav = () => within(screen.getByRole("navigation", { name: "Team" }));
    const box = await screen.findByRole("searchbox", { name: "Find a teammate" });
    await screen.findByText("Open conversation text");
    expect(nav().getAllByRole("link")).toHaveLength(5);
    fireEvent.change(box, { target: { value: "zip" } });
    expect(nav().getAllByRole("link").map((a) => a.textContent)).toEqual([expect.stringContaining("Zippy")]);
    fireEvent.change(box, { target: { value: "ceo" } });
    expect(nav().getAllByRole("link")).toHaveLength(1);
    fireEvent.change(box, { target: { value: "worker" } });
    expect(nav().getAllByRole("link")).toHaveLength(4);
    fireEvent.change(box, { target: { value: "wo" } });
    expect(nav().getAllByRole("link")).toHaveLength(4);
    fireEvent.change(box, { target: { value: "miles" } });
    expect(screen.getByText(/No one matches/)).toBeTruthy();
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.click(screen.getByRole("switch", { name: "Unread only" }));
    expect(nav().getAllByRole("link")).toHaveLength(2);
    fireEvent.change(box, { target: { value: "nobody" } });
    expect(screen.getByText(/No one matches/)).toBeTruthy();
    expect(screen.getByText("Open conversation text")).toBeTruthy();
    expect(nav().queryAllByRole("link")).toHaveLength(0);
  });
});

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
