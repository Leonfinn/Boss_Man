// Pasting or picking images and files for a text box. Each is uploaded straight away and its Markdown goes into
// the text: ![name](/api/ticket-images/<id>) for a picture, [📎 name](...) for a file. The pages show them and
// agents open them with open_attachment.
import { useRef, useState, type ClipboardEvent } from "react";
import { api } from "../api";

const MAX_BYTES = 10 * 1024 * 1024;

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
        if (f.size > MAX_BYTES) throw new Error(`${f.name || "That file"} is over 10 MB.`);
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
    const files = [...e.clipboardData.files];
    if (!files.length) return;
    // A copied screenshot has no text; when there is text too, it still pastes as usual.
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    void upload(files);
  };
  const button = (
    <>
      <button type="button" className="btn" disabled={busy || !companyId} onClick={() => input.current?.click()} title="Or paste a screenshot into the text">
        {busy ? "Attaching…" : "Attach file"}
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Choose files to attach"
        onChange={(e) => {
          void upload([...(e.target.files ?? [])]);
          e.target.value = "";
        }}
      />
    </>
  );
  return { onPaste, button, error, busy };
}

const ATTACHED = /(!?)\[([^\]]*)\]\((\/api\/ticket-images\/[0-9a-f-]{36})\)\n?/g;

/** What's attached in a text box's text, pictures as thumbnails and files by name, each with Remove. */
export function ImagePreviews({ text, onChange }: { text: string; onChange: (text: string) => void }) {
  const found = [...text.matchAll(ATTACHED)];
  if (!found.length) return null;
  return (
    <div className="image-previews">
      <div className="image-thumbs">
        {found.map((m, i) => (
          <figure key={`${m[3]}-${i}`}>
            {m[1] ? <img src={m[3]} alt={m[2] || "image"} /> : <span className="file-chip">{m[2]}</span>}
            <button type="button" className="btn small" onClick={() => onChange(text.replace(m[0], ""))}>
              Remove
            </button>
          </figure>
        ))}
      </div>
      <small className="muted">In the text, each attachment is a line ending in /api/ticket-images/…). Leave it there: it shows as the picture or file once sent.</small>
    </div>
  );
}
