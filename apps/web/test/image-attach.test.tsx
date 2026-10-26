// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useImageAttach, withImage } from "../src/components/ImageAttach";
import { linked } from "../src/pages/Chat";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ID = "11111111-2222-3333-4444-555555555555";

function Box() {
  const [text, setText] = useState("Look:");
  const img = useImageAttach("c1", (md) => setText((t) => withImage(t, md)), "t1");
  return (
    <>
      <textarea aria-label="text" value={text} onChange={(e) => setText(e.target.value)} onPaste={img.onPaste} />
      {img.button}
      {img.error && <p role="alert">{img.error}</p>}
    </>
  );
}

describe("pasting images", () => {
  it("uploads a pasted screenshot and puts its Markdown in the text", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: ID, markdown: `![image.png](/api/ticket-images/${ID})` }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetch);
    render(<Box />);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" });
    fireEvent.paste(screen.getByLabelText("text"), { clipboardData: { files: [file], getData: () => "" } });
    await waitFor(() => expect((screen.getByLabelText("text") as HTMLTextAreaElement).value).toBe(`Look:\n![image.png](/api/ticket-images/${ID})\n`));
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/companies/c1/images");
    expect(JSON.parse(String(init.body))).toMatchObject({ name: "image.png", ticketId: "t1", data: "iVBORw==" });
    expect(screen.getByRole("button", { name: "Attach image" })).toBeTruthy();
  });

  it("shows an image in a message as a thumbnail that opens full size", () => {
    render(<p>{linked(`Here: ![bug.png](/api/ticket-images/${ID}) see?`)}</p>);
    const img = screen.getByRole("img", { name: "bug.png" });
    expect(img.getAttribute("src")).toBe(`/api/ticket-images/${ID}`);
    expect(img.closest("a")?.getAttribute("href")).toBe(`/api/ticket-images/${ID}`);
  });
});
