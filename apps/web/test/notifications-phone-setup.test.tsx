// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotifySettings } from "../src/api";
import { Notifications } from "../src/pages/Notifications";

// BOS-995: the "Set up your phone" box on the Notifications page. jsdom does no layout, so this checks what the
// box says at a 360px phone window and that its long strings are set to wrap rather than push the page wide.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settings = (extra: Partial<NotifySettings>): NotifySettings => ({
  quietHours: null,
  agentHourlyCap: 6,
  ntfy: { url: "https://ntfy.example.ts.net:8443", topic: "bossman", hasToken: true },
  pushLevels: ["page", "ask"],
  publicUrl: null,
  ...extra,
});

function stub(s: NotifySettings, clipboard?: { writeText: (t: string) => Promise<void> }) {
  window.innerWidth = 360;
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(s), { status: 200, headers: { "content-type": "application/json" } }))));
  if (clipboard) Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
  else Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
}

describe("Set up your phone box", () => {
  it("shows the address, copy button, health link and login commands, wrapping long text", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stub(settings({ phoneAddress: "https://ntfy.example.ts.net:8443/", phoneContainer: "bossman-ntfy-1" }), { writeText });
    render(<Notifications feed={{ items: [], unread: 0 }} onChanged={() => {}} />);
    const address = await screen.findByTestId("phone-address");
    expect(address.textContent).toBe("https://ntfy.example.ts.net:8443");
    expect(address.style.wordBreak).toBe("break-all");
    fireEvent.click(screen.getByRole("button", { name: "Copy address" }));
    expect(writeText).toHaveBeenCalledWith("https://ntfy.example.ts.net:8443");
    const link = screen.getByRole("link", { name: /\/v1\/health/ });
    expect(link.getAttribute("href")).toBe("https://ntfy.example.ts.net:8443/v1/health");
    const cmds = screen.getByTestId("phone-login-commands");
    expect(cmds.textContent).toContain("docker exec -it bossman-ntfy-1 ntfy user add phone-read");
    expect(cmds.textContent).toContain("ntfy access phone-read bossman read-only");
    expect(cmds.style.wordBreak).toBe("break-all");
  });

  it("says it can't work out the address when the host reports none, and names a placeholder container", async () => {
    stub(settings({ phoneAddress: null, phoneContainer: null }));
    render(<Notifications feed={{ items: [], unread: 0 }} onChanged={() => {}} />);
    expect(await screen.findByText(/can't work out the address your phone needs/)).toBeTruthy();
    expect(screen.queryByTestId("phone-address")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
    expect(screen.queryByRole("link", { name: /v1\/health/ })).toBeNull();
    expect(screen.getByTestId("phone-login-commands").textContent).toContain("NTFY_CONTAINER");
  });

  it("tells the owner to copy by hand when the browser has no clipboard", async () => {
    stub(settings({ phoneAddress: "https://ntfy.example.ts.net:8443", phoneContainer: null }));
    render(<Notifications feed={{ items: [], unread: 0 }} onChanged={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy address" }));
    expect(await screen.findByText(/Couldn't copy/)).toBeTruthy();
  });
});
