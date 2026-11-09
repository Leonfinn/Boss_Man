import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ALERT_KIND_NAMES, ALERT_KINDS, isAlertKind, kindCeiling, kindRow } from "../src/services/alert-kinds.js";

const SRC = join(import.meta.dirname, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/**
 * The raise sites: every call that raises one of Boss Man's own alerts. This is a list, not a
 * heuristic, so a new site has to be added here — and so a kind can't ship without a row.
 * Each entry is the file and the text its `kind:` must be set to.
 */
const RAISE_SITES: Array<{ file: string; kind: string; why: string }> = [
  { file: "services/sweeps.ts", kind: "stalled_run", why: "a stalled run" },
  { file: "services/sweeps.ts", kind: "ticketless_run", why: "a run with no ticket" },
  { file: "services/sweeps.ts", kind: "looks_stuck", why: "a ticket woken again and again with nothing running (BOS-1015)" },
  { file: "services/sweeps.ts", kind: "review_stall", why: "a review nobody is doing" },
  { file: "services/sweeps.ts", kind: "runner_boot", why: "runs that never started after a runner restart" },
  { file: "services/progress.ts", kind: "silent_run", why: "a silent run" },
  { file: "services/progress.ts", kind: "review_no_verdict", why: "a review with no verdict" },
  { file: "services/progress.ts", kind: "unproven_cause", why: "a ticket without a proven cause" },
  { file: "services/loop-guards.ts", kind: "review_loop", why: "a review that keeps coming back" },
  { file: "services/loop-guards.ts", kind: "repeated_failure", why: "the same failure, repeatedly" },
  { file: "services/loop-guards.ts", kind: "account_limit", why: "an account limit or auth error" },
  { file: "services/scheduler.ts", kind: "self_wake", why: "an agent waking itself" },
  { file: "services/scheduler.ts", kind: "chain_loop", why: "a chain of wake-ups" },
  { file: "services/scheduler.ts", kind: "ticketless_limit", why: "too many runs with no ticket" },
  { file: "services/scheduler.ts", kind: "nudge_loop", why: "two agents nudging each other" },
  { file: "services/scheduler.ts", kind: "could_not_start", why: "a run that couldn't start" },
  { file: "services/scheduler.ts", kind: "alert", why: "the add-on notice" },
  { file: "services/watchdog.ts", kind: "quota_held", why: "work held by the usage limit" },
  { file: "services/deploys.ts", kind: "deploy_tag", why: "a deploy tag that couldn't be moved (DR-033)" },
  { file: "services/no-progress.ts", kind: "no_progress", why: "a company with work waiting and nothing finishing (BOS-593)" },
  { file: "services/opencode-vacuum.ts", kind: "opencode_vacuum_cut", why: "the OpenCode prune's VACUUM killed at its cap" },
  { file: "services/server-health.ts", kind: "server_memory", why: "the server's memory running high or climbing" },
  { file: "services/server-health.ts", kind: "server_freezes", why: "the server freezing again and again" },
];

describe("the alert kinds table (DR-017 A, BOS-469)", () => {
  it("every kind a raise site names has a row, and the site really names it", () => {
    const cache = new Map<string, string>();
    const source = (file: string) => {
      if (!cache.has(file)) cache.set(file, readFileSync(join(SRC, file), "utf8"));
      return cache.get(file)!;
    };
    for (const site of RAISE_SITES) {
      expect(isAlertKind(site.kind), `${site.why} (${site.file}) names kind "${site.kind}", which has no row`).toBe(true);
      expect(source(site.file), `${site.file} should raise "${site.kind}" for ${site.why}`).toContain(`kind: "${site.kind}"`);
    }
  });

  it("every alert raise in the source names a kind, so none ships without a row", () => {
    // Every call into the ladder, and the scheduler's alert helper, must name a kind. The ladder's own
    // tests and the one place that raises a plain "alert" are the only exceptions, and both say so.
    // app.ts only wires the ladder into the services: it passes on whatever the caller already named, so
    // it is not a raise site. Every raise is in a service, and each of those names its kind.
    const PROBLEMS: string[] = [];
    for (const file of files(SRC)) {
      if (file.endsWith(`${join("src", "app.ts")}`)) continue;
      const text = readFileSync(file, "utf8");
      const call = /(?:alerts\.raise|opts\.alert|deps\.alert)\(/g;
      let m: RegExpExecArray | null;
      while ((m = call.exec(text))) {
        const rest = text.slice(m.index, m.index + 3000);
        if (!/kind:\s*"?[a-z_]+"?/.test(rest)) PROBLEMS.push(`${file}: ${rest.slice(0, 80).replace(/\s+/g, " ")}`);
      }
    }
    expect(PROBLEMS).toEqual([]);
  });

  it("no kind can reach the owner unless its row says so", () => {
    for (const name of ALERT_KIND_NAMES) {
      const row = ALERT_KINDS[name];
      expect(["scrum_master", "ceo", "owner"]).toContain(row.topRung);
    }
    // The alert kinds that must stop at the CEO (DR-017 A).
    for (const kind of ["stalled_run", "self_wake", "chain_loop", "ticketless_limit", "nudge_loop", "could_not_start", "repeated_failure", "review_loop", "review_no_verdict", "review_stall", "silent_run", "unproven_cause", "ticketless_run", "looks_stuck", "runner_boot", "quota_held", "opencode_vacuum_cut"] as const) {
      expect(kindCeiling(kind, undefined), kind).toBe("ceo");
      expect(kindRow(kind, undefined).topRung, kind).toBe("ceo");
    }
    expect(kindCeiling("account_limit", undefined)).toBe("owner");
    expect(kindCeiling("owner", undefined)).toBe("owner");
    // A stopped company usually can't run its own CEO either, so this card may reach the owner (BOS-593).
    expect(kindCeiling("no_progress", "ceo")).toBe("owner");
  });

  it("an account limit card is per company and account, and clears when the account has room (BOS-498)", () => {
    const row = ALERT_KINDS.account_limit;
    const cause = { companyId: "co-1", account: { fundingSourceId: "fs-1", name: "Claude Max", window: "the weekly limit" } };
    expect(row.groupBy(cause)).toBe("account:co-1:fs-1:account_limit");
    expect(row.clearWhen(cause)).toEqual([{ kind: "limitReset", fundingSourceId: "fs-1" }]);
  });

  it("an auth or credit failure closes only on a clean run on the account, never on 'room again' (BOS-469, security review)", () => {
    const row = ALERT_KINDS.account_limit;
    const cause = { account: { fundingSourceId: "fs-1", name: "Claude Max", auth: true }, agents: ["a-1"] };
    expect(row.clearWhen(cause)).toEqual([{ kind: "accountRanOk", fundingSourceId: "fs-1" }]);
  });
});
