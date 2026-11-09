// Pasting or picking images and files for a text box. Each is uploaded straight away and kept as an
// attachment: ![name](/api/ticket-images/<id>) for a picture, [📎 name](...) for a file. It shows as a
// preview under the box, and the links go into the text only when it is sent. The pages show them and
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

/** The line a sent message carries for each attachment: the image's Markdown or the file's link. */
export const withImage = (text: string, markdown: string) => `${text}${text && !text.endsWith("\n") ? "\n" : ""}${markdown}\n`;

/** The text to send: what was typed, then a line for each attachment still attached, in the order attached. */
export function withAttachments(text: string, attachments: string[]) {
  return attachments.reduce((t, markdown) => withImage(t, markdown), text);
}

/** "![name](/api/ticket-images/<id>)" for a picture; the name is the part that shows. */
export function attachmentName(markdown: string) {
  return markdown.match(/^!?\[([^\]]*)\]/)?.[1] ?? "file";
}

/**
 * A box's attachments. `ticketId` is the ticket they belong to (absent: the company's); pass
 * `{ ticketIdOf }` when that differs from box to box (the decision cards, BOS-759).
 */
export function useImageAttach(companyId: string | undefined, ticketId?: string, opts: { ticketIdOf?: () => string | undefined } = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attached, setAttached] = useState<string[]>([]);
  const input = useRef<HTMLInputElement>(null);
  /** Where this upload belongs: the card being answered, else the box's own ticket. */
  const where = () => opts.ticketIdOf?.() ?? ticketId;
  const upload = async (files: File[]) => {
    if (!companyId || !files.length) return;
    const forTicket = where();
    setBusy(true);
    setError(null);
    try {
      for (const f of files) {
        if (f.size > MAX_BYTES) throw new Error(`${f.name || "That file"} is over 10 MB.`);
        const r = await api<{ markdown: string }>(`/api/companies/${companyId}/images`, { method: "POST", body: { data: await base64(f), ...(f.name ? { name: f.name } : {}), ...(forTicket ? { ticketId: forTicket } : {}) } });
        setAttached((all) => [...all, r.markdown]);
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
  const remove = (markdown: string) => setAttached((all) => all.filter((m) => m !== markdown));
  const clear = () => setAttached([]);
  /** Attaches text as a .txt file, for what is too long to send as a message. Returns the text file's Markdown. */
  const uploadText = async (text: string, name = "message.txt"): Promise<string> => {
    if (!companyId) throw new Error("Can't attach a file yet: the company isn't loaded.");
    const forTicket = where();
    setBusy(true);
    setError(null);
    try {
      const data = await base64(new Blob([text], { type: "text/plain" }));
      const r = await api<{ markdown: string }>(`/api/companies/${companyId}/images`, { method: "POST", body: { data, name, ...(forTicket ? { ticketId: forTicket } : {}) } });
      return r.markdown;
    } finally {
      setBusy(false);
    }
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
  return { onPaste, button, error, busy, attached, remove, clear, setAttached, uploadText };
}

const ATTACHED = /(!?)\[([^\]]*)\]\((\/api\/ticket-images\/[0-9a-f-]{36})\)\n?/g;

/** What's attached to a text box, pictures as thumbnails and files by name, each with Remove. */
export function ImagePreviews({ attached, onRemove }: { attached: string[]; onRemove: (markdown: string) => void }) {
  if (!attached.length) return null;
  return (
    <div className="image-previews">
      <div className="image-thumbs">
        {attached.map((markdown, i) => {
          const m = [...markdown.matchAll(ATTACHED)][0];
          if (!m) return null;
          return (
            <figure key={`${markdown}-${i}`}>
              {m[1] ? <img src={m[3]} alt={m[2] || "image"} /> : <span className="file-chip">{m[2]}</span>}
              <button type="button" className="btn small" onClick={() => onRemove(markdown)}>
                Remove
              </button>
            </figure>
          );
        })}
      </div>
    </div>
  );
}
