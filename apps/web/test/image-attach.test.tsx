// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImagePreviews, useImageAttach, withImage } from "../src/components/ImageAttach";
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
      <ImagePreviews text={text} onChange={setText} />
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
    expect(screen.getByRole("button", { name: "Attach file" })).toBeTruthy();
  });

  it("shows a thumbnail of each attached image under the box, and Remove takes it out of the text", () => {
    render(<Box />);
    const box = screen.getByLabelText("text") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: `Look:\n![bug.png](/api/ticket-images/${ID})\nThanks` } });
    expect(screen.getByRole("img", { name: "bug.png" }).getAttribute("src")).toBe(`/api/ticket-images/${ID}`);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(box.value).toBe("Look:\nThanks");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("shows an attached file by name with Remove, and as a download link in a message", () => {
    render(<Box />);
    const box = screen.getByLabelText("text") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: `Spec:\n[📎 spec.pdf](/api/ticket-images/${ID})\n` } });
    expect(screen.getByText("📎 spec.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(box.value).toBe("Spec:\n");
    cleanup();
    render(<p>{linked(`See [📎 spec.pdf](/api/ticket-images/${ID}).`)}</p>);
    const link = screen.getByRole("link", { name: "📎 spec.pdf" });
    expect(link.getAttribute("href")).toBe(`/api/ticket-images/${ID}`);
    expect(link.hasAttribute("download")).toBe(true);
  });

  it("shows an image in a message as a thumbnail that opens full size", () => {
    render(<p>{linked(`Here: ![bug.png](/api/ticket-images/${ID}) see?`)}</p>);
    const img = screen.getByRole("img", { name: "bug.png" });
    expect(img.getAttribute("src")).toBe(`/api/ticket-images/${ID}`);
    expect(img.closest("a")?.getAttribute("href")).toBe(`/api/ticket-images/${ID}`);
  });
});
