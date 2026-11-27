// One command to paste, in its own block with a Copy button that copies exactly this text (BOS-269).
// Used by decision cards (Steps) and by chat replies (BOS-2853), so a command looks and copies the same
// wherever the owner meets it. `code` lets a caller mark words for the find box; Copy always uses `command`.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { copyText, selectText } from "../clipboard";
import type { Where } from "@boss-man/shared";

export function CommandBlock({ command, where, code }: { command: string; where?: Where; code?: ReactNode }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const pre = useRef<HTMLPreElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  // Clear the reset timer on unmount: a timer that outlives the page fires after the DOM is gone (BOS-1783).
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const copy = async () => {
    const ok = await copyText(command);
    if (!alive.current) return;
    setState(ok ? "copied" : "failed");
    if (!ok) selectText(pre.current);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  const label = state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy, select the text instead" : "Copy";
  return (
    <div style={{ margin: "6px 0", maxWidth: "100%" }}>
      {where && (
        <div style={{ fontSize: 13, color: "var(--muted, #888)", margin: "0 0 2px 2px" }}>
          On <strong>{where.host}</strong>, as {where.as === "root" ? <strong>root</strong> : "the logged-in account"}.
        </div>
      )}
      <div data-command style={{ display: "flex", gap: 8, alignItems: "flex-start", maxWidth: "100%" }}>
        {/* Sideways only (BOS-962 sweep, same as BOS-554): the command wraps, so it never needs to scroll vertically, and without overflow-y: hidden a one-pixel overflow would swallow the wheel. */}
        <pre ref={pre} style={{ flex: 1, minWidth: 0, margin: 0, padding: "8px 10px", overflowX: "auto", overflowY: "hidden", whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "var(--field)", color: "var(--head)", border: "1px solid var(--line-strong)", fontFamily: "var(--mono)", borderRadius: 6, fontSize: 13 }}>
          <code>{code ?? command}</code>
        </pre>
        <button type="button" onClick={copy} aria-label="Copy this command" aria-live="polite" style={{ flex: "none", maxWidth: "42%", whiteSpace: "normal", lineHeight: 1.2, alignSelf: "stretch", padding: "0 10px" }}>{label}</button>
      </div>
    </div>
  );
}
