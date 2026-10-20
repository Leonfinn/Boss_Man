// Login rate limit and lockout (R45). Failures are counted per client address and per
// username over a rolling window; past the limit, further attempts are refused until the
// window has passed, even with the right password, so guessing can't be sped up. Kept in
// memory: a restart clears it, which only gives an attacker back what a reboot costs them.
export type LoginLimits = { maxFailures: number; windowMs: number };
export const DEFAULT_LOGIN_LIMITS: LoginLimits = { maxFailures: 10, windowMs: 15 * 60_000 };

export function loginLimiter(limits: LoginLimits = DEFAULT_LOGIN_LIMITS, now: () => number = () => Date.now()) {
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
    failed(ip: string, username: string) {
      for (const key of keys(ip, username)) failures.set(key, [...recent(key), now()]);
      // Bounded memory under a flood of made-up usernames.
      if (failures.size > 10_000) failures.delete(failures.keys().next().value!);
    },
    succeeded(ip: string, username: string) {
      failures.delete(keys(ip, username)[0]!);
      failures.delete(keys(ip, username)[1]!);
    },
  };
}
