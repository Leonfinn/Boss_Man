/** BOS-2911: a Ready ticket whose assignee is at their in-progress limit says which tickets it waits behind. Nothing when none. */
export function QueuedBehindLine({ refs, who }: { refs: string[] | null | undefined; who: string }) {
  if (!refs || refs.length === 0) return null;
  return (
    <span className="state-line" data-testid="board-queued-behind" title={`${who} is at their in-progress limit. This ticket starts when one of these finishes.`}>
      <span className="ico" aria-hidden="true">⏸</span>
      <span>Queued behind {refs.join(", ")}</span>
    </span>
  );
}
