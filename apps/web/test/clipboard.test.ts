// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyMessage, copyText, selectText } from "../src/clipboard";

const defineExec = (impl: typeof document.execCommand) => {
  const spy = vi.fn(impl);
  Object.defineProperty(document, "execCommand", { configurable: true, writable: true, value: spy });
  return spy;
};

const setSecure = (secure: boolean) => Object.defineProperty(window, "isSecureContext", { configurable: true, value: secure });
const setClipboard = (clipboard: unknown) => Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });

afterEach(() => {
  vi.restoreAllMocks();
  setSecure(true);
  setClipboard(undefined);
  document.body.innerHTML = "";
});

describe("copyText (BOS-336)", () => {
  it("uses the Clipboard API on a secure page and puts the exact text on it", async () => {
    setSecure(true);
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    const exec = defineExec(() => true);
    await expect(copyText("cd /srv && git merge --ff-only abc")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("cd /srv && git merge --ff-only abc");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to a hidden field when the page is not secure (plain-http LAN address)", async () => {
    setSecure(false);
    const writeText = vi.fn(() => Promise.resolve());
    setClipboard({ writeText });
    let copied = "";
    const exec = defineExec((cmd) => {
      if (cmd === "copy") copied = (document.querySelector("textarea") as HTMLTextAreaElement | null)?.value ?? "";
      return true;
    });
    await expect(copyText("cd /srv/bm/src && scripts/rebuild-live.sh")).resolves.toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith("copy");
    expect(copied).toBe("cd /srv/bm/src && scripts/rebuild-live.sh");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("falls back to the hidden field when the Clipboard API rejects on a secure page", async () => {
    setSecure(true);
    const writeText = vi.fn(() => Promise.reject(new Error("denied")));
    setClipboard({ writeText });
    const exec = defineExec(() => true);
    await expect(copyText("x")).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("returns false instead of throwing when both ways fail", async () => {
    setSecure(false);
    setClipboard(undefined);
    defineExec(() => {
      throw new Error("blocked");
    });
    await expect(copyText("x")).resolves.toBe(false);
    expect(copyMessage(false, "Command")).toMatch(/Couldn't copy/);
  });
});

describe("selectText (BOS-336)", () => {
  it("selects the text of the block so the owner can copy by hand", () => {
    const pre = document.createElement("pre");
    pre.textContent = "cd /srv && git pull";
    document.body.appendChild(pre);
    selectText(pre);
    expect(window.getSelection()?.toString()).toBe("cd /srv && git pull");
  });

  it("does nothing (and never throws) when there is no block", () => {
    expect(() => selectText(null)).not.toThrow();
  });
});
