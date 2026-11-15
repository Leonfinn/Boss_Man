// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SelfDeploy } from "../src/pages/Settings";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });

const TIP = "bbbbbbb2";
const DEPLOYED = "aaaaaaa1";

/** A merge subject the way Boss Man writes it (BOS-213): `Merge "<ticket title>" (<ticket id>)`. */
const merge = (title: string, id: string) => ({ sha: id.slice(0, 8), subject: `Merge "${title}" (${id})` });
const ticketId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const view = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  pending: false,
  status: null,
  available: { tip: TIP, deployed: DEPLOYED, checkedAt: "2026-11-09T06:00:00.000Z", commits: [], ...over },
  deployer: { reportedAt: "2026-11-09T06:00:00.000Z", late: false },
});

const stub = (v: unknown) => vi.stubGlobal("fetch", vi.fn(async (url: string) => (url.endsWith("/api/self-deploy") ? json(v) : json([]))));

describe("Settings → Updates lists the changes waiting to go live (BOS-875)", () => {
  it("shows the ticket titles of the waiting merges, newest first, counting them", async () => {
    stub(
      view({
        commits: [merge("Newest change", ticketId(3)), merge("Middle change", ticketId(2)), merge("Oldest change", ticketId(1))],
      }),
    );
    render(<SelfDeploy go={() => {}} />);
    expect(await screen.findByText("3 changes waiting:")).toBeTruthy();
    const items = within(screen.getByTestId("waiting-changes")).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toEqual(["Newest change", "Middle change", "Oldest change"]);
    // No commit hashes anywhere in the list.
    expect(items.every((t) => !/[0-9a-f]{7,}/.test(t ?? ""))).toBe(true);
  });

  it("lists at most five (BOS-1238), says how many more, and leaves non-merge commits out", async () => {
    const merges = Array.from({ length: 12 }, (_, i) => merge(`Change ${i + 1}`, ticketId(i + 1)));
    // A non-merge commit (a plain subject) sits among them and must not appear.
    const commits = [...merges.slice(0, 6), { sha: "deadbeef", subject: "plain commit, not a merge" }, ...merges.slice(6)];
    stub(view({ commits }));
    render(<SelfDeploy go={() => {}} />);
    expect(await screen.findByText("12 changes waiting:")).toBeTruthy();
    const items = within(screen.getByTestId("waiting-changes")).getAllByRole("listitem").map((li) => li.textContent);
    expect(items).toHaveLength(5);
    expect(items[0]).toBe("Change 1");
    expect(items[4]).toBe("Change 5");
    expect(screen.getByText("and 7 more")).toBeTruthy();
    expect(screen.queryByText("plain commit, not a merge")).toBeNull();
  });

  it("opens each waiting change's ticket from its title (BOS-883)", async () => {
    stub(view({ commits: [merge("Newest change", ticketId(3)), merge("Oldest change", ticketId(1))] }));
    render(<SelfDeploy go={() => {}} />);
    await screen.findByText("2 changes waiting:");
    const links = within(screen.getByTestId("waiting-changes")).getAllByRole("link");
    expect(links.map((a) => a.textContent)).toEqual(["Newest change", "Oldest change"]);
    expect(links.map((a) => a.getAttribute("href"))).toEqual([`#/tickets/${ticketId(3)}`, `#/tickets/${ticketId(1)}`]);
  });

  it("shows a waiting change as plain text when the brackets hold no ticket id (BOS-883)", async () => {
    stub(view({ commits: [{ sha: "ccccccc3", subject: 'Merge "No ticket here" (00000000-0000-4000-8000-00000000000z)' }] }));
    render(<SelfDeploy go={() => {}} />);
    await screen.findByText("1 change waiting:");
    const items = within(screen.getByTestId("waiting-changes")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["No ticket here"]);
    expect(within(items[0]!).queryByRole("link")).toBeNull();
  });

  it("reads the id from the last brackets when the title has its own (BOS-883)", async () => {
    stub(view({ commits: [merge("Fix the board (again)", ticketId(7))] }));
    render(<SelfDeploy go={() => {}} />);
    await screen.findByText("1 change waiting:");
    const [link] = within(screen.getByTestId("waiting-changes")).getAllByRole("link");
    expect(link!.textContent).toBe("Fix the board (again)");
    expect(link!.getAttribute("href")).toBe(`#/tickets/${ticketId(7)}`);
  });

  it("says the update changes the runners when runnerChanged is true, and not otherwise", async () => {
    stub(view({ runnerChanged: true, commits: [merge("Only change", ticketId(1))] }));
    const { unmount } = render(<SelfDeploy go={() => {}} />);
    const line = await screen.findByText(/This one also needs a runner update: after it goes in, press Build and update runners under Other actions\./);
    expect(line.textContent).toContain("Pages keep working while it goes in");
    unmount();

    stub(view({ runnerChanged: false }));
    render(<SelfDeploy go={() => {}} />);
    await screen.findByRole("button", { name: "Review and deploy" });
    expect(screen.queryByText(/also needs a runner update/)).toBeNull();
  });

  it("says nothing about runners when an older server leaves runnerChanged out", async () => {
    stub(view({ commits: undefined }));
    render(<SelfDeploy go={() => {}} />);
    await screen.findByRole("button", { name: "Review and deploy" });
    expect(screen.queryByText(/also needs a runner update/)).toBeNull();
  });

  it("shows the section as today when an older server sends no commits", async () => {
    stub(view());
    render(<SelfDeploy go={() => {}} />);
    expect((await screen.findByTestId("update-tag")).textContent).toBe("Update ready");
    expect(screen.getByTestId("update-say").textContent).toBe("A server update is ready.");
    expect(screen.queryByText(/changes waiting/)).toBeNull();
    expect(screen.queryByText(/and \d+ more/)).toBeNull();
    expect(screen.getByRole("button", { name: "Review and deploy" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Build and update runners" })).toBeTruthy();
  });

  it("shows no waiting list when main is up to date", async () => {
    stub(view({ deployed: TIP, commits: [merge("Already live", ticketId(1))] }));
    render(<SelfDeploy go={() => {}} />);
    expect((await screen.findByTestId("update-tag")).textContent).toBe("Up to date");
    expect(screen.queryByText("1 change waiting:")).toBeNull();
    expect(screen.queryByText("Already live")).toBeNull();
  });
});
