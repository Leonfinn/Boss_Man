// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const copyText = vi.fn<(text: string) => Promise<boolean>>();
vi.mock("../src/clipboard", () => ({ copyText: (text: string) => copyText(text) }));

import { COPIED_MS, CopyLinkButton, pageLink } from "../src/components/CopyLinkButton";

beforeEach(() => {
  copyText.mockReset();
  window.location.hash = "#/tickets/abc-123";
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const button = () => screen.getByRole("button") as HTMLButtonElement;
const click = () => act(async () => void fireEvent.click(button()));

describe("pageLink (BOS-2233)", () => {
  it("is origin, path and hash route, without the query string", () => {
    expect(pageLink({ origin: "https://boss.example.com", pathname: "/", hash: "#/runs/r1" })).toBe("https://boss.example.com/#/runs/r1");
    window.history.replaceState(null, "", "/app/?x=1#/tickets/t9");
    expect(pageLink()).toBe(`${window.location.origin}/app/#/tickets/t9`);
  });
});

describe("CopyLinkButton (BOS-2233)", () => {
  it("copies the page's full address, says Copied, then goes back to Copy link", async () => {
    vi.useFakeTimers();
    copyText.mockResolvedValue(true);
    render(<CopyLinkButton />);
    expect(button().textContent).toBe("Copy link");
    await click();
    expect(copyText).toHaveBeenCalledWith(`${window.location.origin}${window.location.pathname}#/tickets/abc-123`);
    expect(button().textContent).toBe("Copied");
    expect(screen.getByRole("status").textContent).toBe("Link copied.");
    act(() => void vi.advanceTimersByTime(COPIED_MS));
    expect(button().textContent).toBe("Copy link");
  });

  it("shows the address, selected, when copying fails", async () => {
    copyText.mockResolvedValue(false);
    render(<CopyLinkButton />);
    await click();
    const field = screen.getByRole("textbox") as HTMLInputElement;
    expect(field.value).toBe(`${window.location.origin}${window.location.pathname}#/tickets/abc-123`);
    expect(field.readOnly).toBe(true);
    expect(document.activeElement).toBe(field);
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, field.value.length]);
    expect(screen.getByText(/Couldn't copy here/)).toBeTruthy();
    expect(button().textContent).toBe("Copy link");
  });

  it("clears its Copied timer on unmount, so nothing fires into a gone page (BOS-1783)", async () => {
    vi.useFakeTimers();
    copyText.mockResolvedValue(true);
    const { unmount } = render(<CopyLinkButton />);
    await click();
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing if the page is gone before the copy finishes", async () => {
    let finish: (ok: boolean) => void = () => {};
    copyText.mockReturnValue(new Promise((r) => (finish = r)));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<CopyLinkButton />);
    fireEvent.click(button());
    unmount();
    await act(async () => finish(true));
    expect(error).not.toHaveBeenCalled();
    error.mockRestore();
  });
});
