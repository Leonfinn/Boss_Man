// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImagePreviews, attachmentName, useImageAttach, withAttachments } from "../src/components/ImageAttach";
import { linked } from "../src/pages/Chat";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ID = "11111111-2222-3333-4444-555555555555";
const FILE_ID = "99999999-8888-7777-6666-555555555555";

function upload(png = "image.png", id = ID) {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ markdown: `![${png}](/api/ticket-images/${id})` }), { status: 201, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const file = new File([new Uint8Array([137, 80, 78, 71])], png, { type: "image/png" });
  fireEvent.paste(screen.getByLabelText("text"), { clipboardData: { files: [file], getData: () => "" } });
  return fetch;
}

/** A composer like Chat's: typed text, attachments kept apart from it, sent with the links on the end. */
function Box({ saved = "Look:" }: { saved?: string }) {
  const [text, setText] = useState(saved);
  const [sent, setSent] = useState<string[]>([]);
  const img = useImageAttach("c1", "t1");
  return (
    <>
      <textarea aria-label="text" value={text} onChange={(e) => setText(e.target.value)} onPaste={img.onPaste} />
      <ImagePreviews attached={img.attached} onRemove={img.remove} />
      {img.button}
      {img.error && <p role="alert">{img.error}</p>}
      <button
        type="button"
        disabled={!text.trim() && !img.attached.length}
        onClick={() => {
          setSent([withAttachments(text, img.attached).trim()]);
          setText("");
          img.clear();
        }}
      >
        Send
      </button>
      <p aria-label="sent">{sent.join("\n")}</p>
    </>
  );
}

describe("pasting images", () => {
  it("uploads a pasted screenshot, shows it below the box and leaves the text alone", async () => {
    render(<Box />);
    const fetch = upload();
    await waitFor(() => expect(screen.getByRole("img", { name: "image.png" })).toBeTruthy());
    expect((screen.getByLabelText("text") as HTMLTextAreaElement).value).toBe("Look:");
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/companies/c1/images");
    expect(JSON.parse(String(init.body))).toMatchObject({ name: "image.png", ticketId: "t1", data: "iVBORw==" });
    expect(screen.getByRole("button", { name: "Attach file" })).toBeTruthy();
    expect(screen.queryByText(/Leave it there/)).toBeNull();
  });

  it("puts a link for each attachment in the sent message, in the order attached", async () => {
    render(<Box />);
    upload();
    await waitFor(() => expect(screen.getByRole("img", { name: "image.png" })).toBeTruthy());
    upload("second.png", FILE_ID);
    await waitFor(() => expect(screen.getByRole("img", { name: "second.png" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByLabelText("sent").textContent).toBe(`Look:\n![image.png](/api/ticket-images/${ID})\n![second.png](/api/ticket-images/${FILE_ID})`);
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("drops a removed attachment from the sent message, and still sends attachment-only messages", async () => {
    render(<Box />);
    upload();
    await waitFor(() => expect(screen.getByRole("img", { name: "image.png" })).toBeTruthy());
    fireEvent.change(screen.getByLabelText("text"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(screen.queryByRole("img")).toBeNull();
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    upload("keep.png", FILE_ID);
    await waitFor(() => expect(screen.getByRole("img", { name: "keep.png" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByLabelText("sent").textContent).toBe(`![keep.png](/api/ticket-images/${FILE_ID})`);
  });

  it("keeps a restored draft's attachments and sends them as written", () => {
    const saved = `Look:\n![draft.png](/api/ticket-images/${ID})`;
    render(<Box saved={saved} />);
    expect(screen.getByLabelText("text").textContent).toBe(saved);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(screen.getByLabelText("sent").textContent).toBe(saved);
  });

  it("shows an attached file by name with Remove, and as a download link in a message", () => {
    render(<Box />);
    const box = screen.getByLabelText("text") as HTMLTextAreaElement;
    expect(attachmentName(`[📎 spec.pdf](/api/ticket-images/${ID})`)).toBe("📎 spec.pdf");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(box.value).toBe("");
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
