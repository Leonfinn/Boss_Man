// @vitest-environment jsdom
// BOS-2853: a chat message with fenced commands draws each as a code box, Copy sends only the command,
// and the preview/find text never keeps the ``` lines or the language tag.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const copyText = vi.fn(async (_text: string) => true);
vi.mock("../src/clipboard", () => ({ copyText: (text: string) => copyText(text), selectText: () => {} }));

import { MessageText, plainText, previewText, visibleParts } from "../src/components/MessageText";

afterEach(() => {
  cleanup();
  copyText.mockClear();
});

const SHORT = "docker rm -f $(docker ps -aq --filter name=boss-man)";
const LONG = "docker run --rm -it --name check -v /srv/app:/srv/app ghcr.io/example/app:1 ./scripts/check-all.sh --full";
const REPLY = `I cleared it:\n\n\`\`\`sh\n${SHORT}\n\`\`\`\n\nThen check with:\n\n\`\`\`sh\n${LONG}\n\`\`\``;

describe("a chat message with fenced commands", () => {
  it("draws each fence as a command box with Copy, and no fence line as text", () => {
    const { container } = render(<MessageText text={REPLY} />);
    const boxes = container.querySelectorAll("[data-command]");
    expect(boxes).toHaveLength(2);
    expect(Array.from(boxes).map((b) => b.querySelector("pre")?.textContent)).toEqual([SHORT, LONG]);
    expect(container.textContent).toContain("I cleared it:");
    expect(container.textContent).toContain("Then check with:");
    expect(container.textContent).not.toContain("```");
    expect(container.textContent).not.toMatch(/^\s*sh\s*$/m);
  });

  it("copies only the command, not the fence or the language tag", async () => {
    render(<MessageText text={REPLY} />);
    const buttons = screen.getAllByRole("button", { name: "Copy this command" });
    expect(buttons).toHaveLength(2);
    fireEvent.click(buttons[0]!);
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(SHORT));
    expect(copyText).toHaveBeenCalledTimes(1);
  });

  it("keeps ordinary messages exactly as they were, inline code and links included", () => {
    const text = "Press `Save` on the [board](#/board).";
    const { container } = render(<MessageText text={text} />);
    expect(container.querySelector("[data-command]")).toBeNull();
    expect(container.textContent).toBe("Press `Save` on the board.");
    expect(screen.getByRole("link", { name: "board" }).getAttribute("href")).toBe("#/board");
  });

  it("preview and find text read the command, never the fence lines", () => {
    const preview = previewText(REPLY);
    expect(preview).toContain(SHORT);
    expect(preview).toContain(LONG);
    expect(preview).not.toContain("```");
    expect(preview).not.toContain("\n");
    const parts = visibleParts(REPLY);
    expect(parts.join(" ")).toContain(SHORT);
    expect(parts.join(" ")).not.toContain("```");
    const plain = plainText(REPLY);
    expect(plain).toContain("I cleared it:");
    expect(plain).toContain(LONG);
    expect(plain).not.toContain("```");
  });
});
