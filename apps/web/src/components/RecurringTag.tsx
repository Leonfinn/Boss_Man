/** BOS-2485: the "Recurring" label on a standing ticket, on Board cards and the ticket page. Same `tag` style as the other card labels. */
export function RecurringTag() {
  return (
    <span className="tag" data-testid="recurring-tag" title="A standing job that stays on the board and repeats.">
      <span aria-hidden="true">↻ </span>
      Recurring
    </span>
  );
}
