// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NtfySetupButton } from "../src/pages/Notifications";

// BOS-1581: the "Set up ntfy for me" button. The host makes the publish user and token; the page never gets the token.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stub(answers: unknown[]) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body ?? null });
      if (init?.method === "POST") return Promise.resolve(json({ id: "11111111-1111-4111-8111-111111111111" }));
      return Promise.resolve(json(answers.shift()));
    }),
  );
  return calls;
}

describe("NtfySetupButton", () => {
  it("says why it is off and offers no button when the host can't do it", () => {
    render(<NtfySetupButton available={false} why="The ntfy add-on is not set up on this host." onDone={() => {}} />);
    expect(screen.getByText(/The ntfy add-on is not set up on this host\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set up ntfy for me" })).toBeNull();
  });

  it("asks for setup, waits, tells the owner what happened and calls onDone, with no secret on the page", async () => {
    const calls = stub([{ status: "pending" }, { status: "done", result: "setup", message: "Made the publish user." }]);
    const onDone = vi.fn();
    render(<NtfySetupButton available pollMs={1} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up ntfy for me" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/Made the publish user\./)).toBeTruthy();
    expect(calls[0]).toEqual({ url: "/api/notification-settings/phone-login", method: "POST", body: JSON.stringify({ action: "setup" }) });
    expect(document.body.textContent).not.toMatch(/tk_/);
    // Safe to press again.
    expect((screen.getByRole("button", { name: "Set up ntfy for me" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows the host's reason when setup fails and does not call onDone", async () => {
    stub([{ status: "done", result: "failed", message: "Failed: ntfy could not add the user." }]);
    const onDone = vi.fn();
    render(<NtfySetupButton available pollMs={1} onDone={onDone} />);
    fireEvent.click(screen.getByRole("button", { name: "Set up ntfy for me" }));
    expect(await screen.findByText(/ntfy could not add the user/)).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });
});
