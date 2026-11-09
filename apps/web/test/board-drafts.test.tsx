// @vitest-environment jsdom
// BOS-773: a reload or the "please reload" prompt must not take what the owner wrote in the New task
// / New feature form. The draft comes back when the form is opened again; it goes once the thing is
// created (or on Discard), and Cancel keeps it so a mis-click doesn't lose it.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Board } from "../src/pages/Board";
import { clearAllDrafts, readDraftJson } from "../src/drafts";

beforeEach(() => clearAllDrafts());
afterEach(() => {
  cleanup();
  clearAllDrafts();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

function stub(posts: Record<string, unknown>[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return json({ id: "t-new" });
      }
      if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
      if (url.endsWith("/board")) return json({ project: { id: "p1", companyId: "c1", name: "App" }, columns: [] });
      if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
      if (url.endsWith("/objectives")) return json([]);
      if (url.includes("/feedback-settings")) return json({ demandWeight: 1, ceoTriage: false, portalEnabled: false, portalToken: null, portalTitle: null, portalIntro: null, hasLogo: false, drivers: [], areas: [] });
      return json([]);
    }),
  );
  return posts;
}

const formKey = "new-task/c1/p1";
const open = async () => {
  render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
  fireEvent.click(await screen.findByRole("button", { name: "Add task" }));
  return (await screen.findByLabelText("Title")) as HTMLInputElement;
};

describe("New task form keeps its draft (BOS-773)", () => {
  it("saves every field as it is typed and brings them all back when the form is opened again", async () => {
    stub();
    const title = await open();
    fireEvent.change(title, { target: { value: "Fix the login freeze" } });
    const body = screen.getByLabelText("Description") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "It hangs after a wrong password." } });
    fireEvent.change(screen.getByLabelText(/Done when/), { target: { value: "Health check returns 200\nNo errors in the log" } });

    await waitFor(() => expect(readDraftJson<{ title: string }>(formKey)?.title).toBe("Fix the login freeze"));
    const kept = readDraftJson<{ body: string; criteria: string }>(formKey)!;
    expect(kept.body).toContain("hangs after a wrong password");
    expect(kept.criteria).toContain("Health check returns 200");

    // Open it again (a reload is a fresh mount that reads this browser's draft): everything is back.
    cleanup();
    const again = await open();
    expect(again.value).toBe("Fix the login freeze");
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toContain("hangs after a wrong password");
    expect((screen.getByLabelText(/Done when/) as HTMLTextAreaElement).value).toContain("Health check returns 200");
    // And it says so, with a way to discard it.
    expect(screen.getByText(/Draft restored/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard draft" })).toBeTruthy();
  });

  it("clears the draft once the task is created, so it can't be created twice", async () => {
    const posts = stub();
    const title = await open();
    fireEvent.change(title, { target: { value: "Add a health check" } });
    await waitFor(() => expect(readDraftJson(formKey)).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Add to backlog" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    await waitFor(() => expect(readDraftJson(formKey)).toBeNull());
  });

  it("keeps the draft on Cancel, and Discard throws it away", async () => {
    stub();
    const title = await open();
    fireEvent.change(title, { target: { value: "Half-written task" } });
    await waitFor(() => expect(readDraftJson(formKey)).not.toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    // Cancel just closes the form; the text is still kept.
    await waitFor(() => expect(screen.queryByLabelText("Title")).toBeNull());
    expect(readDraftJson<{ title: string }>(formKey)?.title).toBe("Half-written task");
    // Reopening brings it back, and Discard drops it for good.
    const again = await open();
    expect(again.value).toBe("Half-written task");
    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await waitFor(() => expect(readDraftJson(formKey)).toBeNull());
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("");
    expect(screen.queryByText(/Draft restored/)).toBeNull();
  });

  it("keeps each tab's own draft: a task and a feature don't overwrite each other", async () => {
    stub();
    const title = await open();
    fireEvent.change(title, { target: { value: "A task" } });
    await waitFor(() => expect(readDraftJson<{ title: string }>(formKey)?.title).toBe("A task"));
    // Switch to the feature tab and type there.
    fireEvent.click(screen.getByRole("radio", { name: "New feature" }));
    const featTitle = screen.getByLabelText("Title") as HTMLInputElement;
    expect(featTitle.value).toBe("");
    fireEvent.change(featTitle, { target: { value: "A feature" } });
    await waitFor(() => expect(readDraftJson<{ title: string }>("new-feature/c1/p1")?.title).toBe("A feature"));
    // The task's draft is untouched, and switching back brings it up.
    expect(readDraftJson<{ title: string }>(formKey)?.title).toBe("A task");
    fireEvent.click(screen.getByRole("radio", { name: "New task" }));
    await waitFor(() => expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("A task"));
  });

  it("a failed create keeps every word and says it wasn't saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") return new Response(JSON.stringify({ error: "Server is sick" }), { status: 500 });
        if (url.endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
        if (url.endsWith("/board")) return json({ project: { id: "p1", companyId: "c1", name: "App" }, columns: [] });
        if (url.endsWith("/features")) return json({ settings: { demandWeight: 1, ceoTriage: false }, drivers: [], maxDemand: 0, features: [] });
        return json([]);
      }),
    );
    const title = await open();
    fireEvent.change(title, { target: { value: "Kept on failure" } });
    fireEvent.click(screen.getByRole("button", { name: "Add to backlog" }));
    await screen.findByRole("alert");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Kept on failure");
    expect(readDraftJson<{ title: string }>(formKey)?.title).toBe("Kept on failure");
    expect(screen.getByRole("alert").textContent).toMatch(/wasn't saved as a task/);
  });
});
