// Every text box the owner types into keeps a draft by default (BOS-773, DR-045).
//
// A reload, a server restart or an update swap used to lose the text in a plain <textarea>. This
// wrapper is the way to write one: it keeps what is typed in this browser and starts from it, and a
// new box can't forget because the raw element is caught by test/draft-boxes.test.ts.
//
// `draftKey` names the box and is required on purpose: either a string (the box is remembered), or
// null together with `noDraft="<why>"` for the rare box that must not be kept (say, a password).
import { useEffect, useRef } from "react";
import { readDraft, saveDraft } from "../drafts";

type Props = {
  draftKey: string | null;
  /** Why this box keeps no draft; required when draftKey is null, refused otherwise. */
  noDraft?: string;
  value: string;
  onChange: (text: string) => void;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue" | "onChange"> & {
  /** React 19 takes `ref` as a prop; declared here so a caller can focus or measure the box. */
  ref?: React.Ref<HTMLTextAreaElement>;
};

/**
 * A textarea whose text is kept in this browser between reloads. It stays a controlled box (the
 * parent's `value` is what shows, so clearing it after a send or Cancel is respected), and it writes
 * to the draft on every change. When it mounts with nothing in `value` but a kept draft exists, it
 * hands that draft to the parent once, so the owner sees it and it is never sent by itself (a send
 * still needs a button press). Clear the draft with `clearDraft(draftKey)` once the text is sent.
 */
export function DraftTextarea({ draftKey, noDraft, value, onChange, ...rest }: Props) {
  if (draftKey === null && !noDraft) throw new Error('DraftTextarea needs a draftKey, or noDraft="<why>" when it keeps none');
  // Restore a kept draft into the parent once, on mount (or when the key changes to another box).
  const restored = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  useEffect(() => {
    if (!draftKey || restored.current === draftKey) return;
    restored.current = draftKey;
    const kept = readDraft(draftKey);
    if (kept) onChangeRef.current(kept);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey]);
  return (
    <textarea
      {...rest}
      value={value}
      onChange={(e) => {
        if (draftKey) saveDraft(draftKey, e.target.value);
        onChange(e.target.value);
      }}
    />
  );
}
