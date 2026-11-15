// BOS-1602: per machine (the company runner, each check worker), which kinds of check it takes and how many of its slots
// only ever run merge checks. Nothing set = both kinds, none kept: exactly the behaviour before this setting existed.

export type MachineTakes = "both" | "merge" | "checks";
export type SlotPolicy = { takes: MachineTakes; mergeKept: number };
export const DEFAULT_POLICY: SlotPolicy = { takes: "both", mergeKept: 0 };

const TAKES_LABEL: Record<MachineTakes, string> = { both: "Merges and quick checks", merge: "Merges only", checks: "Quick checks only" };

/** One line for a machine's row, e.g. "Merges and quick checks, 2 of 3 slots kept for merges". */
export function policyLine(p: SlotPolicy | undefined, slots: number): string {
  const v = p ?? DEFAULT_POLICY;
  if (v.takes !== "both") return TAKES_LABEL[v.takes];
  const kept = Math.min(v.mergeKept, slots);
  return kept > 0 ? `${TAKES_LABEL.both}, ${kept} of ${slots} slot${slots === 1 ? "" : "s"} kept for merges` : TAKES_LABEL.both;
}

/** Whether kept-for-merges fits the slot count (the server refuses more). */
export const policyValid = (p: SlotPolicy, slots: number) => p.takes !== "both" || (Number.isInteger(p.mergeKept) && p.mergeKept >= 0 && p.mergeKept <= slots);

export function SlotSplitFields({ value, onChange, slots, idPrefix }: { value: SlotPolicy; onChange: (p: SlotPolicy) => void; slots: number; idPrefix: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }} data-testid={`${idPrefix}-split-fields`}>
      <label htmlFor={`${idPrefix}-takes`}>Takes</label>
      <select id={`${idPrefix}-takes`} value={value.takes} onChange={(e) => onChange({ takes: e.target.value as MachineTakes, mergeKept: e.target.value === "both" ? value.mergeKept : 0 })} style={{ width: "fit-content" }}>
        {(Object.keys(TAKES_LABEL) as MachineTakes[]).map((k) => (
          <option key={k} value={k}>
            {TAKES_LABEL[k]}
          </option>
        ))}
      </select>
      {value.takes === "both" && (
        <>
          <label htmlFor={`${idPrefix}-kept`}>Kept for merges (0 to {slots})</label>
          <input id={`${idPrefix}-kept`} type="number" min={0} max={slots} value={value.mergeKept} onChange={(e) => onChange({ ...value, mergeKept: Number(e.target.value) })} style={{ width: 80 }} />
        </>
      )}
      <p className="muted" style={{ fontSize: 14, margin: 0 }}>
        Slots kept for merges only ever run the merge check before a merge; the rest take either kind. A merge goes to a kept slot first; a quick check goes to a machine set to quick checks only first. "Quick checks" also covers the rare full check an agent is asked to run. If no ready machine takes a kind, those checks wait and the queue says so.
      </p>
    </div>
  );
}
