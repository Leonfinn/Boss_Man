// @vitest-environment jsdom
// BOS-1388: the portal asks for an email when "Confirm posts by email" is on, says why once, and the confirm page's words.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalApp } from "../src/pages/Portal";
import { CONFIRM_WORDS, confirmToken } from "../src/pages/PortalConfirm";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const feature = { id: "f1", title: "Dark mode", description: null, stage: "considering", myVote: null };

function stubPortal(page: object, onPost?: (url: string, body: Record<string, unknown>) => Response) {
  window.location.hash = "#tok";
  const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
        posts.push({ url, body });
        return onPost?.(url, body) ?? json({ ok: true });
      }
      return url === "/api/portal" ? json({ title: "What's next", intro: null, hasLogo: false, back: null, features: [feature], ...page }) : json({});
    }),
  );
  return posts;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("the portal with Confirm posts by email", () => {
  it("asks for an email before a vote, says why once, and then tells the visitor to check their inbox", async () => {
    const posts = stubPortal({ confirmByEmail: true, rememberedEmail: null }, () => json({ importance: "important", comment: null, needsConfirm: true }));
    render(<PortalApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Important" }));
    // Nothing is sent until the address is given.
    expect(posts).toHaveLength(0);
    // The vote's own question (the idea form below has an email box too).
    const email = (await waitFor(() => document.getElementById("v-f1-email"))) as HTMLInputElement;
    expect(email.required).toBe(true);
    expect(screen.getAllByText(/only to send you a link that confirms it's you/i).length).toBeGreaterThan(0);
    fireEvent.change(email, { target: { value: "visitor@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send my vote" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ featureId: "f1", importance: "important", email: "visitor@example.com" });
    expect((await screen.findByRole("status")).textContent).toMatch(/Check your email/);
  });

  it("requires the address on the idea form too", async () => {
    stubPortal({ confirmByEmail: true, rememberedEmail: null });
    render(<PortalApp />);
    expect(((await screen.findByLabelText("Your email")) as HTMLInputElement).required).toBe(true);
  });

  it("posts straight away in a browser that already confirmed its address, with no extra question", async () => {
    const posts = stubPortal({ confirmByEmail: true, rememberedEmail: "me@example.com" });
    render(<PortalApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Critical" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.body).toMatchObject({ importance: "critical", email: "me@example.com" });
    expect(screen.queryByRole("button", { name: "Send my vote" })).toBeNull();
  });

  it("is unchanged with the setting off: an optional email and no reason line", async () => {
    stubPortal({ confirmByEmail: false });
    render(<PortalApp />);
    expect(((await screen.findByLabelText(/Email, if you'd like to hear back/)) as HTMLInputElement).required).toBe(false);
    expect(screen.queryByText(/only to send you a link/i)).toBeNull();
  });
});

describe("the confirm page", () => {
  it("shows the plain words for each outcome", async () => {
    expect(await confirmToken("", vi.fn())).toBe("incomplete");
    expect(await confirmToken("t", vi.fn(async () => json({ ok: true })))).toBe("done");
    expect(await confirmToken("t", vi.fn(async () => json({ error: "not_found" }, 404)))).toBe("failed");
    expect(await confirmToken("t", vi.fn(async () => Promise.reject(new Error("offline"))))).toBe("failed");
    expect(CONFIRM_WORDS.failed.body).toMatch(/already been used, or it has run out/);
  });
});
