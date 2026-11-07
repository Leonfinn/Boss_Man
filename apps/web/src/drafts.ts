// Keeps what the owner is typing in this browser until it is really sent (BOS-637).
//
// A server freeze, an update swap or a reload used to take the typed text with it: the box is a
// plain useState, so it lived only in the page. Each box now saves its text here as the owner types
// (localStorage, keyed per box) and starts from that saved text. A send clears its box's draft only
// once the server has taken it, so a failed send keeps every word and the owner can press Send again.
//
// Every read and write is wrapped: private browsing and a full disk can refuse localStorage, and a
// typing box must never throw because of it.
import { useCallback, useEffect, useRef, useState } from "react";

const PREFIX = "bm-draft:";
/** A draft left untouched this long is forgotten, so the store can't grow forever. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function readDraft(key: string): string {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return "";
    const saved = JSON.parse(raw) as { text?: unknown; at?: unknown };
    if (typeof saved.text !== "string") return "";
    if (typeof saved.at === "number" && Date.now() - saved.at > MAX_AGE_MS) {
      localStorage.removeItem(PREFIX + key);
      return "";
    }
    return saved.text;
  } catch {
    return "";
  }
}

export function saveDraft(key: string, text: string) {
  try {
    const storageKey = PREFIX + key;
    if (!text) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify({ text, at: Date.now() }));
  } catch {
    // Storage blocked or full: the box still works for this page.
  }
}

export function clearDraft(key: string) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // Nothing to clear if storage can't be reached.
  }
}

/** Every draft this browser holds, so a sign-out or a settings wipe can drop them all. */
export function clearAllDrafts() {
  try {
    const ours = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX));
    for (const k of ours) localStorage.removeItem(k);
  } catch {
    // Storage blocked: there is nothing saved to clear.
  }
}

/**
 * A box's text, kept in this browser as it is typed. `key` names the box (a chat per agent, a
 * ticket's reply box, a decision card's note); pass null for a box that should not be remembered.
 *
 * The draft is written on every change, so a freeze during typing loses at most the keystroke in
 * flight, and written again when the tab goes away in case a change never reached storage.
 */
export function useDraft(key: string | null, initial = ""): [string, (text: string) => void, () => void] {
  const [text, setText] = useState(() => (key ? readDraft(key) : initial));
  const live = useRef(key);
  live.current = key;

  const set = useCallback((next: string) => {
    setText(next);
    if (live.current) saveDraft(live.current, next);
  }, []);
  const clear = useCallback(() => {
    setText("");
    if (live.current) clearDraft(live.current);
  }, []);

  // Moving to another box (another agent, another ticket): start from that box's own kept text.
  // Nothing is read on mount, so a page that just wrote its draft keeps what it shows.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setText(key ? readDraft(key) : initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const flush = () => {
      if (live.current) saveDraft(live.current, text);
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [text]);

  return [text, set, clear];
}
