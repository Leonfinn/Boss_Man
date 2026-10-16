// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Auth } from "../src/pages/Auth";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const fill = () => {
  fireEvent.change(screen.getByLabelText("Username"), { target: { value: "leon" } });
  fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery" } });
  fireEvent.click(screen.getByRole("button", { name: "Log in" }));
};

describe("login", () => {
  it("shows the logo and passes the lockout message through (R45)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "too_many_attempts", message: "Too many failed logins. Try again in 15 minutes." }), { status: 429 })));
    render(<Auth firstRun={false} onDone={() => {}} />);
    expect(screen.getByRole("img", { name: "Boss Man, the AI agent manager" })).toBeTruthy();
    fill();
    expect((await screen.findByRole("alert")).textContent).toBe("Too many failed logins. Try again in 15 minutes.");
  });

  it("logs in", async () => {
    const onDone = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ username: "leon" }), { status: 200 })));
    render(<Auth firstRun={false} onDone={onDone} />);
    fill();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledWith("leon"));
  });
});
