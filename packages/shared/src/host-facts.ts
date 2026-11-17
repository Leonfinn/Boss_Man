// What a failing check is, in one place (BOS-1586): the This host panel counts failing checks with it, and the
// close gate for after-merge criteria that name a host fact uses the same rule, so the two always agree.

/** A check fact that is a count of things wrong, or of something that went wrong: a non-zero value is a problem. */
export const CHECK_TROUBLE = /^(unhealthy|notRunning|stale|ageSeconds|lastExitCode)$/;
/** The host's own answer to "can Boss Man reach the code host": anything but "ok" is a failing check. */
export const CHECK_OK = /(^|\.)(probe|health)$/;
/** The values a CHECK_OK fact may have when it is fine. */
export const CHECK_OK_VALUE = /^(ok|pass|passed|healthy)$/i;

/** Whether one reported fact is a failing check. Only `check.*` facts can fail; an empty value is "missing", not failing. */
export function isFailingCheck(key: string, rawValue: string): boolean {
  const v = rawValue.trim();
  if (!v || !key.startsWith("check.")) return false;
  const last = key.slice(key.lastIndexOf(".") + 1);
  if (CHECK_TROUBLE.test(last)) return v !== "0";
  if (CHECK_OK.test(key)) return !CHECK_OK_VALUE.test(v);
  return false;
}

/** The keys of every failing check in a set of reported facts. */
export function failingChecks(facts: Record<string, { value: string }>): string[] {
  return Object.entries(facts).flatMap(([k, f]) => (isFailingCheck(k, f.value) ? [k] : []));
}

/** One machine clause of an after-merge criterion: `(fact: repo.probe = ok)` or `(fact: no failing check)`. */
export type FactClause = { kind: "equals"; key: string; value: string } | { kind: "no-failing-check" };

const CLAUSE = /\(\s*fact\s*:\s*([^)]*?)\s*\)/gi;

/** The fact clauses written in a criterion's text, in order. Unreadable ones are skipped (the lint can't help them). */
export function factClauses(text: string): FactClause[] {
  const out: FactClause[] = [];
  for (const m of text.matchAll(CLAUSE)) {
    const body = m[1]!.trim();
    if (/^no\s+failing\s+checks?$/i.test(body)) {
      out.push({ kind: "no-failing-check" });
      continue;
    }
    const eq = /^([A-Za-z0-9_.]{1,80})\s*=\s*(.{1,200})$/.exec(body);
    if (eq) out.push({ kind: "equals", key: eq[1]!, value: eq[2]!.trim() });
  }
  return out;
}

const FACT_KEY = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;

/** What the host's newest report says about one clause: whether it holds, and the value to quote when it doesn't. */
export function evalFactClause(clause: FactClause, facts: Record<string, { value: string }>): { met: boolean; seen: string } {
  if (clause.kind === "no-failing-check") {
    const bad = failingChecks(facts);
    return { met: bad.length === 0, seen: bad.length ? bad.map((k) => `${k} = ${facts[k]!.value.trim()}`).join(", ") : "no failing check" };
  }
  const f = facts[clause.key];
  const seen = f ? f.value.trim() : "";
  // BOS-1696: a value that names another reported fact (`deployer.scriptSha = deployer.repoSha`) compares the two facts;
  // read as the literal text "deployer.repoSha" it could never hold. Both must be reported and non-empty.
  const other = FACT_KEY.test(clause.value) ? facts[clause.value] : undefined;
  if (other) {
    const ov = other.value.trim();
    return { met: !!f && !!seen && seen.toLowerCase() === ov.toLowerCase(), seen: `${clause.key} = ${f ? seen || "(empty)" : "(not reported)"}, ${clause.value} = ${ov || "(empty)"}` };
  }
  return { met: !!f && seen.toLowerCase() === clause.value.toLowerCase(), seen: `${clause.key} = ${f ? seen || "(empty)" : "(not reported)"}` };
}

/** Words that name a host fact in a criterion without giving it as a clause (for the lint). */
const NAMES_HOST_FACT = /\b(this host|failing checks?|(?:repo|deployer|network|check|addon)\.[A-Za-z0-9_.]+)\b/i;

/** Whether a criterion's text names a host fact (a fact key, "This host" or "failing check"). */
export const namesHostFact = (text: string): boolean => NAMES_HOST_FACT.test(text.replace(CLAUSE, ""));
