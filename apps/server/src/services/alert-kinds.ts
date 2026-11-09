// One table of alert kinds (DR-017 A, BOS-469). Every alert Boss Man raises names a kind here; the
// ladder reads its highest rung, how to build its cause key, and the condition that says its cause is
// gone (DR-016, closed by alert-clearing.ts). A kind may reach the owner only when its row says so:
// this is an allow-list, so a new alert cannot quietly start landing in the owner's queue.
//
// The rung names are the alert ladder's own (alert-ladder.ts): "scrum_master", "ceo", "owner".
//
// The condition rows are DR-016's, and their checker is the one closer in alert-clearing.ts (BOS-470).
// They are declared here so a kind's row carries its own closer; the closer matches on `kind`, so the
// two never disagree about what would close a card.
export type ClearWhen =
  | { kind: "runActive"; runId: string }
  | { kind: "agentRanOk"; agentId: string }
  | { kind: "ticketDone"; ticketId: string }
  | { kind: "ticketLeft"; ticketId: string; state: string }
  /** Start-failure cards name the wake that failed: the runner must be connected and that wake must have started. */
  | { kind: "runnerConnected"; companyId: string; wakeId?: string }
  /** Usage-limit cards: the account has room again (the same test as the scheduler's account pick). */
  | { kind: "limitReset"; fundingSourceId: string }
  /**
   * An auth and credit-failure card's closer (BOS-469): a clean run on that account. A revoked key or an
   * empty credit balance leaves the quota windows untouched, so "room again" is true at once; only a
   * clean run proves the credential is fixed.
   */
  | { kind: "accountRanOk"; fundingSourceId: string }
  /** No-progress cards (BOS-593): a work run in that company has finished cleanly since the card was raised. */
  | { kind: "companyRanOk"; companyId: string }
  /** A roadmap feature that had no open ticket now has one (BOS-595, closer in alert-clearing.ts). */
  | { kind: "featureHasTicket"; featureId: string }
  /** Server-health cards (BOS-640): the rule has stayed under its level for 30 minutes. */
  | { kind: "serverCalm"; rule: "memory" | "freezes" };

export type AlertRung = "scrum_master" | "ceo" | "owner";

/** What a raise says about itself, when it doesn't bring its own condition or cause key. */
export type AlertCause = {
  /**
   * The company the alert is about. The ladder sets it from the raise (BOS-498); a key built here that is
   * unique across companies must carry it.
   */
  companyId?: string;
  /**
   * The funding source the alert is about, for account outages (one card per account, DR-017 B).
   * `auth` is set for a credential/credit failure, which closes only on a clean run (not on "room again").
   */
  account?: { fundingSourceId: string; name: string; window?: string; auth?: boolean };
  /** The agent ids the card names, for a grouped card's text and its clean-run closer. */
  agents?: Array<string | null | undefined>;
  /** The run a stalled/self/heartbeat alert is about, when its key doesn't carry it. */
  runId?: string | null;
  /** A runner boot (DR-017 B): everything a restart leaves behind folds into one card per boot. */
  runnerId?: string;
  bootId?: string;
};

export type AlertKindRow = {
  /** The highest rung this card may reach. A CEO-ceiling card never falls through to the owner (DR-015). */
  topRung: AlertRung;
  /** The cause key: raises with the same key fold into one card (DR-017 B). */
  groupBy?: (cause: AlertCause) => string | null;
  /** The conditions that close the card when its cause is gone (DR-016). */
  clearWhen?: (cause: AlertCause) => ClearWhen[];
  /** The heading of a folded card, e.g. "Claude Max: 3 runs failed on the weekly limit (Brains, Zippy)". */
  title?: (cause: AlertCause, count: number) => string;
};

/** A clean run by any agent named on the card says its loop is over (DR-017 E). */
const ranOk = (cause: AlertCause): ClearWhen[] => {
  const ids = [...new Set((cause.agents ?? []).filter((x): x is string => !!x))];
  return ids.slice(0, 1).map((agentId): ClearWhen => ({ kind: "agentRanOk", agentId }));
};

/**
 * Every kind of alert Boss Man raises. The comment above each names its raise site(s);
 * `alert-kinds.test.ts` lists the raise sites in the source and checks that each names a row here,
 * so no alert can ship without one.
 */
export const ALERT_KINDS = {
  // sweeps.ts stalledRuns: the run spoke, then went quiet. Keep waiting / Cancel run are agent actions.
  stalled_run: {
    topRung: "ceo",
    clearWhen: (c) => (c.runId ? [{ kind: "runActive", runId: c.runId }] : []),
  },
  // run-time-limit.ts (BOS-846): a run was stopped for passing the owner's per-run time limit. The limit is the
  // owner's own setting, so the card starts with them. One card per stopped run; it doesn't clear by itself.
  run_time_limit: {
    topRung: "owner",
  },
  // sweeps.ts longTicketlessRuns: a run with no ticket going for a long time.
  ticketless_run: {
    topRung: "ceo",
  },
  // scheduler.ts wake(): the self-wake limit and the chain-depth loop.
  self_wake: {
    topRung: "ceo",
    clearWhen: ranOk,
  },
  chain_loop: {
    topRung: "ceo",
    clearWhen: ranOk,
  },
  ticketless_limit: {
    topRung: "ceo",
    clearWhen: ranOk,
  },
  // scheduler.ts nudge(): two agents nudging each other.
  nudge_loop: {
    topRung: "ceo",
  },
  // scheduler.ts flagFailedStart(): a wake that could not start. A runner that is offline gets no card
  // (DR-017 D, BOS-480): the runner watch owns it. The card closes once the runner is back and that wake
  // has started (DR-017 E).
  could_not_start: {
    topRung: "ceo",
  },
  // loop-guards.ts failure(): the same failure has come back three times.
  repeated_failure: {
    topRung: "ceo",
  },
  // The same, when the failure names an account limit or auth error (DR-015 D, BOS-469 point 3): the
  // owner, one card per account, naming the agents instead of one card per run.
  account_limit: {
    topRung: "owner",
    // The key names the company too (BOS-498): the dedupe key is unique across companies, so without it one
    // company's open card on a shared funding source would swallow another company's raise.
    groupBy: (c) => (c.companyId && c.account ? `account:${c.companyId}:${c.account.fundingSourceId}:account_limit` : null),
    title: (c, n) =>
      `${c.account?.name ?? "An account"}: ${n} run${n === 1 ? "" : "s"} failed on ${c.account?.window ?? "a usage limit or auth error"}${c.agents?.length ? ` (${c.agents.length} agent${c.agents.length === 1 ? "" : "s"})` : ""}`,
    // A usage limit lifts when the account has room again; an auth or credit failure does not, because
    // a revoked key leaves the quota windows empty. That one waits for a clean run on the account.
    clearWhen: (c) => {
      if (!c.account) return [];
      const src = c.account.fundingSourceId;
      // "company" is the fallback key when the error named no account: there is no single source to watch,
      // so watch a clean run by any agent the card names.
      if (src === "company") return c.account.auth ? ranOk(c) : [];
      return c.account.auth ? [{ kind: "accountRanOk", fundingSourceId: src }] : [{ kind: "limitReset", fundingSourceId: src }];
    },
  },
  // loop-guards.ts reviewRound(): a review round that keeps coming back.
  review_loop: {
    topRung: "ceo",
  },
  // progress.ts review with no verdict, and sweeps.ts stalledReviews: a reviewer who never gives one.
  review_no_verdict: {
    topRung: "ceo",
  },
  review_stall: {
    topRung: "ceo",
  },
  // progress.ts silent runs: an agent that worked a long time without posting on the ticket.
  silent_run: {
    topRung: "ceo",
  },
  // progress.ts unproven: a ticket whose cause has only been "likely / not proven" for hours.
  unproven_cause: {
    topRung: "ceo",
  },
  // Everything a runner restart leaves behind (DR-017 B, BOS-480): one card per runner boot, not one per run.
  runner_boot: {
    topRung: "ceo",
    groupBy: (c) => (c.runnerId && c.bootId ? `runner-boot:${c.runnerId}:${c.bootId}` : null),
    title: (_c, n) => `${n} run${n === 1 ? "" : "s"} didn't start after a runner restart`,
  },
  // watchdog.ts quotaHeldAlerts (BOS-450): a wake held by the subscription usage limit for too long. One card per held wake.
  // It closes once the account has room again, by the same test the scheduler uses.
  quota_held: {
    topRung: "ceo",
    clearWhen: (c) => (c.account ? [{ kind: "limitReset", fundingSourceId: c.account.fundingSourceId }] : []),
  },
  // deploys.ts finishTag / runTag (DR-033): a deploy tag that couldn't be moved after a successful deploy,
  // or a runner offline for 30 minutes with the move waiting. The deploy stands; the CEO fixes the host settings
  // or tells the owner. One card per deploy.
  deploy_tag: {
    topRung: "ceo",
  },
  // no-progress.ts (BOS-593, N4): a company with work waiting and no clean run for an hour, or one error
  // hitting several agents. One card per company. It may reach the owner: a stopped company usually can't
  // run its own CEO either (HolidayHours went two days unseen that way). Closes on the company's next clean run.
  no_progress: {
    topRung: "owner",
  },
  // opencode-vacuum.ts (BOS-622): the runner killed the OpenCode prune's one-off VACUUM at its cap. One card per runner per day.
  opencode_vacuum_cut: {
    topRung: "ceo",
  },
  // watchdog.ts spareCapacity (BOS-659): the company is under-used while work waits, and picking the
  // next ticket is a judgement call. Stops at the CEO; one card per company folds the stretches together.
  spare_capacity: {
    topRung: "ceo",
    groupBy: (c) => (c.companyId ? `spare-capacity:${c.companyId}` : null),
    title: (_c, n) => `Spare capacity: ${n} checks found the company under-used while work waits`,
  },
  // server-health.ts (BOS-640): the server's rss passed 60% of the memory it may use, or rose more than
  // 1 GiB an hour for two hours. The CEO can ask for the update or the restart; it never reaches the owner
  // by itself. Closes once memory has been under the level for 30 minutes (serverCalm).
  server_memory: {
    topRung: "ceo",
    clearWhen: () => [{ kind: "serverCalm", rule: "memory" }],
  },
  // server-health.ts (BOS-640): more than 10 freezes over a second in 10 minutes. Only the owner can
  // approve the update or restart the server, so it starts with them. Closes after 30 calm minutes.
  server_freezes: {
    topRung: "owner",
    clearWhen: () => [{ kind: "serverCalm", rule: "freezes" }],
  },
  // A plain raise (the scheduler's add-on notice and any caller that only says where it may go).
  alert: {
    topRung: "ceo",
    title: (_c, n) => `Boss Man has ${n} alert${n === 1 ? "" : "s"} of the same kind`,
  },
  /**
   * feedback.ts raiseFeatureNoTicket, run by the sweep (BOS-595): a feature on the roadmap's Now, Next or
   * In progress with no open ticket, so the work the owner expects is not actually being done. The CEO
   * creates the ticket; the card closes by itself once one is linked (DR-016, BOS-470).
   */
  feature_no_ticket: {
    topRung: "ceo",
  },
  // An alert only the owner can settle (a secret, a sign-off, host access).
  owner: {
    topRung: "owner",
  },
} as const satisfies Record<string, AlertKindRow>;

export type AlertKind = keyof typeof ALERT_KINDS;

export const ALERT_KIND_NAMES = Object.keys(ALERT_KINDS) as AlertKind[];

export function isAlertKind(x: unknown): x is AlertKind {
  return typeof x === "string" && Object.prototype.hasOwnProperty.call(ALERT_KINDS, x);
}

/** The row for a kind, or the safe default ("owner" when the raise says only the owner can act). */
export function kindRow(kind: AlertKind | undefined, from: AlertRung | undefined): AlertKindRow {
  if (kind) {
    const row = ALERT_KINDS[kind] as AlertKindRow | undefined;
    if (row) return row;
  }
  return from === "owner" ? ALERT_KINDS.owner : ALERT_KINDS.alert;
}

/** Which rung a raise starts at: the Scrum Master unless its caller says higher. */
export function kindStart(from: AlertRung | undefined): AlertRung {
  return from ?? "scrum_master";
}

/** The highest rung a card of this kind may reach. Never lower than where it starts. */
export function kindCeiling(kind: AlertKind | undefined, from: AlertRung | undefined): AlertRung {
  const start = kindStart(from);
  const top = kindRow(kind, from).topRung;
  return top === "owner" || start === "owner" ? "owner" : top;
}
