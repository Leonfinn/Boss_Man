// Login rate limit and lockout (R45). Failures are counted per client address and per
// username over a rolling window; past the limit, further attempts are refused until the
// window has passed, even with the right password, so guessing can't be sped up. Kept in
// memory: a restart clears it, which only gives an attacker back what a reboot costs them.
export type LoginLimits = { maxFailures: number; windowMs: number };
export const DEFAULT_LOGIN_LIMITS: LoginLimits = { maxFailures: 10, windowMs: 15 * 60_000 };

/** BOS-2177: told once when a failure takes an address and/or a username to the limit. Carries the address only, never a guessed username or password. */
export type LoginLockout = { ip: string; at: number; byAddress: boolean; byUsername: boolean; ownerUsername: boolean };

/**
 * BOS-2207: a cap across addresses. Lock notices are free for the attacker (made-up usernames, many addresses), so
 * only `max` go out per `windowMs`; the rest are counted and the count is told with the next notice that goes out.
 */
export function lockoutNoticeGate(max = 3, windowMs = 60 * 60_000, now: () => number = () => Date.now()) {
  // shortcut: lost on restart, which at worst lets a few more notices through.
  let sent: number[] = [];
  let held = 0;
  return {
    /** `send` says whether to raise this notice; `held` is how many were left out since the last one that went out. */
    take(): { send: boolean; held: number; summaryInMs?: number } {
      const cutoff = now() - windowMs;
      sent = sent.filter((t) => t > cutoff);
      if (sent.length >= max) {
        held++;
        // The first held lock asks for one summary when the oldest sent notice leaves the window.
        return { send: false, held, ...(held === 1 ? { summaryInMs: Math.max(1, sent[0]! + windowMs - now()) } : {}) };
      }
      sent.push(now());
      const earlier = held;
      held = 0;
      return { send: true, held: earlier };
    },
    /** Takes the held count for the summary notice (0 if a later notice already told it). */
    flush(): number {
      const n = held;
      held = 0;
      return n;
    },
  };
}

export function loginLimiter(limits: LoginLimits = DEFAULT_LOGIN_LIMITS, now: () => number = () => Date.now(), onLocked?: (e: LoginLockout) => void) {
  // shortcut: lost on restart, harmless because a reboot only resets what it costs an attacker (see the header).
  const failures = new Map<string, number[]>();
  const recent = (key: string) => {
    const cutoff = now() - limits.windowMs;
    const list = (failures.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) failures.set(key, list);
    else failures.delete(key);
    return list;
  };
  const keys = (ip: string, username: string) => [`ip:${ip}`, `user:${username.toLowerCase()}`];

  return {
    /** Milliseconds until another attempt is allowed, or 0 if it is allowed now. */
    retryAfter(ip: string, username: string): number {
      let wait = 0;
      for (const key of keys(ip, username)) {
        const list = recent(key);
        if (list.length >= limits.maxFailures) wait = Math.max(wait, list[list.length - limits.maxFailures]! + limits.windowMs - now());
      }
      return wait;
    },
    /** `isOwnerName`: the submitted username matches an owner row (only then may a notice call it the owner's). */
    failed(ip: string, username: string, isOwnerName = false) {
      // A key is newly locked when this failure is the one that takes it from below the limit to it; later
      // failures can't happen while it is locked (retryAfter refuses first), so one lock tells once.
      const [ipKey, userKey] = keys(ip, username) as [string, string];
      const locked = [ipKey, userKey].map((key) => {
        const next = [...recent(key), now()];
        failures.set(key, next);
        return next.length === limits.maxFailures;
      });
      if (onLocked && (locked[0] || locked[1])) {
        try {
          onLocked({ ip, at: now(), byAddress: !!locked[0], byUsername: !!locked[1], ownerUsername: isOwnerName });
        } catch {
          // Telling the owner must never change the answer to the sign-in.
        }
      }
      // Bounded memory under a flood of made-up usernames.
      if (failures.size > 10_000) failures.delete(failures.keys().next().value!);
    },
    succeeded(ip: string, username: string) {
      failures.delete(keys(ip, username)[0]!);
      failures.delete(keys(ip, username)[1]!);
    },
  };
}
