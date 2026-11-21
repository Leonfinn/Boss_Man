import { useEffect, useRef, useState } from "react";
import { TASK_SIZES, windowLabel } from "@boss-man/shared";
import { api, ApiError, RISKS, type Company, type Risk, type TicketDetail, type WorkspaceDiff } from "../api";
import { RiskLevels, useRiskTiers } from "../components/RiskHelp";
import { FieldHelp } from "../components/FieldHelp";
import { Markdown } from "../components/Markdown";
import { ImagePreviews, useImageAttach, withAttachments } from "../components/ImageAttach";
import { OwnerMessageBox, tooLongToSend } from "../components/OwnerMessageBox";
import { names, TicketReviews, useTicketReviews } from "../components/TicketReviews";
import { TicketActivity } from "../components/TicketActivity";
import { TicketLinks, useTicketLinks } from "../components/TicketLinks";
import { TicketOpenCards } from "../components/TicketOpenCards";
import { TicketRelated } from "../components/TicketRelated";
import { TicketRecord } from "../components/TicketRecord";
import { ScrumMasterLog } from "../components/ScrumMasterLog";
import { TicketOutputs, type Artifact } from "../components/TicketOutputs";
import { criterionText, criteriaText, goLiveWaitWords, isAfterMerge, readVerdicts, type Criterion } from "@boss-man/shared";
import { usePoll } from "../hooks";
import { clearDraft, readDraft, saveDraft as keepDraftText } from "../drafts";
import { DraftTextarea } from "../components/DraftTextarea";
import { NotFoundBlock } from "../components/NotFoundBlock";
import { Loader } from "../components/Loader";
import { away } from "../server-watch";

type TicketImage = { id: string; name: string; caption: string | null; size: number; createdAt: string };
import { when } from "./Runs";
import { ago } from "./Dashboard";
import { StatusLineView, type StatusLine } from "./MergeQueue";

/** The mark for one verdict on a "Done when" checklist row. */
const VERDICT_MARK: Record<string, string> = { pass: "✓ pass", fail: "✗ fail", none: "not reported" };

/** At most this many diff lines are drawn; the rest is summarised. */
const MAX_DIFF_LINES = 4000;

function DiffView({ diff }: { diff: WorkspaceDiff }) {
  const lines = diff.diff.split("\n");
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const cls = (l: string) => (l.startsWith("diff --git") ? "file" : l.startsWith("@@") ? "hunk" : l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : "");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <p className="muted" style={{ fontSize: 14 }}>
        {diff.turn ? "" : <>{diff.commits.length} commit{diff.commits.length === 1 ? "" : "s"} on top of <span className="mono">{diff.baseCommit.slice(0, 7)}</span>; </>}
        {diff.files.length} file{diff.files.length === 1 ? "" : "s"} changed.
      </p>
      {diff.files.length > 0 && (
        <ul className="mono" style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
          {diff.files.map((f) => (
            <li key={f.path}>
              {f.path} <span style={{ color: "var(--green-ink)" }}>+{f.added}</span> <span style={{ color: "var(--red-ink)" }}>-{f.removed}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="diff" role="region" aria-label="Changes">
        {shown.map((l, i) => (
          <div key={i} className={cls(l)}>
            {l || " "}
          </div>
        ))}
      </div>
      {(lines.length > MAX_DIFF_LINES || diff.truncated) && <p className="muted">The diff is longer than shown here; the full patch is in the task's branch.</p>}
    </div>
  );
}

/** A section that folds away behind an arrow (R76); closed unless it's asked to start open. */
function Fold({ title, hint, open, className, children }: { title: string; hint?: string; open?: boolean; className?: string; children: React.ReactNode }) {
  return (
    <details className={`card fold${className ? ` ${className}` : ""}`} open={open || undefined}>
      <summary>
        <span className="fold-title">{title}</span>
        {hint && <small className="muted">{hint}</small>}
      </summary>
      <div className="fold-body">{children}</div>
    </details>
  );
}

/** One row of the Details card (BOS-1195): a `<details>` with a CSS chevron, its title and a muted count on the right. */
export function DetailRow({ title, count, tone, open, children }: { title: string; count?: string; tone?: "amber"; open?: boolean; children: React.ReactNode }) {
  return (
    <details className="detail-row" open={open || undefined}>
      <summary>
        <span className="detail-title">{title}</span>
        {count && <span className={`detail-count${tone === "amber" ? " amber" : ""}`}>{count}</span>}
      </summary>
      <div className="detail-body">{children}</div>
    </details>
  );
}

/** The ticket's acceptance criteria with how the author reported each, plus the owner's editor. */
function DoneWhen({ t, patchLoaded, busy }: { t: TicketDetail; patchLoaded: (field: "body" | "acceptanceCriteria", body: Record<string, unknown>) => Promise<boolean>; busy: boolean }) {
  const criteria = t.acceptanceCriteria ?? [];
  const rows = readVerdicts(criteria, t.stateNote);
  const open = t.systemState === "review" && criteria.length > 0;
  return (
    <DetailRow title="Done when" count={criteriaCount(criteria, rows)} open={open}>
      {rows.length > 0 && (
        <ul data-testid="criteria" style={{ margin: 0, paddingLeft: 18 }}>
          {rows.map((r, i) => (
            <li key={r.criterion} data-testid="criterion" data-verdict={r.verdict ?? "none"} data-after={isAfterMerge(criteria[i]!) ? "merge" : undefined}>
              <span data-testid="verdict" style={{ color: r.verdict === "pass" ? "var(--green-ink)" : r.verdict === "fail" ? "var(--red-ink)" : undefined, fontWeight: 600 }}>{!r.verdict && t.goLiveWait && isAfterMerge(criteria[i]!) ? goLiveWaitWords(t.goLiveWait) : VERDICT_MARK[r.verdict ?? "none"]}</span> {r.criterion}
              {isAfterMerge(criteria[i]!) && <small className="muted"> · on a real host, checked after merge</small>}
            </li>
          ))}
        </ul>
      )}
      {!criteria.length && <p className="muted" style={{ margin: 0 }}>No criteria yet. Add what has to be true for this to count as finished.</p>}
      {t.systemState === "review" && criteria.some((c) => !isAfterMerge(c)) && rows.some((r, i) => !isAfterMerge(criteria[i]!) && !r.verdict) && (
        <p className="muted" style={{ fontSize: 14, margin: 0 }}>Not every criterion to check before merge has the author's pass or fail; the reviewer has been told that. The "on a real host" ones are checked after merge and don't hold up the review.</p>
      )}
      <CriteriaEdit
        draftKey={`ticket-criteria/${t.id}`}
        key={criteria.map((c) => `${criterionText(c)}|${isAfterMerge(c) ? 1 : 0}`).join("\n")}
        initial={criteria}
        busy={busy}
        save={(next) => {
          // Clear only once the server has taken it; a failed save keeps the lines (and a change since load is refused, BOS-905).
          void patchLoaded("acceptanceCriteria", { acceptanceCriteria: next }).then((ok) => ok && clearDraft(`ticket-criteria/${t.id}`));
        }}
      />
    </DetailRow>
  );
}

/** The Done when row's count (BOS-1195): how many passed, or how many there are before any report. */
function criteriaCount(criteria: Criterion[], rows: Array<{ verdict?: string | null }>): string {
  if (!criteria.length) return "none yet";
  const reported = rows.filter((r) => r.verdict === "pass" || r.verdict === "fail").length;
  if (!reported) return `${criteria.length} ${criteria.length === 1 ? "criterion" : "criteria"}`;
  return `${rows.filter((r) => r.verdict === "pass").length} of ${criteria.length} passed`;
}

/** The What it produced row's count (BOS-1195): blank while its request is out, then items, code or nothing yet. */
function producedCount(items: Artifact[] | null, t: TicketDetail, failed: string | null): string {
  if (failed) return failed;
  if (!items) return "";
  if (items.length) return `${items.length} item${items.length === 1 ? "" : "s"}`;
  if (t.mergeCommit) return `code merged as ${t.mergeCommit.slice(0, 7)}`;
  if (t.branch && !t.noCode) return "code on its branch";
  return "nothing yet";
}

/** One non-empty line per criterion; saving nothing clears them. The typing is kept in this browser (DR-045). */
function CriteriaEdit({ draftKey, initial, save, busy }: { draftKey: string; initial: Criterion[]; save: (next: Criterion[]) => void; busy: boolean }) {
  const [text, setText] = useState(() => readDraft(draftKey) || criteriaText(initial).join("\n"));
  // Which lines are only checked once the work is live, by their position in the list.
  const [after, setAfter] = useState<Set<number>>(() => new Set(initial.flatMap((c, i) => (isAfterMerge(c) ? [i] : []))));
  const [open, setOpen] = useState(initial.length === 0);
  const next = () =>
    setText((p) => {
      const v = p ? `${p}\n` : "";
      keepDraftText(draftKey, v);
      return v;
    });
  // Built from the current lines in order, so a tick on line 2 follows line 2 even as lines are edited.
  const built = (): Criterion[] =>
    text
      .split("\n")
      .map((l, i) => ({ line: l.trim(), on: after.has(i) }))
      .filter((x) => x.line)
      .map((x) => (x.on ? { text: x.line, after: "merge" as const } : x.line));
  const same = JSON.stringify(built()) === JSON.stringify(initial.map((c) => (isAfterMerge(c) ? { text: criterionText(c), after: "merge" } : criterionText(c))));
  const lines = text.split("\n");
  return open ? (
    <div className="field">
      <label htmlFor="t-criteria" style={{ fontWeight: 600 }}>
        Acceptance criteria, one per line
      </label>
      <DraftTextarea
        draftKey={draftKey}
        id="t-criteria"
        rows={4}
        maxLength={2_000}
        placeholder={"Health check returns 200\nMigration is expand-only"}
        value={text}
        onChange={setText}
        style={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit", width: "100%" }}
      />
      <small className="muted">Up to 10; leave empty to set none. The agent must report pass or fail for each before merge when it asks for review.</small>
      {lines.some((l) => l.trim()) && (
        <fieldset style={{ border: "1px solid var(--line-strong)", borderRadius: 8, padding: "6px 10px", margin: 0 }}>
          <legend style={{ fontSize: 13 }} className="muted">
            On a real host (checked after merge)
          </legend>
          {lines.map((l, i) =>
            l.trim() ? (
              <label key={i} style={{ display: "block", fontSize: 14 }}>
                <input type="checkbox" checked={after.has(i)} onChange={(e) => setAfter((s) => { const n = new Set(s); if (e.target.checked) n.add(i); else n.delete(i); return n; })} /> {l.trim()}
              </label>
            ) : null,
          )}
          <small className="muted">Tick the checks only the real host can settle: reviewers skip them, and the ticket stays open after the merge until they're reported.</small>
        </fieldset>
      )}
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button type="button" className="btn primary" disabled={busy || same} onClick={() => save(built())}>
          Save criteria
        </button>
        {initial.length > 0 && (
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            Done
          </button>
        )}
      </div>
      <button type="button" className="link" style={{ marginTop: 4, padding: 0 }} onClick={next}>
        Add a line
      </button>
    </div>
  ) : (
    <button type="button" className="link" style={{ alignSelf: "flex-start", padding: 0 }} onClick={() => setOpen(true)}>
      Edit criteria
    </button>
  );
}

/** The owner's setup steps (DR-011): what they do once this change is live, written by whoever built it. */
function OwnerSetup({ t, patch, busy }: { t: TicketDetail; patch: (body: Record<string, unknown>) => Promise<boolean>; busy: boolean }) {
  const steps = (t.ownerSetup ?? "").trim();
  const why = (t.ownerSetupWhy ?? "").trim();
  const ifSkipped = (t.ownerSetupIfSkipped ?? "").trim();
  const n = steps.split("\n").filter(Boolean).length;
  return (
    <DetailRow title="After it goes live" count={n ? `${n} step${n === 1 ? "" : "s"} for you` : "nothing for you"} tone={n ? "amber" : undefined}>
      <OwnerSetupEdit
        draftKey={`ticket-owner-setup/${t.id}`}
        key={`${steps}\u0000${why}\u0000${ifSkipped}`}
        initial={steps}
        initialWhy={why}
        initialIfSkipped={ifSkipped}
        busy={busy}
        save={(body) => patch(body).then((ok) => ok ?? false)}
      />
    </DetailRow>
  );
}

/** One step per line; saving nothing clears them. The "why" and "if skipped" lines sit above, one line each. The typing is kept in this browser (DR-045). */
function OwnerSetupEdit({ draftKey, initial, initialWhy, initialIfSkipped, save, busy }: { draftKey: string; initial: string; initialWhy: string; initialIfSkipped: string; save: (body: Record<string, unknown>) => Promise<boolean>; busy: boolean }) {
  const [text, setText] = useState(() => readDraft(draftKey) || initial);
  const whyKey = `${draftKey}/why`;
  const skipKey = `${draftKey}/if-skipped`;
  const [why, setWhy] = useState(() => readDraft(whyKey) || initialWhy);
  const [skip, setSkip] = useState(() => readDraft(skipKey) || initialIfSkipped);
  // What Save should send: the box's text, unless it still shows a kept draft from before this edit.
  const shown = readDraft(draftKey) || readDraft(whyKey) || readDraft(skipKey);
  const [open, setOpen] = useState(!initial && !initialWhy && !initialIfSkipped && !shown);
  const oneLine = { padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit", width: "100%", resize: "vertical" as const };
  return open ? (
    <div className="field">
      <label htmlFor="t-owner-setup-why" style={{ fontWeight: 600 }}>
        Why it matters (opens the card)
      </label>
      <DraftTextarea draftKey={whyKey} id="t-owner-setup-why" rows={1} maxLength={240} placeholder="What this setup changes for you" value={why} onChange={setWhy} style={oneLine} />
      <label htmlFor="t-owner-setup-skip" style={{ fontWeight: 600, marginTop: 6 }}>
        If you skip it
      </label>
      <DraftTextarea draftKey={skipKey} id="t-owner-setup-skip" rows={1} maxLength={240} placeholder="What happens if you leave this undone" value={skip} onChange={setSkip} style={oneLine} />
      <label htmlFor="t-owner-setup" style={{ fontWeight: 600, marginTop: 6 }}>
        What you have to do, one step per line
      </label>
      <DraftTextarea
        draftKey={draftKey}
        id="t-owner-setup"
        rows={3}
        maxLength={4_000}
        placeholder={"Settings → Funding → Add funding source, then sign in to the second plan"}
        value={text}
        onChange={setText}
        style={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit", width: "100%" }}
      />
      <small className="muted">In plain words, by the buttons you'd click, one step per line. Boss Man shows this as a card only once the change is actually running. Leave empty if there's nothing for you to do.</small>
      <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
        <button
          type="button"
          className="btn primary"
          disabled={busy || (text === initial && why === initialWhy && skip === initialIfSkipped)}
          onClick={() => {
            // Send only what changed; empty clears it. Clear drafts only once the server has taken them; a failed save keeps them.
            const body: Record<string, unknown> = {};
            if (text !== initial) body.ownerSetup = text.trim();
            if (why !== initialWhy) body.ownerSetupWhy = why.trim() || null;
            if (skip !== initialIfSkipped) body.ownerSetupIfSkipped = skip.trim() || null;
            void save(body).then((ok) => {
              if (!ok) return;
              clearDraft(draftKey);
              clearDraft(whyKey);
              clearDraft(skipKey);
            });
          }}
        >
          Save steps
        </button>
        {(initial || initialWhy || initialIfSkipped) && (
          <button type="button" className="btn" onClick={() => setOpen(false)}>
            Done
          </button>
        )}
      </div>
    </div>
  ) : (
    <>
      {initialWhy && (
        <p style={{ margin: "0 0 4px" }}>
          <strong>Why:</strong> {initialWhy}
        </p>
      )}
      {initialIfSkipped && (
        <p style={{ margin: "0 0 4px" }}>
          <strong>If you skip it:</strong> {initialIfSkipped}
        </p>
      )}
      <button type="button" className="link" style={{ alignSelf: "flex-start", padding: 0 }} onClick={() => setOpen(true)}>
        Edit steps and lines
      </button>
    </>
  );
}

export type BuildResult = { state: "passed" | "failed" | "pending" | "none"; failing: string[]; total: number | null; url: string | null; sha: string };
const BUILD_WORDS = { passed: "passed", failed: "failed", pending: "running" } as const;
/** Only ordinary web addresses are clickable; a host could otherwise hand us a javascript: link (BOS-1418). */
const webLink = (url: string | null | undefined) => (url && /^https?:\/\//i.test(url) ? url : null);
/** The one word for the build state, or null when there's no build to show: none reported (BOS-1418). */
const buildWord = (ci: BuildResult | null) => (ci && ci.state !== "none" ? BUILD_WORDS[ci.state] : null);
/** One line on the host's build result, or nothing when the host reported none (BOS-1418). */
export function BuildLine({ ci }: { ci: BuildResult | null }) {
  const word = buildWord(ci);
  if (!ci || !word) return null;
  const href = webLink(ci.url);
  return (
    <p className="muted" data-testid="build-result" style={{ overflowWrap: "anywhere" }}>
      Build on {ci.sha.slice(0, 7)}: <strong>{word}</strong>
      {ci.state === "failed" && ci.failing.length ? ` (${ci.failing.join(", ")})` : ""}
      {href && (
        <>
          {" · "}
          <a href={href} target="_blank" rel="noopener noreferrer">
            View run
          </a>
        </>
      )}
    </p>
  );
}

type Landing =
  | { state: "running"; startedAt: string; command: string | null; startedBy: string; stale?: boolean; phase?: string }
  | { state: "finished"; outcome: string; text: string; url: string | null; finishedAt: string };
const elapsed = (ms: number) => `${Math.floor(Math.max(0, ms) / 60_000)}:${String(Math.floor(Math.max(0, ms) / 1000) % 60).padStart(2, "0")}`;
const atTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
/** Who started a merge, in the owner's words. */
const PHASE_WORDS: Record<string, string> = { queued: "Queued for a check slot", checking: "Checking and merging", merging: "Merging", waiting_to_retry: "Trying again after the runner restarted", retrying_git: "Retrying after a push/fetch failure to the git host" };
const startedByLabel = (who: string) => (/interrupted merge/i.test(who) ? "the automatic retry" : who);
const ALREADY_LANDING = /already being checked and merged|merge is running now/i;
const STATE_LABEL: Record<string, string> = { backlog: "Backlog", ready: "Ready", in_progress: "In progress", blocked: "Blocked", review: "In review", done: "Done" };
const STATE_TONE: Record<string, string> = { backlog: "", ready: "amber", in_progress: "blue", blocked: "red", review: "purple", done: "green" };

/**
 * The quota hold notice in the owner's words (BOS-471): who is paused, which account is nearly used up,
 * what that pauses, and when it resets. It names another ticket only when one really holds the agent.
 */
function holdBanner(t: TicketDetail): { headline: string; detail: string } {
  const agent = t.assignee ?? "This ticket's agent";
  const source = t.quotaHeldSource;
  const window = t.quotaHeldReason?.match(/^subscription (.+) window nearly used up$/)?.[1];
  const limit = window === "seven_day" ? "weekly allowance" : window === "five_hour" ? "5-hour allowance" : window ? windowLabel(window).name.toLowerCase() : "allowance";
  // "Fri 7 Nov at 14:00 UTC", so the reset is unambiguous wherever the owner is.
  const reset = t.quotaHeldUntil
    ? new Date(t.quotaHeldUntil).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) +
      " UTC"
    : "when it resets";
  const account = source ? `${agent} is paid from ${source}, whose ${limit} is nearly used up.` : `${agent}'s ${limit} is nearly used up.`;
  const paused = `Boss Man pauses their routine work until it resets on ${reset}.`;
  const choice = `Run this one now, mark it urgent, or move ${agent} to another account in Agents.`;
  if (t.quotaHeldOther) {
    return {
      headline: `${agent} is held by ${t.quotaHeldOther.ref}.`,
      detail: `${account} ${paused} ${t.quotaHeldOther.ref} (${t.quotaHeldOther.title}) is the work that holds them. ${choice}`,
    };
  }
  return { headline: `${agent} is paused until ${reset}.`, detail: `${account} ${paused} ${choice}` };
}

/** How often a watcher reports (R80). */
const WATCH_EVERY: Array<[number, string]> = [
  [15, "Every 15 minutes"],
  [30, "Every 30 minutes"],
  [60, "Every hour"],
  [120, "Every 2 hours"],
  [240, "Every 4 hours"],
  [1440, "Once a day"],
];

/** "In 51m", "In 2h 5m", or "Due now". */
const inText = (ms: number) => (ms <= 0 ? "Due now" : ms < 3_600_000 ? `In ${Math.ceil(ms / 60_000)}m` : `In ${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`);
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

const PROPS_KEY = "bossman.ticket.workCollapsed";
/** The remembered choice; with none, phones and narrow tablets (just above the stacking width) start collapsed. */
const readPropsCollapsed = () => {
  try {
    const saved = localStorage.getItem(PROPS_KEY);
    if (saved !== null) return saved === "1";
  } catch {}
  return window.innerWidth <= 640 || (window.innerWidth > 900 && window.innerWidth < 1100);
};

export function Ticket({ id, companies }: { id: string; companies: Company[] }) {
  const ticket = usePoll((signal) => api<TicketDetail>(`/api/tickets/${id}`, { signal }), 15_000, id);
  const [propsCollapsed, setPropsCollapsed] = useState(readPropsCollapsed);
  const togglePanel = () => {
    const next = !propsCollapsed;
    setPropsCollapsed(next);
    try {
      localStorage.setItem(PROPS_KEY, next ? "1" : "0");
    } catch {}
  };
  const [diff, setDiff] = useState<WorkspaceDiff | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  // The send-back box is kept in this browser as it is typed (DR-045), and cleared once the server takes it.
  const reviewSummaryKey = `ticket-review-summary/${id}`;
  const [lesson, setLesson] = useState("");
  const [sendingBack, setSendingBack] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // A text field someone else changed since this page loaded it (BOS-905): the save was refused and the owner's draft is kept.
  const [conflict, setConflict] = useState<{ field: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // The description being edited; null while it isn't, so polling doesn't overwrite typing.
  const [draft, setDraftRaw] = useState<string | null>(null);
  // Kept in this browser as it is typed (BOS-773), so a reload doesn't lose an edited description.
  const editDraftKey = `ticket-edit/${id}/body`;
  const setDraft = (text: string | null) => {
    setDraftRaw(text);
    if (text === null) return;
    keepDraftText(editDraftKey, text);
  };
  const startEdit = () => setDraft(readDraft(editDraftKey) || (t?.body ?? ""));
  const [descOpen, setDescOpen] = useState(false);
  const tiers = useRiskTiers(ticket.data?.companyId);
  // BOS-1517: the same live status line the Merge queue shows; asked only while the ticket is in review (where it can be merging).
  const inReview = ticket.data?.systemState === "review";
  const statusLine = usePoll((signal) => (inReview && ticket.data ? api<{ statusLine: StatusLine | null }>(`/api/companies/${ticket.data.companyId}/merge-queue/${id}/status`, { signal }) : Promise.resolve({ statusLine: null })), 20_000, `sl-${id}-${inReview}`);
  const outputs = usePoll((signal) => api<Artifact[]>(`/api/tickets/${id}/artifacts`, { signal }), 20_000, id);
  const images = usePoll((signal) => api<TicketImage[]>(`/api/tickets/${id}/images`, { signal }), 30_000, `img-${id}`);
  // Fetched here so the Details card's Roadmap row can count what it waits on (BOS-1195).
  const links = useTicketLinks(id);
  const reviews = useTicketReviews(id);
  const t = ticket.data;
  // Every link on this screen is built the same way: page names open in this company, ticket references
  // by prefix, raw routes as written (BOS-358).
  const ticketLinks = t ? { companyId: t.companyId, prefix: t.ref?.replace(/-[0-9]+$/, "") ?? null, selfId: t.id, tickets: t.number ? [{ id: t.id, number: t.number, prefix: t.ref?.replace(/-[0-9]+$/, "") ?? null }] : [] } : undefined;
  const img = useImageAttach(t?.companyId, id);
  const agents = companies.find((c) => c.id === t?.companyId)?.agents ?? [];

  const patch = async (body: Record<string, unknown>) => {
    try {
      await api(`/api/tickets/${id}`, { method: "PATCH", body });
      setConflict(null);
      ticket.reload();
      return true;
    } catch (err) {
      // Someone else changed the field that was being saved: keep the owner's draft and offer a reload (BOS-905).
      if (err instanceof ApiError && err.status === 409 && err.field) setConflict({ field: err.field, text: err.message });
      else setNote({ ok: false, text: (err as Error).message });
      return false;
    }
  };
  /** Send the text field now, with the value this page loaded, so a change since is refused rather than overwritten (BOS-905). */
  const patchLoaded = (field: "body" | "acceptanceCriteria", body: Record<string, unknown>) =>
    patch({ ...body, ...(field === "body" ? { bodyLoaded: t?.body ?? null } : { acceptanceCriteriaLoaded: t?.acceptanceCriteria ?? [] }) });
  const [blocking, setBlocking] = useState<{ until: string; reason: string } | null>(null);
  const block = async () => {
    if (!blocking) return;
    try {
      const until = blocking.until ? new Date(blocking.until).toISOString() : undefined;
      await api(`/api/tickets/${id}/state`, { method: "POST", body: { state: "blocked", ...(until ? { blockedUntil: until, ...(blocking.reason.trim() ? { blockedUntilReason: blocking.reason.trim() } : {}) } : {}) } });
      setBlocking(null);
      ticket.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  const moveTo = async (state: string) => {
    if (state === "blocked") return setBlocking({ until: "", reason: "" });
    if (state === "done" && !window.confirm("Mark done without merging? Any unmerged work on its branch stays on the branch.")) return;
    try {
      await api(`/api/tickets/${id}/state`, { method: "POST", body: { state } });
      ticket.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  /** The watcher (R80): an agent that posts a short status update every so often. */
  const watch = async (agentId: string | null, everyMinutes?: number) => {
    try {
      await api(`/api/tickets/${id}/watcher`, { method: "PUT", body: { agentId, ...(everyMinutes ? { everyMinutes } : {}) } });
      ticket.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  // The monitor (wake the assignee to re-check something): an edit form, or null while not editing.
  const [mon, setMon] = useState<{ at: string; note: string } | null>(null);
  const monitor = async (body: Record<string, unknown> | null) => {
    try {
      await api(`/api/tickets/${id}/monitor`, body ? { method: "PUT", body } : { method: "DELETE" });
      setMon(null);
      ticket.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  const saveDraft = async () => {
    if (draft === null) return;
    // A refused save keeps the draft: a change to the description since this page loaded it is reported, not lost (BOS-905).
    if (!(await patchLoaded("body", { body: withAttachments(draft, img.attached).trim() || null }))) return;
    img.clear();
    clearDraft(editDraftKey);
    setDraftRaw(null);
  };
  // Too long for a description: put the text in a .txt file, link it in the description, so the agent can open it.
  const saveDraftAsFile = async (long: string) => {
    try {
      const markdown = await img.uploadText(long, "description.txt");
      if (!(await patchLoaded("body", { body: withAttachments("The text was too long for the description box, so it's in this file:\n\n", [markdown]).trim() }))) return;
      img.clear();
      clearDraft(editDraftKey);
      setDraftRaw(null);
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  const assign = (value: string) =>
    patch(value === "owner" ? { assigneeAgentId: null, assignedToOwner: true } : { assigneeAgentId: value || null, assignedToOwner: false });
  const [range, setRange] = useState<"base" | "last_turn">("base");
  const loadDiff = async (which: "base" | "last_turn" = range) => {
    setDiffError(null);
    setRange(which);
    try {
      setDiff(null);
      setDiff(await api<WorkspaceDiff>(`/api/tickets/${id}/diff${which === "last_turn" ? "?range=last_turn" : ""}`));
    } catch (err) {
      setDiffError(err instanceof ApiError && err.status === 409 ? `${err.message} The diff comes from the runner that holds the task's worktree.` : (err as Error).message);
    }
  };
  // Approval lands in the background; poll its status quickly while it runs, and slowly otherwise
  // so a merge started from another page (Decisions, a sweep) still shows here without a reload.
  const [landing, setLanding] = useState<Landing | null>(null);
  const [now, setNow] = useState(Date.now());
  const running = landing?.state === "running";
  const checking = running && !landing?.stale;
  const staleCheck = running && !!landing?.stale;
  const wasRunning = useRef(false);
  const sentReview = useRef(false);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const r = await api<{ landing: Landing | null }>(`/api/tickets/${id}/landing`);
        if (stopped) return;
        if (wasRunning.current && r.landing?.state !== "running") ticket.reload();
        wasRunning.current = r.landing?.state === "running";
        setLanding(r.landing);
      } catch {
        // A failed poll leaves the last known status in place; the next tick tries again.
      }
    };
    void load();
    const timer = setInterval(() => {
      setNow(Date.now());
      void load();
    }, running ? 2_000 : 5_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [running, id]);
  // The git host's build result on the branch head (BOS-1418). Null means nothing to show: no CI, no host, or the host said no.
  const [ci, setCi] = useState<BuildResult | null>(null);
  const hasBranch = !!ticket.data?.branch && !ticket.data?.mergeCommit;
  useEffect(() => {
    if (!hasBranch) {
      setCi(null);
      return;
    }
    let stopped = false;
    const load = () =>
      api<{ ci: BuildResult | null }>(`/api/tickets/${id}/ci`).then(
        (r) => !stopped && setCi(r.ci),
        () => undefined,
      );
    void load();
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [id, hasBranch]);
  const refreshLanding = async () => {
    try {
      const r = await api<{ landing: Landing | null }>(`/api/tickets/${id}/landing`);
      wasRunning.current = r.landing?.state === "running";
      setLanding(r.landing);
      return r.landing;
    } catch {
      return null;
    }
  };
  const review = async (verdict: "approved" | "changes_requested") => {
    // A second click can land before React re-renders the disabled button: refuse it here too.
    if (sentReview.current) return;
    sentReview.current = true;
    setBusy(true);
    try {
      const r = await api<{ outcome?: string; delivered?: string | null; landing?: Landing }>(`/api/tickets/${id}/review`, { method: "POST", body: { verdict, ...(verdict === "changes_requested" ? { summary: summary.trim(), ...(lesson.trim() ? { lesson: lesson.trim() } : {}) } : {}) } });
      setSummary("");
      clearDraft(reviewSummaryKey);
      setLesson("");
      setSendingBack(false);
      if (r.landing) {
        setNow(Date.now());
        setLanding(r.landing);
        setNote(null);
      } else setNote({ ok: true, text: `Sent back: ${r.delivered ?? "done"}.` });
      ticket.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && ALREADY_LANDING.test(err.message)) {
        const current = await refreshLanding();
        const since = current?.state === "running" ? ` since ${atTime(current.startedAt)}` : "";
        setNote({ ok: true, text: `Already being checked and merged${since}; nothing more to do.` });
      } else setNote({ ok: false, text: (err as Error).message });
    } finally {
      sentReview.current = false;
      setBusy(false);
    }
  };

  const runNow = async () => {
    setBusy(true);
    try {
      const r = await api<{ released: number }>(`/api/tickets/${id}/run-now`, { method: "POST" });
      setNote({ ok: true, text: r.released ? "Started now, past the quota hold." : "Nothing was held." });
      ticket.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  /**
   * Approve and merge (BOS-471): when the owner's sign-off card is open, the server answers that card
   * and merges in one press, so the page never tells them to go and answer a second button. A ticket
   * with no repo or no code is approved and marked done in the same press.
   */
  const approveAndMerge = async () => {
    if (sentReview.current) return;
    sentReview.current = true;
    setBusy(true);
    try {
      const r = await api<{ signoffAnswered?: boolean; landing?: Landing | null }>(`/api/tickets/${id}/approve-merge`, { method: "POST" });
      if (r.landing) {
        setNow(Date.now());
        setLanding(r.landing);
      }
      setNote({
        ok: true,
        text:
          r.landing?.state === "running"
            ? `${r.signoffAnswered ? "Signed off. " : ""}Checking and merging now.`
            : // The background merge (BOS-559) finished before the page read it back, so say so here;
              // the reload below shows the merged state.
              r.landing?.outcome === "merged"
              ? `${r.signoffAnswered ? "Signed off and merged. " : "Merged."}`
              : // No landing to show: a ticket with nothing to merge was finished in the same press (BOS-471).
                r.signoffAnswered
                ? "Signed off."
                : "Approved.",
      });
      ticket.reload();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && ALREADY_LANDING.test(err.message)) {
        const current = await refreshLanding();
        const since = current?.state === "running" ? ` since ${atTime(current.startedAt)}` : "";
        setNote({ ok: true, text: `Already being checked and merged${since}; nothing more to do.` });
      } else setNote({ ok: false, text: (err as Error).message });
    } finally {
      sentReview.current = false;
      setBusy(false);
    }
  };

  const mergeNow = async () => {
    setBusy(true);
    try {
      const r = await api<{ outcome: string }>(`/api/tickets/${id}/pull-request/merge`, { method: "POST" });
      setNote({ ok: true, text: r.outcome === "merged" ? "Merged; the task is done, or left open only for its on-a-real-host checks." : "Still waiting on the host." });
      ticket.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  if (ticket.error && !away(ticket.error)) return ticket.error.status === 404 ? <NotFoundBlock title="Ticket not found" backHref="#/board" backLabel="Back to Tickets">This ticket doesn't exist any more, or the link is wrong.</NotFoundBlock> : <p className="error" role="alert">{ticket.error.message}</p>;
  if (!t) return <Loader label="Loading the ticket" />;
  const made = outputs.data ?? [];
  // Collapsed, a long description still shows its first 8 lines.
  const longBody = (t.body?.split("\n").length ?? 0) > 8 || (t.body?.length ?? 0) > 800;
  // Plan first only matters before anyone starts; once work has begun it's history (R76).
  // Agent reviews still open (older rounds are settled), and what approving does, from the project's real landing setup.
  // A review with no reviewer is the owner's own (no agent could take it), so the page asks them directly.
  const open = (reviews ?? []).filter((r) => r.status === "pending" && r.reviewer);
  const who = names(open);
  const repo = t.repoUrl?.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/");
  const approves = !t.repoUrl
    ? "Approving marks it done."
    : t.landing === "pull_request"
      ? `Approving opens a pull request from ${t.branch ?? "its branch"} into ${t.defaultBranch} of ${repo}. The change is under Changes above.`
      : `Approving runs ${t.verifyCommand ? `\`${t.verifyCommand}\`` : "the project's check"} and, if it passes, merges ${t.branch ?? "its branch"} into ${t.defaultBranch} of ${repo}. The change is under Changes above.`;
  // One hold notice, computed once, so the headline and detail always agree.
  const hold = holdBanner(t);
  // A reviewer's hold on the merge (BOS-808): the owner can let it go on (the normal approval and merge follow) or withdraw the reviewer's pass.
  const endReviewHold = async (how: "release" | "cancel") => {
    setBusy(true);
    try {
      const r = await api<{ delivered?: string | null }>(`/api/tickets/${id}/hold/${how}`, { method: "POST" });
      setNote({ ok: true, text: how === "release" ? `Hold released${r.delivered ? `: ${r.delivered}` : ""}.` : "Hold cancelled; the work is reviewed again." });
      ticket.reload();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const approveLabel = !t.repoUrl || t.noCode ? "Approve" : t.landing === "pull_request" ? "Approve and open a pull request" : "Approve and merge";
  const decide = (
    <>
      {/* One press (BOS-471): with a sign-off card open, this button is that card's answer too. */}
      <p className="muted" style={{ fontSize: 14 }}>
        {approves}
        {t.signoffWaiting || t.signoff === "missing" ? " This is also your sign-off: one press approves, signs off and merges." : ""}
      </p>
      {sendingBack ? (
                <>
                  <div className="field">
                    <label htmlFor="review-summary">What should the agent change?</label>
                    <DraftTextarea draftKey={reviewSummaryKey} id="review-summary" rows={3} autoFocus value={summary} onChange={setSummary} placeholder={t.acceptanceCriteria?.length ? "Name the failing criterion, e.g. \"Acceptance criteria: Migration is expand-only fails.\"" : undefined} />
                  </div>
                  <div className="field">
                    {/* A lesson learned goes to a CEO decision (BOS-105), so it only reaches the brief if the CEO approves it; the owner is told the outcome. */}
                    <label htmlFor="review-lesson">Lesson learned (optional) — the CEO decides whether to add it to the project brief, and you are told the outcome</label>
                    <input id="review-lesson" value={lesson} onChange={(e) => setLesson(e.target.value)} maxLength={240} placeholder={'One line, e.g. "Check the migration is expand-only before approving."'} />
                  </div>
                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                    <button type="button" className="btn primary" disabled={busy || checking || !summary.trim()} onClick={() => void review("changes_requested")}>
                      Send it back
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => setSendingBack(false)}>
                      Cancel
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" className="btn primary" disabled={busy || checking} onClick={() => void approveAndMerge()}>
                    {approveLabel}
                  </button>
                  <button type="button" className="btn" disabled={busy || checking} onClick={() => setSendingBack(true)}>
                    Request changes
                  </button>
                </div>
              )}
    </>
  );
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">
            <a href={`#/board/${t.projectId}`}>{t.project}</a> · task{t.ref && <span className="mono"> · {t.ref}</span>}
          </p>
          <h1>{t.title}</h1>
        </div>
      </header>

      {statusLine.data?.statusLine && (
        <div className="card" role="status" data-ticket-status-line="true" style={{ marginBottom: 16 }}>
          <StatusLineView line={statusLine.data.statusLine} />
        </div>
      )}

      {t.goLiveNote && (
        <div className="card" role="status" data-ticket-go-live-note="true" style={{ marginBottom: 16 }}>
          <strong>{t.goLiveNote.text}</strong>{" "}
          {t.goLiveNote.cardId && <a href={`#/decisions/${t.goLiveNote.cardId}`}>Open the card</a>}
        </div>
      )}

      {t.hold && t.systemState === "review" && (
        <div className="card review-hold" role="status" style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: "1 1 320px" }}>
            <strong>Held: {t.hold.label}</strong> <span className="muted">· by {t.hold.reviewer ?? "a reviewer"}</span>
            <br />
            <span className="muted">
              {t.hold.reason} The review passed; the merge starts only after the hold is released.
              {t.hold.ready ? " What it waited for is done, so the reviewer has been asked to re-check it." : ""}
            </span>
          </span>
          <button type="button" className="btn primary" disabled={busy} onClick={() => void endReviewHold("release")}>
            Release hold
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void endReviewHold("cancel")}>
            Cancel hold and review again
          </button>
        </div>
      )}

      {/* Only when the ticket's next step really needs its agent to run (BOS-471): in review, waiting on the
          owner, or done, the hold changes nothing for this ticket, so it is not shown. */}
      {t.quotaHeldUntil && (t.systemState === "ready" || t.systemState === "in_progress") && (
        <div className="card quota-hold" role="status" style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ flex: "1 1 320px" }}>
            <strong>{hold.headline}</strong>{" "}
            <span className="muted">{hold.detail}</span>
          </span>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button type="button" className="btn primary" disabled={busy} onClick={() => void runNow()}>
              Run now
            </button>
            <button type="button" className="btn" disabled={busy || !!t.urgent} onClick={() => void patch({ urgent: true })}>
              {t.urgent ? "Priority 1 is on" : "Make Priority 1"}
            </button>
          </div>
        </div>
      )}

      <div className={`ticket-layout${propsCollapsed ? " props-collapsed" : ""}`}>
        <div className="ticket-main">
          <TicketOpenCards ticketId={t.id} />
          <TicketRecord ticketId={t.id} />
          <section className="card" aria-labelledby="desc-h" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
              <h2 id="desc-h" style={{ fontSize: 17, fontWeight: 600 }}>
                {longBody && draft === null ? (
                  <button type="button" className="link" aria-expanded={descOpen} aria-controls="desc-body" onClick={() => setDescOpen(!descOpen)} style={{ font: "inherit", color: "inherit" }}>
                    {descOpen ? "▾" : "▸"} Description
                  </button>
                ) : (
                  "Description"
                )}
              </h2>
              {draft === null && (
                <button type="button" className="btn" style={{ minHeight: 32, padding: "4px 12px" }} onClick={startEdit}>
                  Edit
                </button>
              )}
            </div>
            {draft === null ? (
              t.body ? (
                <div id="desc-body" className={longBody && !descOpen ? "clamp-8" : undefined}>
                  <Markdown text={t.body} linkContext={ticketLinks} />
                </div>
              ) : (
                <p className="muted">No description yet. Say what should be done and what counts as finished.</p>
              )
            ) : (
              <>
                {readDraft(editDraftKey) && (
                  <p className="muted" role="status" style={{ margin: 0, fontSize: 13 }}>
                    Draft restored. It stays in this browser until you save or discard it.{" "}
                    <button type="button" className="link" style={{ padding: 0 }} onClick={() => { clearDraft(editDraftKey); setDraftRaw(t?.body ?? ""); }}>
                      Discard draft
                    </button>
                  </p>
                )}
                <OwnerMessageBox
                  id="t-body"
                  label="Description, in Markdown"
                  rows={12}
                  autoFocus
                  placeholder="What should be done, and what counts as finished."
                  value={draft}
                  onChange={setDraft}
                  onPaste={img.onPaste}
                  onSendAsFile={saveDraftAsFile}
                  attaching={img.busy}
                  error={img.error}
                  textareaStyle={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit", width: "100%" }}
                >
                  {img.attached.length > 0 && <ImagePreviews attached={img.attached} onRemove={img.remove} />}
                </OwnerMessageBox>
                <div style={{ display: "flex", gap: 8 }}>
                  {img.button}
                  <button type="button" className="btn primary" disabled={(draft === (t.body ?? "") && !img.attached.length) || tooLongToSend(draft, img.attached)} onClick={() => void saveDraft()}>
                    Save description
                  </button>
                  <button type="button" className="btn" onClick={() => { img.clear(); setDraftRaw(null); }}>
                    Cancel
                  </button>
                </div>
              </>
            )}
          </section>

          {t.repoUrl && (
            <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
              <input type="checkbox" checked={!!t.noCode} disabled={busy} onChange={(e) => patch({ noCode: e.target.checked })} />
              <span>
                Doesn't need code changes <span className="muted">(research, wiki, docs or deploy only: it can close with nothing changed in the repository)</span>
              </span>
            </label>
          )}

          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
            <input type="checkbox" checked={!!t.urgent} disabled={busy} onChange={(e) => patch({ urgent: e.target.checked })} />
            <span>
              Priority 1<span className="muted">: goes first everywhere (runs past the subscription limit, first in the check queue and the merge line, keeps its place after a send-back) and you get one page when it has merged and is ready to put live</span> <code className="mono">quota hold</code>
            </span>
          </label>

          {/* Done when to Changes are rows of one Details card (BOS-1195), each with a count on the right;
              Review, the description and the conversation stay their own cards, and so does the live-fix note. */}
          <section className="card details-card" aria-label="Details">
            <DoneWhen t={t} patchLoaded={patchLoaded} busy={busy} />
            {t.fixesLive?.trim() && (
              // BOS-639: set by the CEO, the author or a reviewer. When it merges, the deploy card says it is urgent.
              <p className="fixes-live" style={{ margin: 0 }}>
                <strong>Fixes a live problem:</strong> {t.fixesLive.trim()}. When this merges, its update card is marked urgent.
              </p>
            )}
            {t.ceoPlan?.trim() && (
              // BOS-1509: the CEO's plan, so the assignee and the owner see what the ticket is held to.
              <p className="ceo-plan" style={{ margin: 0 }}>
                <strong>CEO plan{t.ceoPlanDeadline ? ` (due ${new Date(t.ceoPlanDeadline).toLocaleString()})` : ""}:</strong> {t.ceoPlan.trim()}
              </p>
            )}
            <OwnerSetup t={t} patch={patch} busy={busy} />

            <DetailRow title="What it produced" count={producedCount(outputs.data, t, outputs.error ? "couldn't load" : null)}>
              {outputs.error ? (
                <p className="error" role="alert" style={{ margin: 0 }}>
                  {outputs.error.message}{" "}
                  <button type="button" className="link" style={{ padding: 0 }} onClick={outputs.reload}>
                    Try again
                  </button>
                </p>
              ) : (
                <TicketOutputs items={made} companyId={t.companyId} ticketId={t.id} prefix={t.ref?.replace(/-\d+$/, "") ?? null} onChanged={outputs.reload} code={t.mergeCommit ? { merged: t.mergeCommit } : t.branch && !t.noCode ? { branch: t.branch } : null} />
              )}
            </DetailRow>

            {(images.data?.length ?? 0) > 0 && (
              <DetailRow title="Images" count={`${images.data!.length}`}>
                <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
                  {images.data!.map((img) => (
                    <figure key={img.id} style={{ margin: 0 }}>
                      <a href={`/api/ticket-images/${img.id}`} target="_blank" rel="noreferrer">
                        <img src={`/api/ticket-images/${img.id}`} alt={img.caption ?? img.name} loading="lazy" style={{ width: "100%", borderRadius: 6, border: "1px solid var(--line)" }} />
                      </a>
                      <figcaption className="muted" style={{ fontSize: 13 }}>
                        {img.caption ?? img.name} · {when(img.createdAt)}
                      </figcaption>
                    </figure>
                  ))}
                </div>
              </DetailRow>
            )}

            {t.plan && (
              // Open while it waits for the owner's approval: that's the row they act on.
              <DetailRow title="Plan" count={t.planApprovedAt ? `approved ${when(t.planApprovedAt)}` : "waiting for your approval"} tone={t.planApprovedAt ? undefined : "amber"} open={!t.planApprovedAt}>
                <Markdown text={t.plan} linkContext={ticketLinks} />
                {!t.planApprovedAt && (
                  <p className="muted" style={{ fontSize: 14 }}>
                    Approve or send it back from <a href="#/decisions">Decisions</a>.
                  </p>
                )}
              </DetailRow>
            )}

            <DetailRow title="Roadmap and dependencies" count={links.data?.waitsOn.length ? `waits on ${links.data.waitsOn.length}` : links.error ? "couldn't load" : links.data ? "none" : ""}>
              <TicketLinks t={t} onChanged={ticket.reload} bare links={links} />
            </DetailRow>

            {t.repoUrl && (
              <DetailRow title="Changes" count={buildWord(ci) ?? (t.mergeCommit ? `merged as ${t.mergeCommit.slice(0, 7)}` : t.branch ? "on its branch" : "")}>
                <BuildLine ci={ci} />
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }} role="group" aria-label="Which changes">
                  <button type="button" className="btn" aria-pressed={!!diff && range === "base"} onClick={() => void loadDiff("base")}>
                    {diff && range === "base" ? "Refresh all changes" : "All changes"}
                  </button>
                  <button type="button" className="btn" aria-pressed={!!diff && range === "last_turn"} onClick={() => void loadDiff("last_turn")}>
                    {diff && range === "last_turn" ? "Refresh the last turn" : "The last turn"}
                  </button>
                </div>
                {diff && range === "last_turn" && diff.turn && <p className="muted" style={{ fontSize: 14 }}>What the agent's last turn that changed anything did: checkpoint {diff.turn.number}, {when(diff.turn.at)}.</p>}
                {diff && <DiffView diff={diff} />}
                {diffError && (
                  <p className="error" role="alert">
                    {diffError}
                  </p>
                )}
                {t.mergeCommit && (
                  <p className="muted">
                    Merged into {t.defaultBranch} as <span className="mono">{t.mergeCommit.slice(0, 7)}</span>.
                  </p>
                )}
              </DetailRow>
            )}
          </section>

          {landing && (
            <div className="banner" role="status" aria-live="polite" style={{ flexWrap: "wrap" }}>
              {landing.state === "running" ? (
                landing.stale ? (
                  <span>
                    The merge check started by {startedByLabel(landing.startedBy)} at {atTime(landing.startedAt)} looks stuck: the task has been quiet since {atTime(t.lastActivityAt)}, so it may have stopped. You can try again below.
                  </span>
                ) : (
                  <span>
                    Approved. Running the pre-merge check{landing.command ? ` (${landing.command})` : ""}; this can take several minutes. Elapsed: {elapsed(now - Date.parse(landing.startedAt))}.
                  </span>
                )
              ) : (
                <span>
                  {landing.url && landing.text.includes(landing.url) ? (
                    <>
                      {landing.text.split(landing.url)[0]}
                      <a href={landing.url} target="_blank" rel="noreferrer">
                        {landing.url}
                      </a>
                      {landing.text.split(landing.url).slice(1).join(landing.url)}
                    </>
                  ) : (
                    landing.text
                  )}
                </span>
              )}
            </div>
          )}
          <TicketReviews reviews={reviews} />
          {t.systemState === "review" && (
            <Fold
              className="review-card"
              title="Review"
              hint={
                checking ? "checking and merging" :
                staleCheck ? "the merge check looks stuck; you can try again" :
                t.pullRequestNumber && t.pullRequestNote ? "waiting on the pull request" :
                open.length ? `waiting for ${who}${t.ownerSignoff ? ", then you" : ""}` :
                // Said from the decisions themselves (BOS-503), not guessed from the policy.
                t.signoff === "waiting" || t.signoff === "missing" ? "waiting for your sign-off" :
                t.signoff === "signed_off" ? "you signed it off; it merges next" :
                "waiting for you"
              }
            >
              {landing?.state === "running" && !landing.stale && (
                <div className="banner" role="status" aria-live="polite" style={{ flexWrap: "wrap" }}>
                  <span>
                    <strong>{PHASE_WORDS[landing.phase ?? ""] ?? "Checking and merging"}.</strong> Started by {startedByLabel(landing.startedBy)} at {atTime(landing.startedAt)}
                    {landing.command ? ` (${landing.command})` : ""}; this can take several minutes. Elapsed: {elapsed(now - Date.parse(landing.startedAt))}.
                  </span>
                </div>
              )}
              {staleCheck && landing?.state === "running" && (
                <div className="banner" role="status" aria-live="polite" style={{ flexWrap: "wrap" }}>
                  <span>
                    <strong>The merge check looks stuck.</strong> It was started by {startedByLabel(landing.startedBy)} at {atTime(landing.startedAt)}, and the task has been quiet since {atTime(t.lastActivityAt)}. It may have stopped, so nothing is running now: you can try again.
                  </span>
                </div>
              )}
              {t.pullRequestNumber && t.pullRequestNote && (
                <div className="banner" role="status" style={{ flexWrap: "wrap" }}>
                  <span>
                    Approved, and waiting on{" "}
                    {t.pullRequestUrl ? (
                      <a href={t.pullRequestUrl} target="_blank" rel="noreferrer">
                        pull request #{t.pullRequestNumber}
                      </a>
                    ) : (
                      `pull request #${t.pullRequestNumber}`
                    )}
                    . The host says: {t.pullRequestNote}
                  </span>
                  <button type="button" className="btn" disabled={busy} onClick={() => void mergeNow()}>
                    Try merging now
                  </button>
                </div>
              )}
              {open.length ? (
                <>
                  <p>
                    Waiting for {who}'s review. {t.ownerSignoff ? "When it approves, you'll be asked to sign it off." : "When it approves, this lands automatically, so you don't need to do anything."}
                  </p>
                  <details>
                    <summary style={{ cursor: "pointer", color: "var(--link)" }}>Decide now instead</summary>
                    <p className="muted" style={{ fontSize: 14 }}>
                      Deciding now skips the waiting review.
                    </p>
                    {decide}
                  </details>
                </>
              ) : checking ? null : (
                decide
              )}
            </Fold>
          )}
          {conflict && (
            <div className="card" role="alert" data-testid="edit-conflict" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 320px" }}>{conflict.text}</span>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  // The draft is kept; reloading brings in the latest so the owner can compare and save again.
                  setConflict(null);
                  ticket.reload();
                }}
              >
                Reload the latest
              </button>
            </div>
          )}
          {note && (
            <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"}>
              {note.text}
            </p>
          )}

          <ScrumMasterLog companyId={t.companyId} ticketId={t.id} folded />
          <TicketActivity ticketId={t.id} companyId={t.companyId} assignee={t.assignee} assigneeId={t.assigneeAgentId} agents={agents} reviews={reviews} ticketNumber={t.number} prefix={t.ref?.replace(/-[0-9]+$/, "") ?? null} />
        </div>

        <aside className="card ticket-props" aria-label="Properties">
          <div className="props-head">
            <h2 className="section-label">Work</h2>
            {/* Folded on a phone, the heading says what the panel holds: one line instead of a whole card. */}
            {propsCollapsed && (
              <span className="props-glance muted">
                · {t.systemState === "done" && t.outcome === "cancelled" ? "Cancelled" : (STATE_LABEL[t.systemState] ?? t.systemState)}
                {t.assignee ? ` · ${t.assignee}` : ""}
              </span>
            )}
            <button type="button" className="btn props-toggle" aria-expanded={!propsCollapsed} aria-controls="ticket-props-body" onClick={togglePanel}>
              {propsCollapsed ? "Show" : "Hide"}
            </button>
          </div>
          <div id="ticket-props-body" hidden={propsCollapsed}>
          <dl>
            <dt>
              Status
              <FieldHelp label="Status">Done closes it without merging. In review asks the reviewers. Ready and In progress wake the assignee.</FieldHelp>
            </dt>
            <dd>
              <span className={`tag ${t.systemState === "review" && (t.signoff === "waiting" || t.signoff === "missing") ? "amber" : (STATE_TONE[t.systemState] ?? "")}`}>{t.systemState === "done" && t.outcome === "cancelled" ? "Cancelled" : (STATE_LABEL[t.systemState] ?? t.systemState)}</span>
              <select aria-label="Change status" value="" onChange={(e) => e.target.value && void moveTo(e.target.value)}>
                <option value="">Change…</option>
                {Object.entries(STATE_LABEL).map(([k, label]) => (
                  <option key={k} value={k} disabled={k === t.systemState}>
                    {label}
                  </option>
                ))}
              </select>
              {blocking && (
                <div>
                  <label htmlFor="t-blocked-until">Blocked until (optional)</label>
                  <input id="t-blocked-until" type="datetime-local" value={blocking.until} onChange={(e) => setBlocking({ ...blocking, until: e.target.value })} />
                  <label htmlFor="t-blocked-reason">Why (one line)</label>
                  <input id="t-blocked-reason" maxLength={240} value={blocking.reason} disabled={!blocking.until} placeholder="e.g. waiting on the Friday deployment" onChange={(e) => setBlocking({ ...blocking, reason: e.target.value })} />
                  <small className="muted" style={{ display: "block" }}>With a time, the Scrum Master watchdog leaves it alone until then plus a grace period. Without one, the normal blocked limit applies.</small>
                  <button type="button" onClick={() => void block()}>Block</button> <button type="button" onClick={() => setBlocking(null)}>Cancel</button>
                </div>
              )}
              {t.systemState === "blocked" && t.blockedUntil && (
                <small className="muted" style={{ display: "block" }}>Blocked until {new Date(t.blockedUntil).toLocaleString()}{t.blockedUntilReason ? `: ${t.blockedUntilReason}` : ""}.</small>
              )}
            </dd>
            <dt>
              <label htmlFor="t-assignee">{t.systemState === "review" ? "Written by" : "Assigned to"}</label>
              <FieldHelp label="Assigned to">Assigning an agent starts it straight away. In review this shows who wrote the work.</FieldHelp>
            </dt>
            <dd>
              <select id="t-assignee" value={t.assigneeAgentId ?? (t.assignedToOwner ? "owner" : "")} disabled={t.systemState === "done"} onChange={(e) => void assign(e.target.value)}>
                <option value="">Nobody</option>
                <option value="owner">You</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              {open.length > 0 && t.systemState === "review" && <small className="muted" style={{ display: "block" }}>Reviewed by {who}.</small>}
            </dd>
            <dt>
              <label htmlFor="t-risk">Risk</label>
              <FieldHelp label="Risk">
                <RiskLevels tiers={tiers} current={t.risk} />
              </FieldHelp>
            </dt>
            <dd>
              <select id="t-risk" value={t.risk ?? ""} onChange={(e) => e.target.value && void patch({ risk: e.target.value as Risk })}>
                {!t.risk && <option value="">Not rated yet</option>}
                {RISKS.map((r) => (
                  <option key={r} value={r}>
                    {r[0]!.toUpperCase() + r.slice(1)}
                  </option>
                ))}
              </select>
              {!t.risk && <small className="muted" style={{ display: "block" }}>Not rated yet (counts as medium).</small>}
            </dd>
            <dt>
              <label htmlFor="t-size">Size</label>
              <FieldHelp label="Size">
                How big this task is compared with others: 1, 2, 3, 5 or 8. Whoever creates a task sets it. The Workflow page shows what each size really takes. <a href="#/workflow">What each size really takes, on the Workflow page</a>
              </FieldHelp>
            </dt>
            <dd>
              <select id="t-size" value={t.size ?? ""} onChange={(e) => void patch({ size: e.target.value ? Number(e.target.value) : null })}>
                <option value="">Not sized</option>
                {TASK_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </dd>
            <dt>
              <label htmlFor="t-watcher">Watcher</label>
              <FieldHelp label="Watcher">
                <p>An agent, such as a scrum master, that posts a short status update on this task and what it depends on.</p>
                <p>The watcher reports on this task and its sub-tasks, and steps in when all of them have stalled.</p>
                <p>Updates appear in Activity and your notifications.</p>
              </FieldHelp>
            </dt>
            <dd>
              <select id="t-watcher" value={t.watcherAgentId ?? ""} onChange={(e) => void watch(e.target.value || null, t.watchEveryMinutes ?? 30)}>
                <option value="">Off</option>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              {t.watcherAgentId && (
                <>
                  <select aria-label="How often the watcher reports" value={t.watchEveryMinutes ?? 30} onChange={(e) => void watch(t.watcherAgentId, Number(e.target.value))} style={{ marginTop: 6 }}>
                    {WATCH_EVERY.map(([m, label]) => (
                      <option key={m} value={m}>
                        {label}
                      </option>
                    ))}
                  </select>
                  <small className="muted">{t.watchedAt ? `Last report ${when(t.watchedAt)}.` : "A first report is on its way."}</small>
                </>
              )}
            </dd>
            <dt>Check again</dt>
            <dd>
              {mon ? (
                <>
                  <input type="datetime-local" aria-label="Check again at" value={mon.at} onChange={(e) => setMon({ ...mon, at: e.target.value })} />
                  <input aria-label="What to re-check" maxLength={500} value={mon.note} onChange={(e) => setMon({ ...mon, note: e.target.value })} style={{ marginTop: 6 }} />
                  <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                    <button type="button" className="btn" disabled={!mon.at || !mon.note.trim()} onClick={() => void monitor({ at: new Date(mon.at).toISOString(), note: mon.note.trim() })}>Save</button>
                    <button type="button" className="btn" onClick={() => setMon(null)}>Cancel</button>
                  </div>
                </>
              ) : t.monitorAt ? (
                <>
                  {inText(new Date(t.monitorAt).getTime() - Date.now())} · {new Date(t.monitorAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })} · check {t.monitorAttempts + 1} of {t.monitorMax}
                  <small className="muted" style={{ display: "block" }}>{t.monitorNote}</small>
                  <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                    <button type="button" className="btn" onClick={() => setMon({ at: localInput(new Date(t.monitorAt!)), note: t.monitorNote ?? "" })}>Edit</button>
                    <button type="button" className="btn" onClick={() => void monitor({ note: t.monitorNote })}>Check now</button>
                    <button type="button" className="btn" onClick={() => void monitor(null)}>Clear</button>
                  </div>
                </>
              ) : (
                (t.systemState === "in_progress" || t.systemState === "review") && t.assigneeAgentId && (
                  <button type="button" className="btn" onClick={() => setMon({ at: localInput(new Date(Date.now() + 3_600_000)), note: "" })}>Schedule a check</button>
                )
              )}
            </dd>
            <dt>Project</dt>
            <dd>
              <a href={`#/board/${t.projectId}`}>{t.project}</a>
            </dd>
            {t.pullRequestNumber && (
              <>
                <dt>Pull request</dt>
                <dd>
                  {t.pullRequestUrl ? (
                    <a href={t.pullRequestUrl} target="_blank" rel="noreferrer">
                      #{t.pullRequestNumber}
                    </a>
                  ) : (
                    `#${t.pullRequestNumber}`
                  )}
                  {t.systemState === "done" && t.mergeCommit ? " · merged" : ""}
                </dd>
              </>
            )}
            {t.branch && (
              <>
                <dt>Branch</dt>
                <dd className="mono" style={{ fontSize: 12, overflowWrap: "anywhere" }}>
                  {t.branch}
                </dd>
              </>
            )}
          </dl>
          <TicketRelated ticketId={t.id} companyId={t.companyId} />
          <h2 className="section-label">About</h2>
          <dl>
            <dt>Created</dt>
            <dd>{when(t.createdAt)}</dd>
            <dt>Last activity</dt>
            <dd>{when(t.lastActivityAt)}</dd>
            {t.lastPostAt && (
              <>
                <dt>Last post</dt>
                <dd>{ago(t.lastPostAt)}</dd>
              </>
            )}
          </dl>
          </div>
        </aside>
      </div>
    </>
  );
}
