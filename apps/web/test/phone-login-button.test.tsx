// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneLoginButton } from "../src/pages/settings/Notifications";

// BOS-1004: the "Create phone login" button. The password shows once, in a box that drops it when dismissed.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PW_ONE = ["sample", "fake", "pw"].join("-").padEnd(24, "x");
const PW_TWO = ["sample", "other", "pw"].join("-").padEnd(24, "y");
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function stub(answers: unknown[]) {
  const calls: Array<{ url: string; method: string; body: string | null }> = [];
  const fetchMock = vi.fn((url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ?? null });
    if (init?.method === "POST") return Promise.resolve(json({ id: "11111111-1111-4111-8111-111111111111" }));
    const next = answers.shift();
    return Promise.resolve(next instanceof Response ? next : json(next));
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

describe("PhoneLoginButton", () => {
  it("says why it is off when the host can't do it, and offers no button", () => {
    render(<PhoneLoginButton available={false} why="The ntfy add-on is not set up on this host." />);
    expect(screen.getByText(/The ntfy add-on is not set up on this host\./)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create phone login" })).toBeNull();
  });

  it("asks for create, waits, shows the password once with a warning, and drops it when dismissed", async () => {
    const calls = stub([{ status: "pending" }, { status: "done", result: "created", password: PW_ONE, user: "phone-read" }]);
    render(<PhoneLoginButton available pollMs={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Create phone login" }));
    const pw = await screen.findByTestId("phone-login-password");
    expect(pw.textContent).toBe(PW_ONE);
    expect(screen.getByText(/only time it is shown/)).toBeTruthy();
    expect(calls[0]).toEqual({ url: "/api/notification-settings/phone-login", method: "POST", body: JSON.stringify({ action: "create" }) });
    expect(calls[1]!.url).toBe("/api/notification-settings/phone-login/11111111-1111-4111-8111-111111111111");
    fireEvent.click(screen.getByRole("button", { name: "I've saved it" }));
    expect(screen.queryByTestId("phone-login-password")).toBeNull();
    expect(document.body.textContent).not.toContain(PW_ONE);
  });

  it("copies the password to the clipboard on request", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    stub([{ status: "done", result: "reset", password: PW_TWO, user: "phone-read" }]);
    render(<PhoneLoginButton available pollMs={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await screen.findByTestId("phone-login-password");
    fireEvent.click(screen.getByRole("button", { name: "Copy password" }));
    expect(writeText).toHaveBeenCalledWith(PW_TWO);
  });

  it("offers Reset password when the user already exists, and Create when it is missing", async () => {
    stub([{ status: "done", result: "exists", message: "The user phone-read already exists. Reset its password to get a new one." }]);
    render(<PhoneLoginButton available pollMs={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Create phone login" }));
    await screen.findByText(/already exists/);
    expect(screen.getAllByRole("button", { name: "Reset password" }).length).toBeGreaterThan(0);
    cleanup();
    stub([{ status: "done", result: "missing", message: "The user phone-read does not exist yet. Create it first." }]);
    render(<PhoneLoginButton available pollMs={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));
    await waitFor(() => expect(screen.getByText(/does not exist yet/)).toBeTruthy());
    expect(screen.getAllByRole("button", { name: "Create phone login" }).length).toBeGreaterThan(1);
  });

  it("shows a failure and a timeout as plain messages, never a password", async () => {
    stub([{ status: "done", result: "failed", message: "Failed: ntfy could not add the user." }]);
    render(<PhoneLoginButton available pollMs={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Create phone login" }));
    await screen.findByText(/ntfy could not add the user/);
    expect(screen.queryByTestId("phone-login-password")).toBeNull();
    cleanup();
    stub([{ status: "timeout", message: "The host did not answer in time." }]);
    render(<PhoneLoginButton available pollMs={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Create phone login" }));
    await screen.findByText(/did not answer in time/);
  });
});
