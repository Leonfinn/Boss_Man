// BOS-2632: a sweep's tell (a CEO wake, an owner notification) used to be sent with `.catch(() => undefined)` and then
// marked "told" whatever happened, so one failed tell was lost: no log line and no retry. A tell now counts only when
// it resolves with the row it made (a wake or a notification, with its id). Anything else (a throw, null for "no CEO
// to wake" or "not saved", a wake the scheduler dropped) is logged and answered with null: the caller leaves its
// marker unset, so the next pass tries again. Once a tell succeeds the caller's marker stops a second send, so a retry
// never spams; a tell that keeps failing is logged once per pass.
import { redact } from "@boss-man/shared";

/** What a tell resolves with: the wake row (scheduler.wake/notify, with its outcome) or the notification row; null when nothing was sent. */
export type Told = { id: string; outcome?: string } | null;

/**
 * Sends one tell and returns its row id, or null (logged) when it did not get through. `key` names the tell in the log
 * (the sweep and what it is about), so a tell that keeps failing can be traced. The caller records "told" only on an id.
 */
export async function tellOnce(key: string, send: () => Promise<unknown>, log?: (message: string) => void): Promise<string | null> {
  let why: string;
  try {
    // Read loosely: a sweep whose marker depends on it types its tell as Promise<Told>; a log-only caller may get anything back.
    const row = (await send()) as Partial<NonNullable<Told>> | null | undefined;
    // A dropped wake never starts a run (the owner-replies sweep counts it the same way): not told.
    if (row?.id && row.outcome !== "dropped") return row.id;
    why = !row ? "nothing was sent (no one to tell, or not saved)" : "the wake was dropped";
  } catch (err) {
    why = redact(err instanceof Error ? err.message : String(err)).slice(0, 300);
  }
  try {
    log?.(`tell "${key}" did not get through, so it is not marked told and the next pass tries again: ${why}`);
  } catch {
    // a broken logger must not take the sweep down
  }
  return null;
}
