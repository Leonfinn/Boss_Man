// Every text box the owner types into keeps a draft by default (BOS-773, DR-045).
//
// A reload, a server restart or an update swap used to lose the text in a plain <textarea>. This
// wrapper is the way to write one: it keeps what is typed in this browser and starts from it, and a
// new box can't forget because the raw element is caught by test/draft-boxes.test.ts.
//
// `draftKey` names the box and is required on purpose: either a string (the box is remembered), or
// null together with `noDraft="<why>"` for the rare box that must not be kept (say, a password).
import { useDraft } from "../drafts";

type Props = {
  draftKey: string | null;
  /** Why this box keeps no draft; required when draftKey is null, refused otherwise. */
  noDraft?: string;
  value: string;
  onChange: (text: string) => void;
} & Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "defaultValue" | "onChange">;

/**
 * A textarea whose text is kept in this browser between reloads. Controlled like any textarea, but
 * it starts from the kept draft (ignoring the first `value` when a draft exists) and writes it on
 * every change. Clear it with `clearDraft(draftKey)` once the text has been sent.
 */
export function DraftTextarea({ draftKey, noDraft, value, onChange, ...rest }: Props) {
  if (draftKey === null && !noDraft) throw new Error('DraftTextarea needs a draftKey, or noDraft="<why>" when it keeps none');
  // The hook holds the text when there is a key; without one it is the plain controlled box.
  const [kept, setKept] = useDraft(draftKey, value);
  return (
    <textarea
      {...rest}
      value={draftKey ? kept : value}
      onChange={(e) => {
        if (draftKey) setKept(e.target.value);
        onChange(e.target.value);
      }}
    />
  );
}
