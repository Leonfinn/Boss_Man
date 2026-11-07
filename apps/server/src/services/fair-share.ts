// Fair share at the all-companies run limit (BOS-582, DR-032).
//
// The run queue is sorted once per pass (someone-is-waiting first, then aged rank). On a full server
// that order alone let one busy company take every freed slot: the slot that frees is usually the
// one kept for cards, and the busy company always has a card or review waiting. So a company with
// nothing running could wait for ever (HolidayHours, 5–6 Nov, 22 h with no run).
//
// The rule: while a company with no work run going has a wake in the queue, its best wake is looked
// at next, and it may use the slot kept for cards. Once that wake starts, the company is busy and
// its other wakes go back to the normal order. So every company with work waiting gets at least one
// run, and a busy company still gets every slot no idle company needs.

/** Why a work wake waits for a run slot (BOS-582): the most specific limit is named. */
export const HELD_AGENT = "at a concurrency limit: this agent is busy";
export const HELD_COMPANY = "at a concurrency limit: this company";
export const HELD_ALL_COMPANIES = "at a concurrency limit: all companies";
/** An owner chat waits only for its agent's one chat slot. */
export const HELD_CHAT = "at a concurrency limit: this agent is already chatting";

/**
 * The queue in the order the pass should look at it. Lazy on purpose: `isIdle` is asked again before
 * every wake, so a launch earlier in the same pass (which makes its company busy) ends that
 * company's turn at once. `skip` marks wakes that use no work slot (owner chats); they keep their place.
 */
export function* fairOrder<W extends { companyId: string }>(queue: readonly W[], isIdle: (companyId: string) => boolean, skip: (w: W) => boolean = () => false): Generator<W> {
  const left = [...queue];
  while (left.length) {
    const i = left.findIndex((w) => !skip(w) && isIdle(w.companyId));
    yield left.splice(i === -1 ? 0 : i, 1)[0]!;
  }
}
