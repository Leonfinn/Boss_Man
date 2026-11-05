// @vitest-environment jsdom
// BOS-502: an owner's message box takes a long paste whole, shows a count once it is long, and past the
// limit says so before sending and offers one click to send it as a .txt file instead.
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OWNER_MESSAGE_COUNT_FROM, OWNER_MESSAGE_MAX } from "@boss-man/shared";
import { OwnerMessageBox, tooLong } from "../src/components/OwnerMessageBox";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function Box({ onFile = () => {} }: { onFile?: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <>
      <OwnerMessageBox id="t" label="Message" value={text} onChange={setText} onSendAsFile={async (long) => onFile(long)} />
      <p aria-label="state">{tooLong(text) ? "too long" : "ok"}</p>
    </>
  );
}

describe("the owner's message box (BOS-502)", () => {
  it("no longer has a maxLength, so the browser never cuts a paste", () => {
    render(<Box />);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).getAttribute("maxLength")).toBeNull();
  });

  it("takes a 200,000-character paste and shows no count before 5,000", () => {
    render(<Box />);
    const box = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "short" } });
    expect(screen.queryByText(/characters/)).toBeNull();
    const big = "x".repeat(OWNER_MESSAGE_MAX);
    fireEvent.change(box, { target: { value: big } });
    expect(box.value).toHaveLength(OWNER_MESSAGE_MAX);
    expect(screen.getByLabelText("state").textContent).toBe("ok");
    expect(screen.getByText(new RegExp(`^${OWNER_MESSAGE_MAX.toLocaleString()} of ${OWNER_MESSAGE_MAX.toLocaleString()} characters`))).toBeTruthy();
  });

  it("shows the count once the text is long", () => {
    render(<Box />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "x".repeat(OWNER_MESSAGE_COUNT_FROM + 10) } });
    expect(screen.getByText(new RegExp(`${(OWNER_MESSAGE_COUNT_FROM + 10).toLocaleString()} of`))).toBeTruthy();
  });

  it("past the limit it says so, holds the send, and offers to send it as a .txt file", async () => {
    const sent: string[] = [];
    render(<Box onFile={(t) => sent.push(t)} />);
    const big = "x".repeat(OWNER_MESSAGE_MAX + 1);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: big } });
    expect(screen.getByLabelText("state").textContent).toBe("too long");
    expect(screen.getAllByRole("alert").map((el) => el.textContent).join(" ")).toMatch(/longer than a message can/);
    await waitFor(() => expect(screen.getByRole("button", { name: "Send as a .txt file" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send as a .txt file" }));
    await waitFor(() => expect(sent).toEqual([big]));
  });
});
