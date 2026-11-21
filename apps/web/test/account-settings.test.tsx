// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Account } from "../src/pages/Settings";

// The Account page (BOS-2159). Passwords here are made up.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const type = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("Account settings", () => {
  it("keeps Change password off until the new one is long enough and typed twice", () => {
    render(<Account />);
    const button = screen.getByRole("button", { name: "Change password" }) as HTMLButtonElement;
    type("Current password", "old made-up password");
    type("New password", "short");
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/Too short/)).toBeTruthy();
    type("New password", "a long enough new one");
    type("New password again", "something different");
    expect(button.disabled).toBe(true);
    expect(screen.getByText(/not the same/)).toBeTruthy();
    type("New password again", "a long enough new one");
    expect(button.disabled).toBe(false);
  });

  it("posts the change, says how many devices were signed out and clears the boxes", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => (calls.push({ url, body: JSON.parse(String(init?.body)) }), json({ ok: true, signedOut: 2 }))));
    render(<Account />);
    type("Current password", "old made-up password");
    type("New password", "a long enough new one");
    type("New password again", "a long enough new one");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText(/Password changed\. 2 other devices signed out\./)).toBeTruthy();
    expect(calls).toEqual([{ url: "/api/account/password", body: { currentPassword: "old made-up password", newPassword: "a long enough new one" } }]);
    expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe("");
  });

  it("shows the server's reason when the current password is wrong", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "wrong_current_password", message: "The current password is not right." }, 403)));
    render(<Account />);
    type("Current password", "wrong made-up password");
    type("New password", "a long enough new one");
    type("New password again", "a long enough new one");
    fireEvent.click(screen.getByRole("button", { name: "Change password" }));
    expect(await screen.findByText(/current password is not right/)).toBeTruthy();
  });

  it("signs out other devices with one press", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (calls.push(url), json({ ok: true, signedOut: 1 }))));
    render(<Account />);
    fireEvent.click(screen.getByRole("button", { name: "Sign out other devices" }));
    expect(await screen.findByText("1 other device signed out.")).toBeTruthy();
    expect(calls).toEqual(["/api/account/sign-out-others"]);
  });
});
