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

// A whole form, not one box (BOS-773): every field and the files already attached. It is stored as
// JSON under `form`, alongside a single box's `text` in the same store; the two never read each other.

/** What a whole-form draft holds: any JSON value, or nothing. */
export function readDraftJson<T>(key: string | null): T | null {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { text?: unknown; at?: unknown };
    if (typeof saved.at === "number" && Date.now() - saved.at > MAX_AGE_MS) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return ((saved as { form?: unknown }).form ?? null) as T | null;
  } catch {
    return null;
  }
}

/** Keeps a whole form's fields, attachments included; null forgets it. */
export function saveDraftJson(key: string | null, form: unknown) {
  if (!key) return;
  try {
    const storageKey = PREFIX + key;
    if (form === null || form === undefined) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify({ form, at: Date.now() }));
  } catch {
    // Storage blocked or full: the form still works for this page.
  }
}

/** True when this browser holds any draft at all: what the reload prompt asks before promising it is kept. */
export function hasAnyDraft(): boolean {
  try {
    return Object.keys(localStorage).some((k) => k.startsWith(PREFIX));
  } catch {
    return false;
  }
}

/** Fired on `window` after a whole-form draft is saved or cleared, so the reload prompt can stop asking. */
export const DRAFT_CHANGED = "bm-draft-changed";

/** Writes a whole form's draft and tells the page, so its reload prompt knows there is text to keep. */
export function saveFormDraft(key: string | null, form: unknown) {
  saveDraftJson(key, form);
  try {
    window.dispatchEvent(new Event(DRAFT_CHANGED));
  } catch {
    // No window (a unit test of the store alone): nothing to tell.
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

/**
 * A whole form's fields, kept in this browser until the form is finished (BOS-773, DR-045). `values`
 * is the form's state and `setValues` its setter; `key` names the form (per project, per kind), or
 * null with no draft. On first mount it starts from any kept draft, and saves on every change.
 *
 * `reset` forgets the draft and goes back to the blank form: call it once the thing is created, or
 * when the owner presses Discard. Switching `key` (another project's form) swaps to that one's draft.
 */
export function useFormDraft<T>(key: string | null, initial: T, isEmpty?: (v: T) => boolean): [T, (next: T) => void, () => void, boolean] {
  const [values, setValues] = useState<T>(() => (key ? (readDraftJson<T>(key) ?? initial) : initial));
  const [restored, setRestored] = useState(() => !!key && readDraftJson<T>(key) !== null);
  const live = useRef(key);
  live.current = key;
  // `initial` and `isEmpty` are read in effects below, so they are held here to stay current without
  // re-running those effects: a form's blank is its opening values, which never change mid-edit.
  const blank = useRef(initial);
  blank.current = initial;
  const empty = useRef(isEmpty);
  empty.current = isEmpty;
  // Set while a different key's draft is being loaded, so the save effect doesn't overwrite it.
  const reading = useRef(false);
  // The save effect writes the whole form on every change; the key-change effect below loads the
  // next form's draft and lets `reading` skip that one write.

  const set = useCallback((next: T) => {
    setValues(next);
    setRestored(false);
  }, []);

  useEffect(() => {
    if (reading.current) {
      reading.current = false;
      return;
    }
    if (!live.current) return;
    // An untouched form keeps no draft: it would make the reload prompt promise text there is none of.
    const isBlank = empty.current ? empty.current(values) : JSON.stringify(values) === JSON.stringify(blank.current);
    if (isBlank) {
      clearDraft(live.current);
      return;
    }
    saveFormDraft(live.current, values);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values]);

  // Moved to another form (another project, another kind): start from that form's own kept draft.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    reading.current = true;
    const kept = key ? readDraftJson<T>(key) : null;
    setValues(kept ?? blank.current);
    setRestored(kept !== null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const reset = useCallback(() => {
    if (live.current) clearDraft(live.current);
    setValues(blank.current);
    setRestored(false);
    try {
      window.dispatchEvent(new Event(DRAFT_CHANGED));
    } catch {
      // No window: nothing to tell.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [values, set, reset, restored];
}
