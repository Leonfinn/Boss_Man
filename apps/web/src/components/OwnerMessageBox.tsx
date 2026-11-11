// The owner's message box, used by every place the owner types into (a run's message, a ticket's
// conversation, the CEO chat, a decision's answer). It lets a long paste through (up to
// OWNER_MESSAGE_MAX, the same limit the server enforces), shows a character count once the text is
// long, and past the limit says so before sending and offers to send it as a .txt attachment
// instead, which agents can open. Shared so all four boxes behave the same (BOS-502).
import { useEffect, useRef, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { OWNER_MESSAGE_COUNT_FROM, OWNER_MESSAGE_MAX } from "@boss-man/shared";
import { DraftTextarea } from "./DraftTextarea";

const count = (n: number) => n.toLocaleString();

/**
 * How tall the box may grow before it scrolls: a long log shows a good part of itself without
 * pushing the rest of the screen away. The textarea is `field-sizing: content` in CSS where the
 * browser supports it, with this as the cap and a fallback on browsers that don't.
 */
const MAX_HEIGHT = 320;

export function OwnerMessageBox({
  id,
  label,
  value,
  onChange,
  onKeyDown,
  onPaste,
  placeholder,
  rows = 2,
  autoFocus = false,
  enterKeyHint,
  className,
  textareaStyle,
  /** Attaches the text as a .txt file and returns its Markdown (the box's own Attach file path). */
  onSendAsFile,
  attaching = false,
  error = null,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (text: string) => void;
  onKeyDown?: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onPaste?: (e: ClipboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  rows?: number;
  autoFocus?: boolean;
  enterKeyHint?: "enter" | "send";
  className?: string;
  textareaStyle?: CSSProperties;
  onSendAsFile?: (text: string) => Promise<void>;
  attaching?: boolean;
  error?: string | null;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const over = value.length > OWNER_MESSAGE_MAX;
  // Show the count once the text is long (or over the limit), so the owner can see it all went in.
  const showCount = value.length >= OWNER_MESSAGE_COUNT_FROM;
  // A pasted log can be long and makes the box grow; keep the caret and the end of the paste in view.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);
  return (
    <>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <DraftTextarea
        draftKey={null}
        noDraft="every screen that uses this shared box keeps the draft itself (useDraft or useFormDraft), so the box only displays it"
        id={id}
        ref={ref}
        rows={rows}
        // No maxLength: the browser would silently cut a long paste. The box warns past the limit instead.
        aria-invalid={over || undefined}
        aria-describedby={showCount || over ? `${id}-count` : undefined}
        enterKeyHint={enterKeyHint}
        className={className}
        placeholder={placeholder}
        value={value}
        autoFocus={autoFocus}
        onChange={onChange}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        style={{ maxHeight: MAX_HEIGHT, overflowY: "auto", ...textareaStyle }}
      />
      {showCount && (
        <p id={`${id}-count`} className={over ? "owner-message-count over" : "owner-message-count"} role={over ? "alert" : undefined}>
          {count(value.length)} of {count(OWNER_MESSAGE_MAX)} characters
          {over ? "; it's longer than a message can be." : "."}
        </p>
      )}
      {over && onSendAsFile && (
        <div className="owner-message-over" role="note">
          <p>
            This is longer than a message can carry ({count(OWNER_MESSAGE_MAX)} characters). Send it as a .txt file instead: the agent can open it whole.
          </p>
          <button type="button" className="btn" disabled={attaching} onClick={() => void onSendAsFile(value)}>
            {attaching ? "Sending…" : "Send as a .txt file"}
          </button>
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {children}
    </>
  );
}

/** Whether a send should be held back: over the limit, or empty once attachments are counted. */
export function tooLong(text: string) {
  return text.length > OWNER_MESSAGE_MAX;
}

/**
 * The same check on what will actually be sent: the typed text plus the attachment lines the send
 * appends (their Markdown is added to the message). Without this, a message just under the limit
 * could go over with its attachments and come back from the server as a refused request.
 */
export function tooLongToSend(text: string, attachments: string[] = []) {
  return tooLong(attachments.reduce((t, markdown) => `${t}${t && !t.endsWith("\n") ? "\n" : ""}${markdown}\n`, text));
}
