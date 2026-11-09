// @vitest-environment jsdom
// BOS-784 / DR-045: the owner's text boxes that were the last raw <textarea>s now keep a draft, on the
// same rules as BOS-637: the draft is written as you type, it goes only once the server has taken the
// text, a failed send keeps it, and a restored draft is shown but never sent by itself.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company } from "../src/api";
import { Rules } from "../src/pages/Rules";
import { Skills } from "../src/pages/Skills";
import { Wiki } from "../src/pages/Wiki";
import { Ticket } from "../src/pages/Ticket";
import { Setup } from "../src/pages/Setup";
import { DraftTextarea } from "../src/components/DraftTextarea";
import { clearAllDrafts, readDraft, readDraftJson } from "../src/drafts";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
const company: Company = { id: "c1", name: "App Co", mission: null, paused: false, agents: [] };

beforeEach(() => clearAllDrafts());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  clearAllDrafts();
});

describe("DraftTextarea keeps and restores text (BOS-784 / DR-045)", () => {
  function Box({ k = "t/box", start = "" }: { k?: string; start?: string }) {
    const [v, setV] = useState(start);
    return <DraftTextarea draftKey={k} aria-label="box" value={v} onChange={setV} />;
  }

  it("starts from a kept draft and shows it, so a reload doesn't lose it", async () => {
    fireEvent.change(render(<Box />).getByLabelText("box"), { target: { value: "half a thought" } });
    expect(readDraft("t/box")).toBe("half a thought");
    cleanup();
    // A fresh mount (a reload) starts from the kept text, never blank.
    const box = render(<Box />).getByLabelText("box") as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe("half a thought"));
  });

  it("starts from the box's own text when nothing was kept", () => {
    const box = render(<Box start="existing instructions" />).getByLabelText("box") as HTMLTextAreaElement;
    expect(box.value).toBe("existing instructions");
  });

  it("refuses a box with no draft unless it gives a reason", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<DraftTextarea draftKey={null} value="" onChange={() => {}} />)).toThrow(/needs a draftKey/);
    spy.mockRestore();
  });
});

describe("the rules box keeps what you type until the CEO request is sent (BOS-784)", () => {
  it("keeps the text as it is typed, and clears it only after the server takes it", async () => {
    let sent: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("rule-requests")) {
          sent = "ok";
          return json({ ceo: { name: "Ada" } });
        }
        return json({ company: [], global: [], defaults: [] });
      }),
    );
    render(<Rules companies={[company]} companyId="c1" go={() => {}} />);
    const box = screen.getByLabelText("What should this rule do?") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Let agents read GitHub freely" } });
    expect(readDraft("rule-ask/c1")).toBe("Let agents read GitHub freely");
    fireEvent.click(screen.getByRole("button", { name: "Ask the CEO to draft it" }));
    await waitFor(() => expect(sent).toBe("ok"));
    expect(readDraft("rule-ask/c1")).toBe("");
    expect(box.value).toBe("");
  });

  it("keeps the text when the send fails, so it can be sent again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("rule-requests")) throw new TypeError("Failed to fetch");
        return json({ company: [], global: [], defaults: [] });
      }),
    );
    render(<Rules companies={[company]} companyId="c1" go={() => {}} />);
    const box = screen.getByLabelText("What should this rule do?") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Keep me on failure" } });
    fireEvent.click(screen.getByRole("button", { name: "Ask the CEO to draft it" }));
    await waitFor(() => expect(box.value).toBe("Keep me on failure"));
    expect(readDraft("rule-ask/c1")).toBe("Keep me on failure");
  });
});

describe("the skill edit box keeps what you type (BOS-784)", () => {
  it("saves the edited instructions and clears the draft", async () => {
    const row = { id: "s1", name: "web-fetch", description: "Fetch pages.", source: "written", sourceUrl: null, sourceRef: null, pack: null, packUrl: null, sizeBytes: 100, fileCount: 1, updatedAt: "2026-10-21T14:26:00Z", agents: [] };
    const calls: Array<{ method: string; body?: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
        if (url.endsWith("/skills/s1")) return init?.method === "PUT" ? json({ id: "s1" }) : json({ ...row, files: [{ path: "SKILL.md", size: 100, text: '---\nname: web-fetch\ndescription: "Fetch pages."\n---\n\n# Rules\n\nOne page per call.\n' }] });
        if (url.endsWith("/skills")) return json([row]);
        return json([]);
      }),
    );
    render(<Skills company={company} />);
    fireEvent.click((await screen.findByText("web-fetch", { selector: "a span" })).closest("a")!);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const body = screen.getByLabelText("Instructions, in Markdown") as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "# Rules\n\nTwo pages at most." } });
    expect(readDraft("skill-edit/s1")).toBe("# Rules\n\nTwo pages at most.");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls).toContainEqual({ method: "PUT", body: { name: "web-fetch", description: "Fetch pages.", body: "# Rules\n\nTwo pages at most." } }));
    await waitFor(() => expect(readDraft("skill-edit/s1")).toBe(""));
  });
});

describe("the wiki editor keeps a page draft (BOS-784)", () => {
  it("keeps the page text and restores it when the editor is reopened", async () => {
    const pages = [{ id: "w1", slug: "top", folder: "", title: "Top", ticketId: null, updatedAt: new Date().toISOString(), updatedBy: "Ada" }];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/wiki/top")) return json({ id: "w1", slug: "top", folder: "", title: "Top", body: "Hello", updatedAt: new Date().toISOString(), updatedBy: "Ada", revisions: [], tickets: [] });
        if (url.includes("/wiki")) return json(pages);
        return json([]);
      }),
    );
    render(<Wiki companies={[company]} companyId="c1" slug="top" go={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const body = (await screen.findByLabelText(/Page text, in Markdown/)) as HTMLTextAreaElement;
    fireEvent.change(body, { target: { value: "Hello, rewritten" } });
    // The whole page (title, folder, text) is kept as one form draft, so a reload brings it all back.
    await waitFor(() => expect(readDraftJson<{ body: string }>("wiki/c1/top")?.body).toBe("Hello, rewritten"));
    // Cancel keeps the draft on purpose; reopening brings it back.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    const again = await screen.findByLabelText(/Page text, in Markdown/) as HTMLTextAreaElement;
    await waitFor(() => expect(again.value).toBe("Hello, rewritten"));
  });
});

describe("the ticket send-back box keeps what you type (BOS-784)", () => {
  function showReviewTicket(post: (init?: RequestInit) => Response) {
    const at = new Date().toISOString();
    const ticket = { id: "t1", title: "Fix typo", systemState: "review", risk: "trivial", repoUrl: "https://github.com/Leonfinn/customer-app.git", defaultBranch: "main", branch: "bm/fix-typo", landing: "merge", verifyCommand: "pnpm test", ownerSignoff: false, projectId: "p1", project: "App", companyId: "c1", assignee: "Engineer", assigneeAgentId: "a1", createdAt: at, lastActivityAt: at, monitorAttempts: 0, monitorMax: 5 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/tickets/t1/review" && init?.method === "POST") return post(init);
        if (url === "/api/tickets/t1") return json(ticket);
        if (url === "/api/tickets/t1/reviews") return json([{ id: "r1", kind: "code", round: 1, seq: 0, status: "pending", reviewer: "Ada", notes: null, overruleReason: null }]);
        if (url.includes("/links")) return json({ waitsOn: [], blocks: [], blockedBy: [] });
        if (url.includes("/features")) return json({ features: [] });
        if (url.endsWith("/artifacts") || url.includes("/runs") || url.includes("risk") || url.includes("objectives")) return json([]);
        if (url.includes("/messages")) return json({ live: null, items: [] });
        return json({});
      }),
    );
    Element.prototype.scrollIntoView = () => {};
    render(<Ticket id="t1" companies={[company]} />);
  }

  it("writes the draft as you type, and keeps it when the send fails, so it can be sent again", async () => {
    showReviewTicket(() => {
      throw new TypeError("Failed to fetch");
    });
    fireEvent.click(await screen.findByRole("button", { name: "Request changes" }));
    const box = (await screen.findByLabelText("What should the agent change?")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Acceptance criteria: migration is expand-only fails." } });
    expect(readDraft("ticket-review-summary/t1")).toBe("Acceptance criteria: migration is expand-only fails.");
    fireEvent.click(screen.getByRole("button", { name: "Send it back" }));
    await waitFor(() => expect(box.value).toBe("Acceptance criteria: migration is expand-only fails."));
    expect(readDraft("ticket-review-summary/t1")).toBe("Acceptance criteria: migration is expand-only fails.");
  });

  it("clears the draft once the server takes the send-back", async () => {
    showReviewTicket(() => json({ landing: { state: "running", startedAt: new Date().toISOString(), command: "pnpm test", startedBy: "you" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Request changes" }));
    const box = (await screen.findByLabelText("What should the agent change?")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Please fix the failing criterion." } });
    fireEvent.click(screen.getByRole("button", { name: "Send it back" }));
    await waitFor(() => expect(readDraft("ticket-review-summary/t1")).toBe(""));
  });
});

describe("the setup mission box keeps what you type (BOS-784)", () => {
  it("saves the draft as it is typed, and clears it once the company is saved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "/api/companies" && init?.method === "POST") return json({ company: { id: "c1", name: "App Co", mission: "Build it", paused: false, agents: [] } });
        if (url === "/api/companies/c1" && init?.method === "PATCH") return json({ id: "c1", name: "App Co", mission: "Build it", paused: false, agents: [] });
        const body = url === "/api/setup-progress" ? { dismissed: false, step: 0, companyId: "c1" } : url.endsWith("/setup-checklist") || url.endsWith("/grants") || url === "/api/secrets" ? [] : { standard: [], none: { id: "none", label: "Nothing", command: "", needs: [] }, detected: [], tools: null, error: null };
        return json(body);
      }),
    );
    render(<Setup companies={[{ id: "c1", name: "App Co", mission: null, paused: false, agents: [] }]} go={() => {}} onChanged={() => {}} />);
    const box = (await screen.findByLabelText("What it's for")) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "Build and run Boss Man itself" } });
    expect(readDraft("setup-mission/c1")).toBe("Build and run Boss Man itself");
  });
});
