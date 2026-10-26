// Pasting or picking images for a text box. Each image is uploaded straight away and its Markdown
// (![name](/api/ticket-images/<id>)) goes into the text, where the pages show it and agents open it with view_image.
import { useRef, useState, type ClipboardEvent } from "react";
import { api } from "../api";

const MAX_BYTES = 5 * 1024 * 1024;

function base64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read that image."));
    r.readAsDataURL(file);
  });
}

/** Adds a line to a text box's value: the image's Markdown on its own line. */
export const withImage = (text: string, markdown: string) => `${text}${text && !text.endsWith("\n") ? "\n" : ""}${markdown}\n`;

export function useImageAttach(companyId: string | undefined, insert: (markdown: string) => void, ticketId?: string) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const upload = async (files: File[]) => {
    if (!companyId || !files.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const f of files) {
        if (f.size > MAX_BYTES) throw new Error(`${f.name || "That image"} is over 5 MB.`);
        const r = await api<{ markdown: string }>(`/api/companies/${companyId}/images`, { method: "POST", body: { data: await base64(f), ...(f.name ? { name: f.name } : {}), ...(ticketId ? { ticketId } : {}) } });
        insert(r.markdown);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith("image/"));
    if (!files.length) return;
    // A copied screenshot has no text; when there is text too, it still pastes as usual.
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    void upload(files);
  };
  const button = (
    <>
      <button type="button" className="btn" disabled={busy || !companyId} onClick={() => input.current?.click()} title="Or paste a screenshot into the text">
        {busy ? "Attaching…" : "Attach image"}
      </button>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        multiple
        hidden
        aria-label="Choose images to attach"
        onChange={(e) => {
          void upload([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </>
  );
  return { onPaste, button, error, busy };
}
