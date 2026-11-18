import { useEffect, useRef, useState, type ReactNode } from "react";
import { figureText, HARNESSES, harnessLabel, modelFitProblem, parseStep, providerLabel, splitStepSource, type StepPiece, type StepSource, type Where } from "@boss-man/shared";
import { api, ApiError, type AdvisedDecision, type ClosedNoticeCard, type Company, type Decision, type DecisionTally, type DeployUpdate, type FundingSource, type ModelConfigView, type StallEvidence, type TeamAlert } from "../api";
import { art } from "../brand";
import { copyText, selectText } from "../clipboard";
import { State } from "../components/State";
import { usePoll } from "../hooks";
import { ageLabel, raisedAgo } from "../age";
import { clearDraft, readDraft, saveDraft } from "../drafts";
import { describe, useTranscript } from "../transcript";
import { when } from "./Runs";
import { OUTCOMES } from "./Rules";
import { SkillProposal } from "../components/SkillProposal";
import { OwnerMessageBox, tooLongToSend } from "../components/OwnerMessageBox";
import { DraftTextarea } from "../components/DraftTextarea";
import { ImagePreviews, useImageAttach, withAttachments } from "../components/ImageAttach";

// A card's note and own-word answer are kept in this browser as they are typed (BOS-637): a
// freeze or a reload must not cost the owner what they wrote. The cards arrive one at a time, so
// each field reads its own draft when it is first shown.
const draftNote = (id: string) => `decision/${id}/note`;
const draftOwn = (id: string) => `decision/${id}/own-answer`;

/** The answer sent when it is too long for the box: the text is in the .txt file the line links. */
export const ANSWER_IN_FILE = "My answer is too long to type here, so it's in this file (open it to read it whole):";

/**
 * The ticket a card's own-word answer is written on, so a picture or file pasted into it (BOS-759)
 * sits with that work: the ticket it blocks, else the one it holds up. Absent: the company's.
 */
export function cardTicketId(d: Decision): string | undefined {
  return d.blocks[0]?.ticketId ?? d.about?.[0]?.ticketId ?? undefined;
}

/** Attaches an owner's text as a .txt file, for an answer too long for the box; returns its Markdown. */
async function uploadText(companyId: string, ticketId: string | undefined, text: string) {
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(new Error("Couldn't read the text."));
    r.readAsDataURL(new Blob([text], { type: "text/plain" }));
  });
  const r = await api<{ markdown: string }>(`/api/companies/${companyId}/images`, { method: "POST", body: { data, name: "answer.txt", ...(ticketId ? { ticketId } : {}) } });
  return r.markdown;
}

const KIND: Record<string, { label: string; tone: string }> = {
  permission: { label: "Permission", tone: "" },
  budget: { label: "Budget", tone: "blue" },
  engagement: { label: "Engagement", tone: "green" },
  approval: { label: "Approval", tone: "blue" },
  signoff: { label: "Sign-off", tone: "blue" },
  plan: { label: "Plan", tone: "blue" },
  stale_blocker: { label: "Stale blocker", tone: "amber" },
  stalled_run: { label: "Stalled run", tone: "amber" },
  review_stall: { label: "Stalled review", tone: "amber" },
  question: { label: "Question", tone: "" },
  deploy: { label: "Production deploy", tone: "red" },
  self_deploy: { label: "Boss Man update", tone: "blue" },
  owner_todo: { label: "Waiting for you", tone: "amber" },
  owner_setup: { label: "Ready to use", tone: "green" },
  rule_proposal: { label: "Proposed rule", tone: "blue" },
  skill: { label: "Skill", tone: "blue" },
};

const EFFECT = {
  reads: { label: "Reads only", tone: "" },
  changes: { label: "Changes files", tone: "amber" },
  deletes: { label: "Deletes files", tone: "red" },
  network: { label: "Network", tone: "amber" },
  pushes: { label: "Pushes code", tone: "red" },
  unknown: { label: "Unknown", tone: "amber" },
};

const OPTION_HELP: Record<string, string> = {
  "Cancel run": "Cancel run: stops it; message the agent on the task to start again.",
  "Keep waiting": "Keep waiting: you'll be asked again in 30 minutes if it stays quiet.",
  "Leave it another hour": "Leave it another hour: the review stays with the same reviewer; you'll be asked again if it's still missed.",
  "Take the review myself": "Take the review myself: you become the reviewer and are woken to give the verdict.",
  "Give it to another reviewer": "Give it to another reviewer: goes to another qualified reviewer of the same kind, who is woken.",
  "Send it back to the author": "Send it back to the author: the ticket goes back to them to sort out (for example, a stale branch).",
};

/** What a permission request does, in words that finish "Let Bramble run a command that …?" (BOS-1236). */
const EFFECT_WORDS: Record<keyof typeof EFFECT, string> = {
  reads: "only reads files",
  changes: "writes files in its own checkout",
  deletes: "deletes files",
  network: "uses the network",
  pushes: "pushes code",
  unknown: "Boss Man can't classify",
};

/** A question of more than one sentence: the first is the heading, the rest a normal paragraph (BOS-1236). */
export function firstSentence(text: string): [string, string] {
  // A short question is already a heading (two lines at most); only a longer one is cut.
  if (text.length <= 140) return [text, ""];
  const m = /^([^\n]*?[.?!])\s+(?=[A-Z"“(])([\s\S]+)$/.exec(text);
  return m && !/\b(e\.g|i\.e|etc|vs)\.$/i.test(m[1]!) ? [m[1]!, m[2]!] : [text, ""];
}

/** What the owner reads when an answer didn't go: what failed and what to do (BOS-1236). */
export const sendFailed = (err: unknown) => `Couldn't send your answer: ${((err as Error).message ?? "").replace(/[.\s]+$/, "")}. Your note is kept; try again.`;
const fromYou =(reason: string) => reason.replace(/\bthe owner\b/gi, "you");
const agentOf = (d: Decision) => d.agentName ?? "The agent";

/**
 * The line under an answer button: what pressing it sets off (BOS-1236). Keyed on the option text and the kind
 * of card; an option with no known effect gets none, never a guess. A question's own options are their own effect.
 */
export function effectOf(d: Decision, option: string, alwaysWho = "any agent"): string | null {
  const type = d.context?.type;
  const agent = agentOf(d);
  if (d.options.includes("Approve plan")) {
    if (option === "Approve plan") {
      const earlier = /amends the approved plan of (\S+?)[;.]?(?:\s|$)/.exec(d.question)?.[1];
      const at = earlier && !Number.isNaN(Date.parse(earlier)) ? new Date(earlier).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : null;
      return earlier ? `${agent} carries on with these changes. Your earlier approval${at ? ` (of ${at})` : ""} stays in force either way.` : `${agent} starts building now. Nothing merges until the reviewers pass it and you sign it off.`;
    }
    if (option === "Keep planning") return `${agent} keeps planning and rewrites the plan, using your note. Nothing is built.`;
  }
  if (type === "risk_review") {
    const builder = d.context?.builder ?? "the builder";
    if (option === "Approve and merge") return `Boss Man runs the full check and merges it. If the check fails, it goes back to ${builder}, not to you.`;
    if (option === "Send it back") return `It goes back to ${builder} with your note. The reviews start again when it comes back.`;
  }
  if (d.kind === "permission" && !d.options.includes("Approve plan")) {
    if (option === "Allow once") return `The command runs this one time. ${agent} carries on.`;
    if (option === "Deny") return `The command doesn't run. ${agent} is told and has to find another way or ask again.`;
    const always = d.context?.always?.find((a) => a.label === option);
    if (always?.what) return `Always allow ${alwaysWho} to ${always.what}.`;
  }
  const help = OPTION_HELP[option];
  if (help && d.evidence) return help.replace(/^[^:]+:\s*/, "").replace(/^./, (c) => c.toUpperCase());
  return null;
}

type TicketLanding = { state: "running"; startedAt: string; startedBy: string; stale?: boolean; phase?: string } | { state: "finished"; text?: string };
const atTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const PHASE_WORDS: Record<string, string> = { queued: "Queued for a check slot", checking: "Merge check running", merging: "Merging", waiting_to_retry: "Trying again after the runner restarted" };
const startedByLabel = (who: string) => (/interrupted merge/i.test(who) ? "the automatic retry" : who);
const ALREADY_LANDING = /already being checked and merged|merge is running now/i;

/** The facts behind a stalled-run alert, in plain words: who, since when, the last sign of life, the runner, the last steps. */
const PREVIEW_LINES = 8;

/** Long text shows its first lines and opens in place, so a card stays short until it's read. */
export function MoreText({ text, label, lines: keep = PREVIEW_LINES, chars, refs, noun }: { text: string; label?: string; lines?: number; chars?: number; refs?: Decision["refs"]; /** Names what opens ("plan": "Show the whole plan (21 lines)"). */ noun?: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.split("\n");
  const byLines = lines.length > keep + 2 ? lines.slice(0, keep).join("\n") : text;
  const preview = chars && byLines.length > chars ? byLines.slice(0, chars).replace(/\s+\S*$/, "") : byLines;
  const long = preview !== text;
  return (
    <div>
      {label && <p style={{ fontWeight: 600, margin: "8px 0 4px" }}>{label}</p>}
      <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{long && !open ? <><Linked text={preview} refs={refs} />…</> : <Linked text={text} refs={refs} />}</p>
      {long && (
        <button type="button" className="linkish" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? "▾ Show less" : noun ? `▸ Show the whole ${noun} (${lines.length} line${lines.length === 1 ? "" : "s"})` : `▸ Show all${byLines !== text ? ` (${lines.length - keep} more lines)` : ""}`}
        </button>
      )}
    </div>
  );
}

/**
 * The one recommendation a card shows (BOS-328). Boss Man's rule sets `recommendedOption` when the
 * card is made; when the CEO has since advised Allow or Deny on a permission card, the CEO's call
 * is the headline and the primary button, and `rule` carries the rule's opposite verdict so the
 * card can say so instead of showing two recommendations.
 */
export function effectiveRecommendation(d: Pick<Decision, "kind" | "options" | "recommendedOption" | "context">): { option: string | null | undefined; rule: string | null } {
  const advice = d.context?.advice;
  if (d.kind !== "permission" || advice?.state !== "advised" || !advice.recommendation) return { option: d.recommendedOption, rule: null };
  const option = d.options.find((o) => (advice.recommendation === "allow" ? /^allow once$/i.test(o) : /^deny$/i.test(o)));
  if (!option) return { option: d.recommendedOption, rule: null };
  return { option, rule: d.recommendedOption && d.recommendedOption !== option ? d.recommendedOption : null };
}

/** The tickets a card is about, each as its own link; nothing when it has none. */
function TicketRefs({ about }: { about?: Array<{ ticketId: string; ref: string | null; title: string }> }) {
  if (!about?.length) return null;
  return (
    <ul className="ticket-refs" aria-label="Tickets this is about" style={{ listStyle: "none", padding: 0, margin: "4px 0", display: "flex", flexDirection: "column", gap: 2, overflowWrap: "anywhere" }}>
      {about.map((t) => (
        <li key={t.ticketId}>
          <a href={`#/tickets/${t.ticketId}`}>{t.ref ? <strong>{t.ref}</strong> : null}{t.ref ? " " : ""}{t.title}</a>
        </li>
      ))}
    </ul>
  );
}

/** BOS-1744: the project filter value for "no project": hires, model changes and other company-wide cards. */
export const COMPANY_WIDE = "company-wide";
const PROJECT_FILTER_KEY = "bossman.decisions.projectFilter";

/** The projects a card is for, by name; a card with none is company-wide. */
export function cardProjects(d: Pick<Decision, "projects">): Array<{ id: string; name: string }> {
  return d.projects ?? [];
}

/** Whether a card shows under a project filter (null = all, COMPANY_WIDE, or a project id). */
export function inProjectFilter(d: Pick<Decision, "projects">, pf: string | null): boolean {
  if (!pf) return true;
  const ps = cardProjects(d);
  return pf === COMPANY_WIDE ? ps.length === 0 : ps.some((p) => p.id === pf);
}

function readProjectFilter(): string | null {
  try { return localStorage.getItem(PROJECT_FILTER_KEY) || null; } catch { return null; }
}

function ProjectLabel({ d }: { d: Pick<Decision, "projects"> }) {
  const ps = cardProjects(d);
  return (
    <span className="tag project-tag" title="The project this card is for">
      {ps.length ? ps.map((p) => p.name).join(", ") : "Company-wide"}
    </span>
  );
}

const shortSha = (sha: string) => sha.slice(0, 8);

const HAND_EFFECT: Record<NonNullable<DeployUpdate["handEffect"]>, string> = {
  deployer: "This changes the script that runs deploys on your server (scripts/host-deployer.sh); Boss Man's own server doesn't change.",
  server: "This changes how Boss Man runs on your server: its compose file, Dockerfiles or other deploy scripts.",
  both: "This changes both the script that runs deploys on your server (scripts/host-deployer.sh) and how Boss Man runs: its compose file, Dockerfiles or other deploy scripts.",
};

/**
 * What a Boss Man update contains (BOS-213): the tickets merged since the live version, any commits
 * that aren't a ticket, why it needs a hand-apply, and anything that changes the risk. The same
 * block is shown on the approval card and on the to-do it leaves behind.
 */
function DeployUpdateView({ u }: { u: DeployUpdate }) {
  // (BOS-809) An update can list a dozen tickets; show the first three and "+N more" that expands, so a
  // card doesn't fill the screen with the whole list (the same on every update card, open or closed).
  const KEEP_TICKETS = 3;
  const shownChanges = u.changes.slice(0, KEEP_TICKETS);
  const hidden = u.changes.length - shownChanges.length;
  const [allShown, setAllShown] = useState(false);
  return (
    <div className="deploy-update" style={{ margin: "8px 0", fontSize: 14 }}>
      <p style={{ fontWeight: 600, margin: "0 0 4px" }}>
        This update brings {u.total} change{u.total === 1 ? "" : "s"} across {u.files} file{u.files === 1 ? "" : "s"} since the live version ({shortSha(u.from)} → {shortSha(u.to)}).
      </p>
      {u.changes.length > 0 && (
        <ul aria-label="Tickets in this update" style={{ listStyle: "none", padding: 0, margin: "4px 0", display: "flex", flexDirection: "column", gap: 2 }}>
          {(allShown ? u.changes : shownChanges).map((c) => (
            <li key={c.ticketId} style={{ overflowWrap: "anywhere" }}>
              <a href={`#/tickets/${c.ticketId}`}><strong>{c.ref}</strong> {c.title}</a>
            </li>
          ))}
          {hidden > 0 && (
            <li>
              <button type="button" className="linkish" onClick={() => setAllShown((v) => !v)}>
                {allShown ? "Show fewer" : `+${hidden} more`}
              </button>
            </li>
          )}
          {u.more > 0 && (
            <li className="muted">
              and {u.more} more. <a href="#/board">See all the tickets</a>.
            </li>
          )}
        </ul>
      )}
      {u.otherCommits.length > 0 && (
        <details>
          <summary>Other commits: {u.otherCommits.length}</summary>
          <ul style={{ paddingLeft: 20, margin: "4px 0" }}>
            {u.otherCommits.map((s, i) => (
              <li key={i} style={{ overflowWrap: "anywhere" }}><span className="mono muted">{s}</span></li>
            ))}
          </ul>
        </details>
      )}
      {u.handBecause && (
        <p style={{ margin: "6px 0 2px" }}>
          {u.handBecause}
          {u.handFiles?.length ? <> Files changed: <span className="mono" style={{ overflowWrap: "anywhere" }}>{u.handFiles.join(", ")}</span>.</> : null}
        </p>
      )}
      {u.handEffect && <p style={{ margin: "2px 0" }}>{HAND_EFFECT[u.handEffect]}</p>}
      {u.needsDeployerCopy !== undefined && (
        <p style={{ margin: "2px 0" }}>Deployer copy: {u.needsDeployerCopy ? "needed" : "not needed"}.</p>
      )}
      {u.needsRunnerUpdate !== undefined && (
        <p style={{ margin: "2px 0" }}>Runner update afterwards: {u.needsRunnerUpdate ? "needed" : "not needed"}.</p>
      )}
      {u.risks.length > 0 && (
        <div>
          <p style={{ fontWeight: 600, margin: "8px 0 2px" }}>Worth knowing</p>
          <ul style={{ paddingLeft: 20, margin: "2px 0" }}>
            {u.risks.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One command to paste, in its own block with a Copy button that copies exactly this text (BOS-269). */
function CommandBlock({ command, where }: { command: string; where?: Where }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const pre = useRef<HTMLPreElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const alive = useRef(true);
  // Clear the reset timer on unmount: a timer that outlives the page fires after the DOM is gone (BOS-1783).
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimeout(timer.current);
    };
  }, []);
  const copy = async () => {
    const ok = await copyText(command);
    if (!alive.current) return;
    setState(ok ? "copied" : "failed");
    if (!ok) selectText(pre.current);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };
  const label = state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy, select the text instead" : "Copy";
  return (
    <div style={{ margin: "6px 0" }}>
      {where && (
        <div style={{ fontSize: 13, color: "var(--muted, #888)", margin: "0 0 2px 2px" }}>
          On <strong>{where.host}</strong>, as {where.as === "root" ? <strong>root</strong> : "the logged-in account"}.
        </div>
      )}
      <div data-command style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        {/* Sideways only (BOS-962 sweep, same as BOS-554): the command wraps, so it never needs to scroll vertically, and without overflow-y: hidden a one-pixel overflow would swallow the wheel. */}
        <pre ref={pre} style={{ flex: 1, minWidth: 0, margin: 0, padding: "8px 10px", overflowX: "auto", overflowY: "hidden", whiteSpace: "pre-wrap", overflowWrap: "anywhere", background: "var(--field)", color: "var(--head)", border: "1px solid var(--line-strong)", fontFamily: "var(--mono)", borderRadius: 6, fontSize: 13 }}>
          <code>{command}</code>
        </pre>
        <button type="button" onClick={copy} aria-label="Copy this command" aria-live="polite" style={{ flex: "none", maxWidth: "42%", whiteSpace: "normal", lineHeight: 1.2, alignSelf: "stretch", padding: "0 10px" }}>{label}</button>
      </div>
    </div>
  );
}

/**
 * A step's text: sentences as before, and each fenced block as its own command with a Copy button (BOS-269, BOS-427).
 * The fences are read by the same parser as the server's card lint (BOS-550), so a step the lint accepts renders
 * its commands as blocks, labelled fence lines and indented list items included.
 */
function StepText({ text, refs, stored }: { text: string; refs?: Decision["refs"]; stored?: StepSource | null }) {
  // BOS-1665: the server takes the R19 tag out once and keeps the step's source beside it (`stored`). A card raised
  // before that still has the tag in its text, so it is split here too; either way the owner reads a muted line.
  const split = splitStepSource(text);
  const shown = split.text;
  const source = stored ?? split.source;
  const parsed = parseStep(shown);
  const parts: StepPiece[] = parsed.length ? parsed : [{ type: "text", text: shown }];
  return (
    <>
      {parts.map((p, i) => (p.type === "command" ? <CommandBlock key={i} command={p.text} where={p.where} /> : <span key={i} style={{ display: "block", whiteSpace: "pre-wrap" }}><Linked text={p.text} refs={refs} /></span>))}
      {source?.kind === "seen" && (
        <span className="muted" data-step-source style={{ display: "block", fontSize: 12 }}>Written from <a href={`/api/ticket-images/${source.imageId}`} target="_blank" rel="noreferrer">your screenshot</a>{source.takenAt ? ` of ${source.takenAt}` : ""}</span>
      )}
      {source?.kind === "notSeen" && (
        <span className="muted" data-step-source style={{ display: "block", fontSize: 12 }}>Written from <a href={source.url} target="_blank" rel="noreferrer noopener">the vendor's docs</a>, {source.date}</span>
      )}
    </>
  );
}

function Linked({ text, refs }: { text: string; refs?: Decision["refs"] }) {
  if (!refs || !Object.keys(refs).length) return <>{text}</>;
  return (
    <>
      {text.split(/\b([A-Za-z][A-Za-z0-9]{0,9}-\d{1,9})\b/).map((part, i) => {
        const t = i % 2 ? refs[part.toUpperCase()] : undefined;
        return t ? <a key={i} href={`#/tickets/${t.ticketId}`} title={t.title}>{part}</a> : part;
      })}
    </>
  );
}

function StallEvidenceView({ e }: { e: StallEvidence }) {
  const { items } = useTranscript(e.runId, 60_000);
  const steps = items.map((i) => ({ i, d: describe(i) })).filter(({ d }) => d.tone !== "text" || d.body?.trim());
  const last = e.lastStep ? describe(e.lastStep) : null;
  return (
    <div className="stall-evidence" style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
      <p>
        {e.agent ?? "An agent"} on {e.ticketId ? <a href={`#/tickets/${e.ticketId}`}>{e.ticket ?? "a task"}</a> : (e.ticket ?? "no task")}. Run started {when(e.startedAt)}.
      </p>
      <p>
        {e.lastEventAt ? `Last activity ${ageLabel(Date.now() - new Date(e.lastEventAt).getTime())}${last ? `: ${last.label}${last.body && last.tone !== "text" ? ` ${last.body.slice(0, 100)}` : ""}` : "."}` : "No sign of life since it was sent to the runner."}
      </p>
      <p>{e.runner.connected ? "Runner: connected." : `Runner: offline${e.runner.lastSeenAt ? ` since ${when(e.runner.lastSeenAt)}` : ""}.`}</p>
      <p>{e.waitingOnOwner ? "It is waiting on you for a permission answer." : "It is not waiting on you."}</p>
      {steps.length > 0 && (
        <>
          <ol className="run-steps">
            {steps.slice(-5).map(({ i, d }) => (
              <li key={i.seq} className={d.tone}>
                <time className="mono muted">{new Date(i.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</time>
                <span>{d.label}</span>
              </li>
            ))}
          </ol>
          <p className="muted" style={{ fontSize: 12 }}>
            <a href={`#/runs/${e.runId}`}>See the whole run</a>
          </p>
        </>
      )}
    </div>
  );
}

/** What the team did with a decision, in the owner's words. */
function settledWord(answer: string) {
  if (answer === "Allow once") return "allowed";
  if (answer === "Deny") return "denied";
  if (answer === "Keep waiting") return "kept waiting";
  if (answer === "Cancel run") return "cancelled the run";
  if (answer === "Got it") return "settled it";
  return answer;
}

function kindOf(d: Decision) {
  const ctx = (d as Decision & { context?: { type?: string } }).context;
  const key = ctx?.type === "deploy" || ctx?.type === "self_deploy" || ctx?.type === "rule_proposal" ? ctx.type : d.options.includes("Approve plan") ? "plan" : ctx?.type === "risk_review" ? "signoff" : ctx?.type === "review_stall" ? "review_stall" : d.kind;
  return KIND[key] ?? { label: d.kind.replace(/_/g, " "), tone: "" };
}


/** Current vs proposed harness, provider, model and paid from on a model-change card (BOS-128). */
function ModelChange({ d, editing, onEdit, onCancel, onSubmit, busy }: { d: Decision; editing: boolean; onEdit: () => void; onCancel: () => void; onSubmit: (config: ModelConfigView) => void; busy: boolean }) {
  const sources = usePoll((signal) => api<FundingSource[]>("/api/funding-sources", { signal }), 60_000, `model-change-sources-${d.id}`);
  const before = d.context?.before;
  // Once answered, show what actually landed (the owner's Edit values), not the CEO's proposal.
  const proposed = d.context?.applied?.config ?? d.context?.proposed;
  const [form, setForm] = useState<ModelConfigView>(proposed ?? { harness: "claude", provider: "anthropic", model: "", fundingSourceId: "" });
  if (!before || !proposed) return null;
  const fitProblem = modelFitProblem(form.harness, form.provider, form.model);
  const paidFrom = (c: ModelConfigView) => c.fundingSourceName ?? sources.data?.find((s) => s.id === c.fundingSourceId)?.name ?? c.fundingSourceId;
  const rows: Array<[string, string, string]> = [
    ["Harness", harnessLabel(before.harness), harnessLabel(proposed.harness)],
    ["Provider", providerLabel(before.provider), providerLabel(proposed.provider)],
    ["Model", before.model || "default", proposed.model || "default"],
    ["Paid from", paidFrom(before), paidFrom(proposed)],
  ];
  return (
    <div style={{ marginTop: 8 }}>
      <table className="table" aria-label="Current and proposed model setup">
        <thead>
          <tr>
            <th />
            <th>Current</th>
            <th>Proposed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, current, next]) => (
            <tr key={label}>
              <th scope="row">{label}</th>
              <td className={current === next ? "muted" : undefined}>{current}</td>
              <td><strong>{next}</strong></td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.context?.applied && (
        <p className="muted" role="status">
          Applied {when(d.context.applied.at)}. It takes effect {d.context.applied.afterRunId ? "after the run that was in progress ended" : "from the next run"}.
        </p>
      )}
      {editing ? (
        <form
          style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            if (fitProblem) return;
            onSubmit({ harness: form.harness, provider: form.provider, model: form.model, fundingSourceId: form.fundingSourceId });
          }}
        >
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
            <div className="field">
              <label htmlFor={`mc-harness-${d.id}`}>Harness</label>
              <select id={`mc-harness-${d.id}`} value={form.harness} onChange={(e) => setForm({ ...form, harness: e.target.value, model: "" })}>
                {HARNESSES.map((h) => (
                  <option key={h.value} value={h.value}>{h.label}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`mc-provider-${d.id}`}>Provider</label>
              <select id={`mc-provider-${d.id}`} value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })}>
                {(sources.data ?? []).map((s) => s.provider).filter((p, i, all) => all.indexOf(p) === i).map((p) => (
                  <option key={p} value={p}>{providerLabel(p)}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor={`mc-model-${d.id}`}>Model</label>
              <input id={`mc-model-${d.id}`} className="mono" required value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor={`mc-funding-${d.id}`}>Paid from</label>
              <select
                id={`mc-funding-${d.id}`}
                required
                value={form.fundingSourceId}
                onChange={(e) => {
                  const source = sources.data?.find((s) => s.id === e.target.value);
                  setForm({ ...form, fundingSourceId: e.target.value, ...(source ? { provider: source.provider } : {}) });
                }}
              >
                <option value="">Choose a funding source</option>
                {(sources.data ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({providerLabel(s.provider)})</option>
                ))}
              </select>
            </div>
          </div>
          {/* The same check the server makes, shown before saving so a model this account can't serve is clear (BOS-477). */}
          {fitProblem && (
            <p className="error" role="alert">{fitProblem}</p>
          )}
          <div className="actions">
            <button type="submit" className="btn primary" disabled={busy || !form.model || !form.fundingSourceId || !!fitProblem}>Save and approve</button>
            <button type="button" className="btn" onClick={onCancel}>Cancel</button>
          </div>
          <small className="muted">The same checks apply as when the CEO proposed it. The change takes effect between runs.</small>
        </form>
      ) : (
        <button type="button" className="linkish" onClick={onEdit}>
          Edit these values before approving
        </button>
      )}
    </div>
  );
}

/** The card id in a #/decisions/<id> link (BOS-1078), or null. Safe where there is no window (a static render). */
export function linkedCardOf(hash: string): string | null {
  const [page, id] = hash.replace(/^#\/?/, "").split("/");
  return page === "decisions" && id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) ? id : null;
}

function useLinkedCard(): string | null {
  const read = () => (typeof window === "undefined" ? null : linkedCardOf(window.location.hash));
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = () => setId(read());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return id;
}

export function Decisions({ decisions, companies, loaded, agentsWorking, onAnswered, banner, elsewhere = [], onPickCompany, withTeam = [], advised = [], closedNotices = [], tally }: { decisions: Decision[]; companies: Company[]; loaded: boolean; agentsWorking: number; onAnswered: () => void; banner?: ReactNode | ((folded: boolean) => ReactNode); elsewhere?: Array<{ id: string; name: string; count: number }>; onPickCompany?: (id: string) => void; withTeam?: TeamAlert[]; advised?: AdvisedDecision[]; closedNotices?: ClosedNoticeCard[]; tally?: DecisionTally | null }) {
  const [filter, setFilter] = useState<string | null>(null);
  const [savedProject, setSavedProject] = useState<string | null>(readProjectFilter);
  const pickProject = (v: string | null) => {
    setSavedProject(v);
    try { if (v) localStorage.setItem(PROJECT_FILTER_KEY, v); else localStorage.removeItem(PROJECT_FILTER_KEY); } catch { /* private browsing: the choice just isn't kept */ }
  };
  // A link straight to one card (#/decisions/<id>, BOS-1078: the Merge queue names the card holding a merge):
  // that card is scrolled to and marked once it is on the page.
  const linkedId = useLinkedCard();
  useEffect(() => {
    if (!linkedId) return;
    document.getElementById(`decision-${linkedId}`)?.scrollIntoView?.({ block: "start" });
  }, [linkedId, loaded, decisions.length]);
  const [answered, setAnswered] = useState<Record<string, string>>({});
  const [alwaysScopes, setAlwaysScopes] = useState<Record<string, "agent" | "company">>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [endedHere, setEndedHere] = useState<Record<string, boolean>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  // Written to this browser as they are typed, so a freeze keeps them (BOS-637).
  const editNote = (id: string, text: string) => {
    setNotes((n) => ({ ...n, [id]: text }));
    saveDraft(draftNote(id), text);
  };
  const forgetNote = (id: string) => {
    setNotes(({ [id]: _, ...rest }) => rest);
    clearDraft(draftNote(id));
  };
  // A workflow-retro change's optional wiki link, e.g. a page slug with a section after it.
  const [reasonLinks, setReasonLinks] = useState<Record<string, string>>({});
  // The owner's own answer to an agent's question, being written; absent while not.
  const [ownWords, setOwnWords] = useState<Record<string, string>>({});
  const editOwn = (id: string, text: string) => {
    setOwnWords((w) => ({ ...w, [id]: text }));
    saveDraft(draftOwn(id), text);
  };
  const forgetOwn = (id: string) => {
    setOwnWords(({ [id]: _, ...rest }) => rest);
    clearDraft(draftOwn(id));
  };
  // Pictures and files pasted or picked into an answer in the owner's own words (BOS-759). `answering`
  // is the card whose box is open, so an upload goes to that card's ticket.
  const answering = useRef<string | undefined>(undefined);
  const img = useImageAttach(companies[0]?.id, undefined, { ticketIdOf: () => answering.current });
  // A team plan's ticked hires, by position; all of them until the owner unticks one.
  const [picks, setPicks] = useState<Record<string, number[]>>({});
  // A model-change card being edited before approval.
  const [modelEdits, setModelEdits] = useState<Record<string, boolean>>({});
  // "Ask the CEO for advice": the optional one-line note being written, absent while not.
  const [adviceNote, setAdviceNote] = useState<Record<string, string>>({});
  // "Reassign" on a stale-blocker card: the agent being picked, and who has the ticket now; absent while not picking.
  const [reassign, setReassign] = useState<Record<string, { pick: string; current: string | null }>>({});
  // A merge started from the ticket page (or a sweep) while its approval card is still open.
  const [landings, setLandings] = useState<Record<string, TicketLanding | null>>({});
  const [notices, setNotices] = useState<Record<string, string>>({});
  // The answer being sent as a .txt file, for one too long to send as a message.
  const [attaching, setAttaching] = useState<string | null>(null);
  const inFlight = useRef(new Set<string>());
  // (BOS-799) The reason box on each workflow-change card, so a tap on its disabled buttons can point at it.
  const reasonBoxes = useRef(new Map<string, HTMLTextAreaElement | null>());
  // (BOS-739) Tell the server the owner has seen a hand-apply card, once per card, so a later system
  // close knows they may be part-way through its steps and also tells their feed. Best effort: a failed
  // call changes nothing on the page.
  const openedSent = useRef(new Set<string>());
  const markOpened = (id: string) => {
    if (openedSent.current.has(id)) return;
    openedSent.current.add(id);
    void api(`/api/decisions/${id}/opened`, { method: "POST", body: {} }).catch(() => undefined);
  };
  useEffect(() => {
    for (const d of decisions) {
      const c = d.context;
      const handApply = (c?.type === "self_deploy" && c.handSteps?.length) || (c?.type === "owner_todo" && !!c.steps?.length);
      // (BOS-1691) Any card the owner opened by its link counts too: if it then leaves the list, they are told why.
      if (handApply || d.id === linkedId) markOpened(d.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decisions, linkedId]);
  const landingIds = [...new Set(decisions.filter((d) => !answered[d.id] && d.context?.type === "risk_review" && d.context.ticketId).map((d) => d.context!.ticketId!))];
  const landingKey = landingIds.sort().join(",");
  useEffect(() => {
    if (!landingIds.length) return;
    let stopped = false;
    const load = async () => {
      const entries = await Promise.all(
        landingIds.map(async (ticketId) => {
          try {
            return [ticketId, (await api<{ landing: TicketLanding | null }>(`/api/tickets/${ticketId}/landing`)).landing] as const;
          } catch {
            return [ticketId, null] as const;
          }
        }),
      );
      if (!stopped) setLandings(Object.fromEntries(entries));
    };
    void load();
    const timer = setInterval(() => void load(), 2_500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [landingKey]);
  const openReassign = async (d: Decision) => {
    const id = d.context?.blockerTicketId;
    let current: string | null = null;
    try {
      if (id) current = (await api<{ assigneeAgentId: string | null }>(`/api/tickets/${id}`)).assigneeAgentId;
    } catch {
      // The picker still works without knowing who has it now.
    }
    setReassign((r) => ({ ...r, [d.id]: { pick: "", current } }));
  };
  const askAdvice = async (d: Decision) => {
    setBusy(d.id);
    try {
      const note = adviceNote[d.id]?.trim();
      await api(`/api/decisions/${d.id}/ask-advice`, { method: "POST", body: note ? { note } : {} });
      setAdviceNote(({ [d.id]: _, ...rest }) => rest);
      setErrors(({ [d.id]: _, ...rest }) => rest);
      onAnswered();
    } catch (err) {
      setErrors((e) => ({ ...e, [d.id]: (err as Error).message }));
    } finally {
      setBusy(null);
    }
  };

  // Project chips come from the open cards, so a new project appears as soon as a card names it. A remembered
  // project that no card names any more falls back to "All projects" rather than hiding everything.
  const projectOptions = [...new Map(decisions.filter((d) => !filter || d.companyId === filter).flatMap((d) => cardProjects(d).map((p) => [p.id, p.name] as const))).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const hasCompanyWide = decisions.some((d) => (!filter || d.companyId === filter) && cardProjects(d).length === 0);
  const projectFilter = savedProject && ((savedProject === COMPANY_WIDE && hasCompanyWide) || projectOptions.some(([id]) => id === savedProject)) ? savedProject : null;
  const shown = decisions.filter((d) => (!filter || d.companyId === filter) && inProjectFilter(d, projectFilter));
  const shownNotices = closedNotices.filter((n) => !filter || n.companyId === filter);
  // (BOS-551) The server puts waiting cards last and marks them; show them in the "Waiting, nothing to do
  // yet" group instead of the numbered list. Anything not marked keeps its place in the main list.
  const queueCards = shown.filter((d) => !d.waiting);
  // (BOS-1691) A card folded away while its author re-checks it leaves a line in the main list, never a silent gap.
  const recheckCards = shown.filter((d) => !!d.waiting && !!d.rechecking?.hidden);
  const waitingCards = shown.filter((d) => !!d.waiting && !d.rechecking?.hidden);
  // (BOS-1691) Cards that left the list in the last 2 hours say why in plain sight, not only inside the "Closed" fold.
  const recentNotices = shownNotices.filter((n) => Date.parse(n.notice.until) > Date.now());
  // (BOS-969, BOS-996) The heading takes both numbers from the server tally, the same figure the menu
  // badge shows; it sends no numbers of its own. The app already polls that tally for the badge and
  // refreshes it on every answer, so the heading reads it from there and only asks itself if it is
  // missing (the app's read failed). A card the owner answers here leaves the count straight away, so
  // the heading never shows it as still to do while the page waits for its next read.
  const viewQuery = filter ? `?companyId=${filter}` : "";
  const tallyPoll = usePoll(
    (signal) => (tally ? Promise.resolve(tally) : api<DecisionTally>(`/api/decisions/tally${viewQuery}`, { signal }).catch(() => null)),
    10_000,
    `decisions-tally-page-${filter ?? ""}`,
  );
  const answeredHere = shown.filter((d) => !!answered[d.id]);
  const answeredQueue = answeredHere.filter((d) => !d.waiting).length;
  const answeredWaiting = answeredHere.filter((d) => !!d.waiting).length;
  // Until the first tally arrives, the cards themselves stand in, so the heading is never blank.
  // With a project chosen the server's tally (all projects) no longer fits, so the count comes from the visible cards.
  const counted = projectFilter ?{ open: queueCards.length, waiting: waitingCards.length } : tally ?? tallyPoll.data ?? { open: queueCards.length, waiting: waitingCards.length };
  const counts = {
    open: Math.max(counted.open - answeredQueue, 0),
    waiting: Math.max(counted.waiting - answeredWaiting, 0),
  };
  // Too long for an answer: the text goes in a .txt file, and the agent is told where to read it whole.
  const answerAsFile = async (d: Decision, long: string) => {
    if (inFlight.current.has(d.id)) return;
    inFlight.current.add(d.id);
    setBusy(d.id);
    setAttaching(d.id);
    answering.current = cardTicketId(d);
    try {
      // Attach it to the ticket the card is about, so it sits with the work; else the company, which agents still open.
      const ticketId = d.context?.type === "risk_review" ? d.context.ticketId ?? undefined : d.context?.blockerTicketId ?? undefined;
      const markdown = await uploadText(d.companyId, ticketId || cardTicketId(d), long);
      // Anything pasted into the box goes with the file too, so nothing the owner attached is lost.
      await api(`/api/decisions/${d.id}/answer`, { method: "POST", body: { answer: withAttachments(`${ANSWER_IN_FILE}\n\n${markdown}`, img.attached), custom: true } });
      setAnswered((a) => ({ ...a, [d.id]: ANSWER_IN_FILE }));
      forgetOwn(d.id);
      img.clear();
      setErrors(({ [d.id]: _, ...rest }) => rest);
      setNotices(({ [d.id]: _, ...rest }) => rest);
      onAnswered();
    } catch (err) {
      setErrors((e) => ({ ...e, [d.id]: sendFailed(err) }));
    } finally {
      setBusy(null);
      setAttaching(null);
    }
  };
  // Sends an answer in the owner's own words; it needs some text or an attachment (BOS-759).
  const sendOwn = (d: Decision) => {
    const text = ownWords[d.id]?.trim() ?? "";
    if (!text && !img.attached.length) return;
    void answer(d, text, { custom: true });
  };
  const answer = async (d: Decision, option: string, extra: { custom?: boolean; modelConfig?: ModelConfigView; assigneeAgentId?: string } = {}) => {
    const isAlways = d.context?.always?.some((a) => a.label === option) ?? false;
    // A second click can land before React re-renders the disabled button: refuse it here too.
    if (inFlight.current.has(d.id)) return;
    inFlight.current.add(d.id);
    setBusy(d.id);
    // An own-word answer carries its pictures and files on the end, as a message does (BOS-759). Only
    // for this card: the box sends what is shown, and the server refuses a custom answer anywhere else.
    const answerText = extra.custom && ownWords[d.id] !== undefined ? withAttachments(option.trim(), img.attached).trim() : option;
    try {
      const note = notes[d.id]?.trim();
      const reasonLink = reasonLinks[d.id]?.trim();
      const r = await api<{ endedHere?: boolean }>(`/api/decisions/${d.id}/answer`, { method: "POST", body: { answer: answerText, ...(note ? { note } : {}), ...(reasonLink ? { reasonLink } : {}), ...(extra.custom ? { custom: true } : {}), ...(isAlways ? { alwaysScope: d.context?.alwaysAgent ? (alwaysScopes[d.id] ?? "agent") : "company" } : {}), ...(extra.modelConfig ? { modelConfig: extra.modelConfig } : {}), ...(extra.assigneeAgentId ? { assigneeAgentId: extra.assigneeAgentId } : {}), ...(d.context?.hires && option === "Hire the ticked ones" ? { picks: picks[d.id] ?? d.context.hires.map((_, i) => i) } : {}) } });
      setAnswered((a) => ({ ...a, [d.id]: option }));
      // The card is answered, so its kept note and answer are done with, and the attachments went with it.
      forgetNote(d.id);
      forgetOwn(d.id);
      img.clear();
      setModelEdits(({ [d.id]: _, ...rest }) => rest);
      if (r?.endedHere) setEndedHere((x) => ({ ...x, [d.id]: true }));
      setErrors(({ [d.id]: _, ...rest }) => rest);
      setNotices(({ [d.id]: _, ...rest }) => rest);
      onAnswered();
    } catch (err) {
      const ticketId = d.context?.type === "risk_review" ? d.context.ticketId : null;
      if (err instanceof ApiError && err.status === 409 && ALREADY_LANDING.test(err.message)) {
        const current = ticketId ? await api<{ landing: TicketLanding | null }>(`/api/tickets/${ticketId}/landing`).then((r) => r.landing).catch(() => null) : null;
        if (ticketId) setLandings((l) => ({ ...l, [ticketId]: current }));
        const since = current?.state === "running" ? ` since ${atTime(current.startedAt)}` : "";
        setNotices((n) => ({ ...n, [d.id]: `Already being checked and merged${since}; nothing more to do.` }));
        setErrors(({ [d.id]: _, ...rest }) => rest);
      } else setErrors((e) => ({ ...e, [d.id]: sendFailed(err) }));
    } finally {
      inFlight.current.delete(d.id);
      setBusy(null);
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Decisions</h1>
          <p className="sub">
            {figureText("decisions.needYou", counts.open)}
            {counts.waiting > 0 ? ` · ${figureText("decisions.withTeam", counts.waiting)}` : ""}
            {filter ? "" : companies.length === 1 ? ` in ${companies[0]!.name}` : " across all companies"}, newest first.
          </p>
          {elsewhere.length > 0 && (
            <p className="sub">
              {/* R43: the other companies' own "needs you" figure, the one the company switcher shows (it counted every open card). */}
              Also:{" "}
              {elsewhere.map((c, i) => (
                <span key={c.id}>
                  {i > 0 && ", "}
                  <button type="button" className="linkish" onClick={() => onPickCompany?.(c.id)}>
                    {figureText("decisions.needYou", c.count)} in {c.name}
                  </button>
                </span>
              ))}
            </p>
          )}
        </div>
        {companies.length > 1 && (
          <div role="group" aria-label="Filter by company" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="chip" aria-pressed={filter === null} onClick={() => setFilter(null)}>
              All companies
            </button>
            {companies.map((c) => (
              <button type="button" key={c.id} className="chip" aria-pressed={filter === c.id} onClick={() => setFilter(c.id)}>
                {c.name}
              </button>
            ))}
          </div>
        )}
        {(projectOptions.length > 0 || hasCompanyWide) && (projectOptions.length + (hasCompanyWide ? 1 : 0) > 1 || projectFilter) && (
          <div role="group" aria-label="Filter by project" style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <button type="button" className="chip" aria-pressed={projectFilter === null} onClick={() => pickProject(null)}>
              All projects
            </button>
            {projectOptions.map(([id, name]) => (
              <button type="button" key={id} className="chip" aria-pressed={projectFilter === id} onClick={() => pickProject(id)}>
                {name}
              </button>
            ))}
            {hasCompanyWide && (
              <button type="button" className="chip" aria-pressed={projectFilter === COMPANY_WIDE} onClick={() => pickProject(COMPANY_WIDE)}>
                Company-wide
              </button>
            )}
          </div>
        )}
      </header>
      {typeof banner === "function" ? (queueCards.length > 0 ? null : banner(false)) : banner}
      {withTeam.length > 0 && (
        // Alerts the Scrum Master or CEO still hold: listed so nothing is hidden, but not the owner's to answer yet.
        <details className="sub">
          <summary>Being handled by the team ({withTeam.length})</summary>
          <ul>
            {withTeam.map((a) => (
              <li key={a.id}>
                {a.question} <span className="muted">· with {a.holder} since {when(a.since)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {loaded && linkedId && !decisions.some((d) => d.id === linkedId) && (
        // (BOS-1159) A link to a card that is gone says so, instead of opening a page with nothing on it.
        <p role="status" data-testid="linked-card-gone" className="card" style={{ fontWeight: 600 }}>
          That card is not open any more: it was answered or withdrawn, or it belongs to another company. The Board stops showing it on its next refresh.
        </p>
      )}
      {loaded && queueCards.length === 0 && waitingCards.length === 0 && recheckCards.length === 0 ? (
        agentsWorking > 0 ? (
          <State img={art.busy} alt="Agents at work, nothing needs you" title="Nothing needs you yet">
            <p>{agentsWorking === 1 ? "1 agent is" : `${agentsWorking} agents are`} working. They'll raise a decision here when they need an answer, an approval or more budget.</p>
          </State>
        ) : (
          <State img={art.done} alt="Nothing needs you" title="Nothing needs you">
            <p>Your agents will raise a decision here when they need an answer, an approval or more budget.</p>
          </State>
        )
      ) : (
        <>
          {queueCards.length > 0 && (
          <>
          <ol className="queue">
            {queueCards.map((d) => {
              const k = kindOf(d);
              const done = answered[d.id];
              const x = d.context?.explain;
              const rule = d.context?.rule;
              const advice = d.context?.advice;
              const eff = effectiveRecommendation(d);
              const ranOut = d.context?.handoverRanOut;
              const asking = advice?.state === "asking";
              const ticketId = d.context?.type === "risk_review" ? d.context.ticketId : null;
              const land = ticketId ? landings[ticketId] : null;
              const checking = land?.state === "running" && !land.stale;
              const staleCheck = land?.state === "running" && !!land.stale;
              return (
                // (BOS-1691) Touching or typing in a card counts as having it open, so a later close or re-check tells the feed.
                <li className={`decision${d.id === linkedId ? " linked" : ""}`} id={`decision-${d.id}`} key={d.id} onPointerDown={() => markOpened(d.id)} onFocusCapture={() => markOpened(d.id)} style={asking ? { opacity: 0.7 } : undefined} aria-busy={asking || undefined} aria-current={d.id === linkedId ? "true" : undefined}>
                  <div className="body">
                    <div className="head-line">
                      {d.step ? (
                        <span className="tag blue" title="Do this next, in this order" aria-label={`Step ${d.step}`}>
                          Step {d.step}
                        </span>
                      ) : null}
                      <ProjectLabel d={d} />
                      <span className={`tag ${k.tone}`}>{k.label}</span>
                      {d.about?.map((t) => (
                        <a key={t.ticketId} className="ref-chip mono" href={`#/tickets/${t.ticketId}`} title={t.title}>{t.ref ?? "Ticket"}</a>
                      ))}
                      <span className="muted" style={{ fontSize: 13 }}>
                        {d.companyName}
                        {d.agentName ? ` · ${d.agentName}` : ""}
                        {d.tier === "ceo" ? ` · for ${d.forAgentName ?? "the CEO"}` : ""}
                        {" · "}
                        <time dateTime={d.createdAt} title={when(d.createdAt)}>{raisedAgo(d.createdAt)}</time>
                      </span>
                      {/* (BOS-1236) What the old score column said, in words: the pills replace the number, its bars and its fold. */}
                      <span className="pills">
                        {d.parts.liveRun > 0 && <span className="tag amber pill">{d.agentName ?? "An agent"} is waiting on you</span>}
                        {d.blocks.length > 0 && <span className="tag blue pill">Holds up {d.blocks[0]!.ref ?? d.blocks[0]!.title}{d.blocks.length > 1 ? ` +${d.blocks.length - 1} more` : ""}</span>}
                        {d.dueDate && <span className="tag pill">Due {new Date(d.dueDate).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>}
                      </span>
                    </div>
                    {d.doAfter?.length ? (
                      <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>
                        Do after: {d.doAfter.join("; ")}
                      </p>
                    ) : null}
                    {d.doBefore?.length ? (
                      <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>
                        Do before: {d.doBefore.join("; ")}
                      </p>
                    ) : null}
                    {/* A Boss Man update carrying the fix for a live problem (BOS-639) leads with it, above everything else on the card. */}
                    {d.context?.type === "self_deploy" && d.context.urgent && (
                      <p className="urgent-deploy" style={{ margin: "8px 0", padding: "8px 12px", borderRadius: 8, background: "var(--red-soft)", color: "var(--red-ink)", fontWeight: 700, fontSize: 16, overflowWrap: "anywhere" }}>
                        {d.context.urgent.heading}
                      </p>
                    )}
                    {d.context?.update && <DeployUpdateView u={d.context.update} />}
                    {/* BOS-1660: a card with steps opens with why, where and how long. Where is written by Boss Man from the steps. */}
                    {d.context?.opening && !done && (
                      <dl data-opening className="card-opening" style={{ margin: "0 0 8px", padding: "8px 12px", borderRadius: 8, background: "var(--surface-2, rgba(127,127,127,0.1))", fontSize: 14 }}>
                        <div><dt style={{ display: "inline", fontWeight: 600 }}>Why: </dt><dd style={{ display: "inline", margin: 0 }}>{d.context.opening.why}</dd></div>
                        <div><dt style={{ display: "inline", fontWeight: 600 }}>Where: </dt><dd style={{ display: "inline", margin: 0 }}>{d.context.opening.where.join(" · ")}</dd></div>
                        <div><dt style={{ display: "inline", fontWeight: 600 }}>How long: </dt><dd style={{ display: "inline", margin: 0 }}>About {d.context.opening.minutes} minute{d.context.opening.minutes === 1 ? "" : "s"}</dd></div>
                      </dl>
                    )}
                    {d.context?.type === "self_deploy" && d.context.urgent ? (
                      // The question's first paragraph is the heading shown just above; the rest is the usual deploy question.
                      <h2 style={{ whiteSpace: "pre-wrap" }}><Linked text={d.question.split("\n\n").slice(1).join("\n\n") || d.question} refs={d.refs} /></h2>
                    ) : d.context?.type === "instructions" && d.context.instructions ? (
                      <>
                        {/* The question holds only the start of the new text; the decision keeps all of it, and that is what's applied. */}
                        <h2 style={{ whiteSpace: "pre-wrap" }}><Linked text={d.question.split("\n\nNew instructions:")[0]!} refs={d.refs} /></h2>
                        <MoreText label="New instructions" text={d.context.instructions} />
                      </>
                    ) : d.context?.type === "standing_rules" ? (
                      <>
                        {/* The decision holds the exact text that will be saved, already stripped and capped; show all of it. */}
                        <h2 style={{ whiteSpace: "pre-wrap" }}><Linked text={d.question} refs={d.refs} /></h2>
                        {d.context.text ? <MoreText label="New rules" text={d.context.text} /> : <p>This clears the standing rules.</p>}
                      </>
                    ) : d.context?.type === "owner_setup" ? (
                      // The server's question repeats the steps as plain numbered text (raiseOwnerSetup), so any
                      // command block in them showed as raw ``` lines (BOS-550). The steps show once, as blocks, under
                      // "What to do"; the heading is only the first line.
                      <h2 style={{ whiteSpace: "pre-wrap" }}><Linked text={d.question.split("\n\n")[0]!} refs={d.refs} /></h2>
                    ) : !x && !rule && d.question.split("\n").length > PREVIEW_LINES + 2 ? (
                      <>
                        <h2 style={{ whiteSpace: "pre-wrap" }}><Linked text={d.question.split("\n\n")[0]!} refs={d.refs} /></h2>
                        <MoreText text={d.question.split("\n\n").slice(1).join("\n\n")} refs={d.refs} />
                      </>
                    ) : x ? (
                      <h2 style={{ whiteSpace: "pre-wrap" }}>{d.agentName && !x.push ? `Let ${d.agentName} run a command that ${EFFECT_WORDS[x.effect]}?` : x.title}</h2>
                    ) : rule ? (
                      <h2 style={{ whiteSpace: "pre-wrap" }}><Linked text={d.question.split("\n\n")[0]!} refs={d.refs} /></h2>
                    ) : (
                      // (BOS-1236) The first sentence is the heading; whatever follows reads as a normal paragraph.
                      (() => {
                        const [head, rest] = firstSentence(d.question);
                        return (
                          <>
                            <h2 style={{ whiteSpace: "pre-wrap" }}><Linked text={head} refs={d.refs} /></h2>
                            {rest && <p style={{ whiteSpace: "pre-wrap", margin: 0 }}><Linked text={rest} refs={d.refs} /></p>}
                          </>
                        );
                      })()
                    )}
                    {/* BOS-1193: a card the owner sees is valid or already closed. One kept in the list while it is re-checked
                        (urgent, holding a live run, or a merge card) says who is checking it; one nobody re-checked in time says who failed to. */}
                    {d.rechecking && !done && (
                      <p role="status" className="strip amber" data-testid="rechecking-note">
                        <strong>Being re-checked.</strong> {d.rechecking.by} is confirming this is still needed{d.staleReason ? `, because ${fromYou(d.staleReason)}` : ""}. If it isn't, the card closes by itself. You can still answer now.
                      </p>
                    )}
                    {d.notRechecked && !done && (
                      <p role="status" className="strip red" data-testid="not-rechecked-note">
                        <strong>Not re-checked.</strong> {d.notRechecked}
                      </p>
                    )}
                    {rule && (
                      <>
                        <p style={{ whiteSpace: "pre-wrap" }}><Linked text={d.question.split("\n\n").slice(1).join("\n\n")} refs={d.refs} /></p>
                        <details>
                          <summary>The exact rule</summary>
                          <ul style={{ paddingLeft: 18 }}>
                            <li>Name: {rule.name}</li>
                            {rule.match.kinds?.length ? <li>Tool kinds: {rule.match.kinds.join(", ")}</li> : null}
                            {rule.match.commandPattern && <li>Command pattern: <code className="mono">{rule.match.commandPattern}</code></li>}
                            {rule.match.titlePattern && <li>Title pattern: <code className="mono">{rule.match.titlePattern}</code></li>}
                            <li>Then: {OUTCOMES.find((o) => o.value === rule.outcome)?.label ?? rule.outcome}</li>
                          </ul>
                        </details>
                      </>
                    )}
                    {d.context?.type === "skill" && d.context.proposalId ? <SkillProposal companyId={d.companyId} proposalId={d.context.proposalId} /> : null}
                    {x && (
                      <>
                        {x.scratch && (
                          <p>
                            <span className="tag green">Temporary folder only</span> {x.scratch.note}
                          </p>
                        )}
                        {x.push?.warnings.map((w) => (
                          <p key={w} role="alert" style={{ margin: "4px 0" }}>
                            <span className="tag red">Warning</span> {w}
                          </p>
                        ))}
                        {/* (BOS-1236) Three rows: what it does, what it is for, and the command itself. */}
                        <dl className="facts" aria-label="What this request does">
                          <dt>Does</dt>
                          <dd>
                            <span className={`tag ${EFFECT[x.effect].tone}`}>{EFFECT[x.effect].label}</span> {x.push ? x.push.headline : x.summary}
                            {x.push?.kind === "ticket" && x.push.ticketId && (
                              <>
                                {" "}
                                (<a href={`#/tickets/${x.push.ticketId}`}>{x.push.ref ?? "its ticket"}</a>)
                              </>
                            )}
                            {!x.push && x.effect === "unknown" && " Read the exact command before you allow it."}
                          </dd>
                          {(x.reason || d.about?.length) && (
                            <>
                              <dt>For</dt>
                              <dd>
                                {x.reason}
                                {x.reason && d.about?.length ? " " : ""}
                                {d.about?.length ? <span className="muted">({d.about.map((t) => t.ref ?? t.title).join(", ")})</span> : null}
                              </dd>
                            </>
                          )}
                          {x.command && (
                            <>
                              <dt>Command</dt>
                              <dd>
                                {x.command.split("\n").length <= 3 ? (
                                  <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", margin: 0 }}>{x.command}</pre>
                                ) : (
                                  <details>
                                    <summary>Show the exact command</summary>
                                    <pre className="mono" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{x.command}</pre>
                                  </details>
                                )}
                              </dd>
                            </>
                          )}
                        </dl>
                      </>
                    )}
                    {asking && (
                      <p role="status" style={{ fontWeight: 600 }}>
                        CEO is looking at this{advice.note ? <span className="muted" style={{ fontWeight: 400 }}> · you asked: {advice.note}</span> : null}. You can still answer it yourself.
                      </p>
                    )}
                    {advice?.state === "clarified" && (
                      <>
                        <p className="muted">Rewritten by the CEO with more detail, after you asked for advice.</p>
                        {advice.originalQuestion && (
                          <details>
                            <summary>Original question (before the CEO rewrote it)</summary>
                            <p style={{ fontSize: 14 }}>{advice.originalQuestion}</p>
                          </details>
                        )}
                      </>
                    )}
                    {advice?.state === "timed_out" && <p className="muted">You asked the CEO for advice, but the CEO didn't respond. It's back with you.</p>}
                    {ranOut && advice?.state !== "advised" && <p className="muted">The CEO didn't get to this in time, so it reached you without their advice. They've been asked to add it.</p>}
                    {advice?.state === "advised" && (
                      <div className="ceo-advice">
                        <p style={{ fontWeight: 600 }}>The CEO's advice</p>
                        {advice.what && <p>What it's for: {advice.what}</p>}
                        {advice.denyStops && <p>If you deny it, this won't get done: {advice.denyStops}</p>}
                        {advice.needed && !advice.denyStops && <p>Does this ticket need it? {advice.needed}</p>}
                        {advice.recommendation && (
                          <p>
                            <span className={`tag ${advice.recommendation === "allow" ? "green" : "red"}`}>{advice.recommendation === "allow" ? "Recommend Allow" : "Recommend Deny"}</span>{" "}
                            {advice.why}
                          </p>
                        )}
                        <p className="muted" style={{ fontSize: 13 }}>The card is still yours to answer.</p>
                      </div>
                    )}
                    {advice?.state === "replacement" && advice.replaces && <p className="muted">Written by the CEO to replace an earlier, unclear decision. <a href="#/decisions">The original is closed</a>; it is listed under "Settled or withdrawn by the team" with what it asked.</p>}
                    {d.context?.type === "risk_review" && (
                      <dl className="facts" aria-label="What was checked">
                        <dt>Reviews</dt>
                        <dd>
                          {d.context.reviews?.length ? (
                            <ul className="plain-list">
                              {d.context.reviews.map((r, i) => (
                                <li key={i}>
                                  {r.name}: {r.verdict === "passed" ? "✓ Passed" : r.verdict === "changes" ? "✗ Changes asked" : r.verdict === "overruled" ? "✓ Passed (overruled)" : "Still open"}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            "No reviews were asked for."
                          )}
                        </dd>
                        <dt>Quick check</dt>
                        <dd>{d.context.quickCheck ? `${d.context.quickCheck.result === "passed" ? "✓ Passed" : "✗ Failed"} on ${shortSha(d.context.quickCheck.sha)}, ${when(d.context.quickCheck.at)}` : "None recorded."}</dd>
                        {(d.context.risk || typeof d.context.files === "number") && (
                          <>
                            <dt>Change</dt>
                            <dd>{[typeof d.context.files === "number" ? `${d.context.files} file${d.context.files === 1 ? "" : "s"}` : null, d.context.risk ? `${d.context.risk} risk` : null].filter(Boolean).join(", ")}</dd>
                          </>
                        )}
                        {d.about?.[0] && (
                          <>
                            <dt>Built by</dt>
                            <dd>
                              {d.context.builder ? `${d.context.builder}. ` : ""}
                              <a href={`#/tickets/${d.about[0].ticketId}`}>Open {d.about[0].ref ?? "the ticket"}</a>
                            </dd>
                          </>
                        )}
                      </dl>
                    )}
                    {d.evidence && !done && <StallEvidenceView e={d.evidence} />}
                    {d.context?.type === "self_deploy" && d.context.handSteps && d.context.handSteps.length > 0 && (
                      <details className="plan">
                        <summary>What you'll need to do</summary>
                        <ol data-steps style={{ paddingLeft: 20, fontSize: 14 }}>
                          {d.context.handSteps.map((s, i) => (
                            <li key={i}><StepText text={s} refs={d.refs} /></li>
                          ))}
                        </ol>
                      </details>
                    )}
                    {d.context?.steps && d.context.steps.length > 0 && (
                      <div>
                        {/* How the host commands were proven (R11, DR-024 C): one line above the steps. */}
                        {d.context.lint?.proof && (
                          <p className="banner" data-proof={d.context.lint.proof.rehearsed ? "rehearsed" : "not-rehearsed"} style={d.context.lint.proof.rehearsed ? { background: "var(--green-soft)", color: "var(--green-ink)" } : undefined}>
                            {d.context.lint.proof.rehearsed ? `Tried on a test machine at ${d.context.lint.proof.commit.slice(0, 7)} (${d.context.lint.proof.script}).` : `First time on a real machine: ${d.context.lint.proof.part}`}
                          </p>
                        )}
                        <p style={{ fontWeight: 600, marginBottom: 4 }}>What to do</p>
                        <ol data-steps style={{ paddingLeft: 20, fontSize: 14 }}>
                          {d.context.steps.map((s, i) => (
                            <li key={i}><StepText text={s} refs={d.refs} stored={d.context?.stepSources?.[i]} /></li>
                          ))}
                        </ol>
                        {/* The lint's findings (BOS-417): small, under the steps, never the headline. */}
                        {d.context.lint?.override && (
                          <div className="muted" data-lint-override style={{ fontSize: 12 }}>
                            {(d.context.lint.override.entries ?? [{ reason: d.context.lint.override.reason, findings: d.context.lint.override.findings }]).map((e, i) => (
                              <p key={i} style={{ margin: 0 }}>
                                Boss Man flagged {e.findings.map((f) => `step ${f.step}${f.rule ? ` (${f.rule})` : ""}: ${f.problem}`).join("; ")}. The CEO says: {e.reason}
                              </p>
                            ))}
                          </div>
                        )}
                        {!!d.context.lint?.warn.length && (
                          <p className="muted" data-lint-warn style={{ fontSize: 12 }}>
                            Boss Man flagged {d.context.lint.warn.map((f) => `step ${f.step}: ${f.problem}`).join("; ")}.
                          </p>
                        )}
                      </div>
                    )}
                    {d.context?.check && (
                      <div>
                        <p style={{ fontWeight: 600, marginBottom: 4 }}>How to check it worked</p>
                        <div style={{ fontSize: 14 }}><StepText text={d.context.check} refs={d.refs} /></div>
                      </div>
                    )}
                    {d.context?.rollback && (
                      <div>
                        <p style={{ fontWeight: 600, marginBottom: 4 }}>How to roll back</p>
                        <div style={{ fontSize: 14 }}><StepText text={d.context.rollback} refs={d.refs} /></div>
                      </div>
                    )}
                    {d.context?.quiet && (
                      <div>
                        <p style={{ fontWeight: 600, marginBottom: 4 }}>{d.context.quiet.ready ? "Ready: the machine is quiet" : "Making room on the machine"}</p>
                        <p style={{ fontSize: 14 }}>
                          {d.context.quiet.ready ? "You can apply the update now." : `Not yet: ${d.context.quiet.why.join("; ")}.`} {d.context.quiet.runs} runs going, {d.context.quiet.checks} merge checks running
                          {d.context.quiet.freeMb != null && d.context.quiet.needMb != null ? `, ${(d.context.quiet.freeMb / 1024).toFixed(1)} GB of memory free (the update needs ${(d.context.quiet.needMb / 1024).toFixed(1)} GB)` : ""}.
                        </p>
                        <p className="muted" style={{ fontSize: 12 }}>Checked {when(d.context.quiet.at)}</p>
                      </div>
                    )}
                    {d.context?.lastFailure && (
                      <div>
                        <p style={{ fontWeight: 600, marginBottom: 4 }}>Last step failed</p>
                        <p style={{ fontSize: 14 }}>{d.context.lastFailure.note}</p>
                        <p className="muted" style={{ fontSize: 12 }}>Reported {when(d.context.lastFailure.at)}</p>
                      </div>
                    )}
                    {d.context?.keptOpen && <p className="muted" style={{ fontSize: 13 }}>{d.context.keptOpen.note}</p>}
                    {d.context?.triedFirst && (
                      <details className="plan">
                        <summary>What {d.agentName ?? "the agent"} tried first</summary>
                        <p style={{ fontSize: 14 }}><Linked text={d.context.triedFirst} refs={d.refs} /></p>
                      </details>
                    )}
                    {d.context?.planText && (
                      // (BOS-1236) About four lines to start; "Show the whole plan" opens it in place.
                      <div className="plan-preview">
                        <MoreText text={d.context.planText} chars={240} lines={4} noun="plan" refs={d.refs} />
                      </div>
                    )}
                    {d.context?.output && (
                      <details className="plan">
                        <summary>Last output of the check</summary>
                        <pre>{d.context.output}</pre>
                      </details>
                    )}
                    {d.context?.type === "model_change" && (
                      <ModelChange
                        d={d}
                        editing={!!modelEdits[d.id]}
                        onEdit={() => setModelEdits((m) => ({ ...m, [d.id]: true }))}
                        onCancel={() => setModelEdits(({ [d.id]: _, ...rest }) => rest)}
                        onSubmit={(config) => void answer(d, "Edit", { modelConfig: config })}
                        busy={busy === d.id}
                      />
                    )}
                    {checking && land?.state === "running" && (
                      <p role="status" style={{ fontWeight: 600 }}>
                        {land.phase ? PHASE_WORDS[land.phase] : "Checking and merging"} since {atTime(land.startedAt)}, started by {startedByLabel(land.startedBy)}. This can take several minutes; nothing more to do here.
                      </p>
                    )}
                    {staleCheck && land?.state === "running" && (
                      <p role="status" style={{ fontWeight: 600 }}>
                        The merge check started by {startedByLabel(land.startedBy)} at {atTime(land.startedAt)} looks stuck, so it may have stopped. Nothing is running now: you can answer again below.
                      </p>
                    )}
                    {notices[d.id] && (
                      <p role="status" className="muted">
                        {notices[d.id]}
                      </p>
                    )}
                    {done ? (
                      <p style={{ color: "var(--green-ink)", fontWeight: 500, fontSize: 14 }}>Answered: {done}.{done === "Let the CEO decide" ? " The CEO has it now and was woken; it comes back to you if they do not settle it in time." : ""}{d.context?.always?.some((a) => a.label === done) ? ` Saved as a rule for ${d.context?.alwaysAgent && alwaysScopes[d.id] !== "company" ? d.context.alwaysAgent.name : "every agent"}. To undo it, remove it under Settings → Permissions.` : ""}{endedHere[d.id] ? " The runner is offline, so Boss Man marked the run as stopped." : ""}</p>
                    ) : checking ? null : (
                      <>
                        {d.context?.hires && (
                          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                            <legend style={{ fontWeight: 600, marginBottom: 4 }}>Who to hire</legend>
                            {d.context.hires.map((h, i) => {
                              const chosen = picks[d.id] ?? d.context!.hires!.map((_, j) => j);
                              return (
                                <label key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14 }}>
                                  <input type="checkbox" checked={chosen.includes(i)} onChange={(e) => setPicks((p) => ({ ...p, [d.id]: e.target.checked ? [...chosen, i].sort((a, b) => a - b) : chosen.filter((x) => x !== i) }))} />
                                  <span>
                                    <strong>{h.name}</strong>
                                    {h.title ? `, ${h.title}` : ""}
                                    {h.template ? <span className="muted"> ({h.template})</span> : null}: {h.reason}
                                    {h.skills?.length ? <span className="muted"> Skills: {h.skills.join(", ")}.</span> : null}
                                  </span>
                                </label>
                              );
                            })}
                            <small className="muted">A reviewer you hire does code, security, infra or adversarial reviews once you name them in Settings › Reviews.</small>
                          </fieldset>
                        )}
                        {d.context?.type === "hire" && !!d.context.proposal?.skills?.length && (
                          <p style={{ fontSize: 14 }}>
                            <strong>Skills:</strong> {d.context.proposal.skills.join(", ")}. They have them from their first run.
                          </p>
                        )}
                        {/* (BOS-1236) The separate RECOMMENDED box is gone: the recommended answer is the filled button, tagged on its own line. Boss Man's reasons stay as a note. */}
                        {eff.option && d.context?.judge?.mode === "advise" && (
                          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                            {d.context.judge.second?.state === "pending" ? "Waiting a few seconds for the second opinion" : d.context.judge.reason}.
                            {d.context.judge.second?.state === "deny" && (
                              <span style={{ display: "block" }}>Second opinion: {d.context.judge.second.reason}</span>
                            )}
                          </p>
                        )}
                        {eff.rule && (
                          <p className="muted" style={{ fontSize: 13 }}>
                            Boss Man's automatic check suggested {eff.rule}, but the CEO looked at this request and advises {eff.option}. Their reasons are above.
                          </p>
                        )}
                        {d.context?.type === "workflow_change" && (
                          <>
                            <div className="field">
                              <label htmlFor={`reason-${d.id}`}>Why (shown on the Changes table, required)</label>
                              <DraftTextarea draftKey={draftNote(d.id)} ref={(el) => {
                                reasonBoxes.current.set(d.id, el);
                              }} id={`reason-${d.id}`} rows={2} maxLength={500} required value={notes[d.id] ?? ""} onChange={(text) => editNote(d.id, text)} placeholder="e.g. adds a skill; waits for BOS-172" />
                            </div>
                            <div className="field">
                              <label htmlFor={`reason-link-${d.id}`}>Wiki page that explains it (optional)</label>
                              <input id={`reason-link-${d.id}`} maxLength={400} value={reasonLinks[d.id] ?? ""} onChange={(e) => setReasonLinks((l) => ({ ...l, [d.id]: e.target.value }))} placeholder="slug or slug#Heading" />
                            </div>
                          </>
                        )}
                        {reassign[d.id] ? (
                          <form
                            style={{ display: "flex", flexDirection: "column", gap: 8 }}
                            onSubmit={(e) => {
                              e.preventDefault();
                              if (reassign[d.id]!.pick) void answer(d, "Reassign", { assigneeAgentId: reassign[d.id]!.pick });
                              else setErrors((x) => ({ ...x, [d.id]: "Pick who should take this ticket." }));
                            }}
                          >
                            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                              <legend style={{ fontWeight: 600, marginBottom: 4 }}>Who should take this ticket?</legend>
                              {(companies.find((c) => c.id === d.companyId)?.agents ?? []).map((a) => (
                                <label key={a.id} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 14 }}>
                                  <input type="radio" name={`assignee-${d.id}`} checked={reassign[d.id]!.pick === a.id} onChange={() => setReassign((r) => ({ ...r, [d.id]: { ...r[d.id]!, pick: a.id } }))} />
                                  <span>
                                    <strong>{a.name}</strong>
                                    {a.title ? `, ${a.title}` : ""}
                                    {a.id === reassign[d.id]!.current ? <span className="muted"> (has it now)</span> : null}
                                  </span>
                                </label>
                              ))}
                            </fieldset>
                            <div className="actions">
                              <button type="submit" className="btn primary" disabled={busy === d.id}>
                                Reassign to the one I picked
                              </button>
                              <button type="button" className="btn" disabled={busy === d.id} onClick={() => void answer(d, "Let the CEO decide")}>
                                Let the CEO decide
                              </button>
                              <button type="button" className="btn" onClick={() => setReassign(({ [d.id]: _, ...rest }) => rest)}>
                                Back to the options
                              </button>
                            </div>
                          </form>
                        ) : ownWords[d.id] === undefined || modelEdits[d.id] ? (
                          <>
                          {d.context?.always?.length ? (
                            <div className="always-preview">
                              {d.context.alwaysAgent && (
                                <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
                                  <legend style={{ fontWeight: 600, marginBottom: 4 }}>If you press an Always button, it covers</legend>
                                  <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
                                    <input type="radio" name={`always-scope-${d.id}`} checked={(alwaysScopes[d.id] ?? "agent") === "agent"} onChange={() => setAlwaysScopes((s) => ({ ...s, [d.id]: "agent" }))} /> {d.context.alwaysAgent.name} only
                                  </label>
                                  <label style={{ display: "flex", flexDirection: "row", alignItems: "center", gap: 8 }}>
                                    <input type="radio" name={`always-scope-${d.id}`} checked={alwaysScopes[d.id] === "company"} onChange={() => setAlwaysScopes((s) => ({ ...s, [d.id]: "company" }))} /> Every agent in this company
                                  </label>
                                </fieldset>
                              )}
                              <p className="muted" style={{ fontSize: 13 }}>It never covers pushes or destructive commands. You can remove the rule later in Settings → Permissions.</p>
                            </div>
                          ) : null}
                          {(() => {
                            // (BOS-1236) "Your answer": each button with one line saying what it sets off, tied to the button for a screen reader.
                            const who = d.context?.alwaysAgent && alwaysScopes[d.id] !== "company" ? d.context.alwaysAgent.name : "any agent";
                            const effects = new Map(d.options.map((o) => [o, modelEdits[d.id] ? null : effectOf(d, o, who)] as const));
                            const stacked = d.options.some((o) => effects.get(o));
                            const recTag = <span className="tag blue rec-tag">Recommended</span>;
                            return (
                              <>
                                {!modelEdits[d.id] && <p className="answer-label" id={`answer-label-${d.id}`}>Your answer</p>}
                                <div className={`actions${stacked ? " stacked" : d.kind === "question" ? " wide" : ""}`} role="group" aria-labelledby={modelEdits[d.id] ? undefined : `answer-label-${d.id}`} onClickCapture={(e) => {
                                  const target = e.target as HTMLElement | null;
                                  if (target && target.tagName === "BUTTON" && (target as HTMLButtonElement).disabled && d.context?.type === "workflow_change" && !notes[d.id]?.trim()) {
                                    reasonBoxes.current.get(d.id)?.focus();
                                  }
                                }}>
                                  {!modelEdits[d.id] && d.options.map((o, i) => {
                                    const rec = o === eff.option;
                                    const effect = effects.get(o);
                                    const effectId = `effect-${d.id}-${i}`;
                                    const button = (
                                      <button type="button" key={o} className={`btn${rec ? " primary" : ""}`} aria-label={rec ? `${o}, recommended` : undefined} aria-describedby={effect ? effectId : undefined} disabled={busy === d.id || (d.context?.type === "workflow_change" && !notes[d.id]?.trim())} title={d.context?.type === "workflow_change" && !notes[d.id]?.trim() ? "Type a reason above to Apply or Skip" : undefined} onClick={() => (d.context?.type === "model_change" && o === "Edit" ? setModelEdits((m) => ({ ...m, [d.id]: true })) : o === "Reassign" && d.context?.type === "stale_blocker" && d.context.blockerTicketId ? void openReassign(d) : void answer(d, o))}>
                                        {o}
                                        {rec && !stacked && recTag}
                                      </button>
                                    );
                                    return stacked ? (
                                      <div className="answer" key={o}>
                                        {button}
                                        {(effect || rec) && <p className="effect" id={effectId}>{effect}{rec && <> {recTag}</>}</p>}
                                      </div>
                                    ) : button;
                                  })}
                                  {d.context?.type === "workflow_change" && !notes[d.id]?.trim() && (
                                    <p className="muted" style={{ fontSize: 13 }}>Type a reason above to Apply or Skip</p>
                                  )}
                                </div>
                                {/* The note keeps its place under the answers, and names the button that sends it (BOS-1236). */}
                                {d.options.some((o) => o === "Keep planning" || o === "Send it back" || o === "A step failed" || (o === "Edit" && d.options.includes("Add"))) && (
                                  <div className="field">
                                    <label htmlFor={`note-${d.id}`}>{d.options.includes("Edit") && d.options.includes("Add") ? "Your one-line reason, or the corrected lesson (needed for Edit)" : d.context?.type === "owner_todo" ? "What went wrong (if a step failed)" : `Note for ${d.context?.type === "risk_review" ? (d.context.builder ?? "the builder") : agentOf(d)}, sent with "${d.options.find((o) => o === "Keep planning" || o === "Send it back")}"`}</label>
                                    <DraftTextarea draftKey={draftNote(d.id)} id={`note-${d.id}`} rows={2} value={notes[d.id] ?? ""} onChange={(text) => editNote(d.id, text)} />
                                  </div>
                                )}
                                {!modelEdits[d.id] && d.kind === "question" && (
                                  <div className="card-foot">
                                    <button type="button" className="linkish" disabled={busy === d.id} onClick={() => editOwn(d.id, readDraft(draftOwn(d.id)))}>
                                      Write my own answer
                                    </button>
                                  </div>
                                )}
                              </>
                            );
                          })()}
                          </>
                        ) : (
                          <form
                            style={{ display: "flex", flexDirection: "column", gap: 8 }}
                            onSubmit={(e) => {
                              e.preventDefault();
                              sendOwn(d);
                            }}
                          >
                            <div className="field">
                              <label htmlFor={`own-${d.id}`}>Your answer, in your own words. It goes to {d.agentName ?? "the agent"} exactly as you write it.</label>
                              <OwnerMessageBox
                                id={`own-${d.id}`}
                                label="Your answer, in your own words"
                                className="own-answer"
                                rows={5}
                                autoFocus
                                placeholder={d.recommendedOption ?? undefined}
                                value={ownWords[d.id] ?? ""}
                                onChange={(text) => editOwn(d.id, text)}
                                onPaste={(e) => {
                                  // A pasted picture or file is attached, unless text was copied with it (BOS-759).
                                  answering.current = cardTicketId(d);
                                  img.onPaste(e);
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Tab" && !e.shiftKey && d.recommendedOption && !ownWords[d.id]) {
                                    e.preventDefault();
                                    editOwn(d.id, d.recommendedOption!);
                                  }
                                }}
                                textareaStyle={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit" }}
                                onSendAsFile={(long) => answerAsFile(d, long)}
                                attaching={attaching === d.id || img.busy}
                                error={img.error}
                              >
                                {img.attached.length > 0 && <ImagePreviews attached={img.attached} onRemove={img.remove} />}
                              </OwnerMessageBox>
                              {d.recommendedOption && !ownWords[d.id] && (
                                <button type="button" className="use-suggestion" onClick={() => editOwn(d.id, d.recommendedOption!)}>
                                  Use suggestion
                                </button>
                              )}
                            </div>
                            <div className="actions">
                              {img.button}
                              <button type="submit" className="btn primary" disabled={busy === d.id || img.busy || (!ownWords[d.id]?.trim() && !img.attached.length) || tooLongToSend(ownWords[d.id] ?? "", img.attached)}>
                                Send my answer
                              </button>
                              <button type="button" className="btn" onClick={() => { answering.current = undefined; img.clear(); forgetOwn(d.id); }}>
                                Back to the options
                              </button>
                            </div>
                          </form>
                        )}
                        {x?.ownerWhy && <p className="muted card-foot-note">{x.ownerWhy}</p>}
                        {!asking && ownWords[d.id] === undefined && advice?.state !== "advised" && (
                          <details className="advice">
                            <summary>Not enough detail?</summary>
                            <div className="advice-row">
                              <div className="field">
                                <label htmlFor={`advice-${d.id}`}>What's unclear (optional, one line)</label>
                                <input id={`advice-${d.id}`} type="text" maxLength={500} value={adviceNote[d.id] ?? ""} onChange={(e) => setAdviceNote((n) => ({ ...n, [d.id]: e.target.value }))} />
                              </div>
                              <div className="actions">
                                <button type="button" className="btn" disabled={busy === d.id} onClick={() => void askAdvice(d)}>
                                  Ask the CEO for advice
                                </button>
                              </div>
                            </div>
                          </details>
                        )}
                        {errors[d.id] && (
                          <p className="error" role="alert">
                            {errors[d.id]}
                          </p>
                        )}
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {/* (BOS-1497) With cards to answer, the setup checklist comes after them, folded to one line. */}
          {typeof banner === "function" ? banner(true) : null}
          </>
          )}
          {recheckCards.length > 0 && (
            // (BOS-1691) In place of each card being re-checked: who has it, after what, and when it is back at the latest.
            <ul data-testid="recheck-lines" style={{ listStyle: "none", padding: 0, margin: "12px 0" }}>
              {recheckCards.map((d) => (
                <li key={d.id} id={`decision-${d.id}`} role="status" className={`strip amber${d.id === linkedId ? " linked" : ""}`} aria-current={d.id === linkedId ? "true" : undefined} style={{ marginBottom: 6 }}>
                  <TicketRefs about={d.about} />
                  <strong>{d.question.split("\n")[0]}</strong>
                  <div style={{ fontSize: 13 }}>
                    Being re-checked by {d.rechecking!.by}
                    {d.staleReason ? (/^the owner\b/i.test(d.staleReason) ? ` after ${fromYou(d.staleReason)}` : ` because ${d.staleReason}`) : ""}.{" "}
                    {d.rechecking!.backBy ? `Back on your list by ${atTime(d.rechecking!.backBy)}` : "Back on your list within the hour"} unless it is confirmed or closed first; if it closes, this page says why.
                  </div>
                </li>
              ))}
            </ul>
          )}
          {waitingCards.length > 0 && (
            // (BOS-551) Cards whose ticket is back with an agent, or that the agent is re-checking: not the
            // owner's to do yet. Folded at the bottom so they never sit beside the cards that are ready.
            // A link to one of these (BOS-1159) opens the fold and marks the card, so it is never hidden behind a closed group.
            <details className="sub" open={waitingCards.some((d) => d.id === linkedId) || undefined}>
              <summary>{figureText("decisions.withTeam", waitingCards.length)}, nothing to do yet</summary>
              <ul>
                {waitingCards.map((d) => (
                  <li key={d.id} id={`decision-${d.id}`} className={d.id === linkedId ? "linked" : undefined} aria-current={d.id === linkedId ? "true" : undefined} style={{ marginBottom: 8 }}>
                    <ProjectLabel d={d} />
                    <TicketRefs about={d.about} />
                    <strong>{d.question.split("\n")[0]}</strong>
                    {d.waiting ? <div className="muted" style={{ fontSize: 13 }}>{d.waiting}</div> : null}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {/* (BOS-809) Outside the empty-queue ternary on purpose: a closed notice (kept steps, the link to
          the newer card) and the settled/withdrawn history must still show when nothing else is open. */}
      {recentNotices.length > 0 && (
        // (BOS-1691) Every card that left the owner's list in the last 2 hours, one line each with who and why, unfolded.
        <section data-testid="left-your-list" style={{ marginTop: 16 }}>
          <h3 style={{ fontSize: 15, margin: "0 0 6px" }}>Left your list recently</h3>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {recentNotices.map((n) => (
              <li key={n.id} className="strip" style={{ fontSize: 14 }}>
                <strong>{n.question.split("\n")[0]}</strong> <span className="muted">· {atTime(n.notice.at)}</span>
                <div>{n.notice.text}</div>
                {n.notice.newer && <a href={`#/decisions/${n.notice.newer.decisionId}`}>Open the newer card ›</a>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <ClosedGroup notices={shownNotices} advised={advised} />
    </>
  );
}

/** The one line a closed card shows while folded: what closed it, and where to follow it. */
function closedLineFor(n: ClosedNoticeCard): string {
  const head = n.question.split("\n")[0] ?? "";
  if (n.notice.why === "newer" && n.notice.newer) return n.notice.newer.label;
  if (n.notice.commit) return `Main has moved to ${shortSha(n.notice.commit)}`;
  return head;
}

/**
 * (BOS-809) Everything on the queue that is done with: cards Boss Man closed by itself (a newer update
 * covers them, BOS-739) and cards the team settled or withdrew in the last 30 days. One collapsed
 * "Closed (N)" fold at the bottom, one line each, so the open cards come first and the whole screen is
 * not taken by the steps of cards that need nothing. A line opens to show its kept steps (read-only).
 * These are not counted in "N decisions waiting".
 */
function ClosedGroup({ notices, advised }: { notices: ClosedNoticeCard[]; advised: AdvisedDecision[] }) {
  const count = notices.length + advised.length;
  if (!count) return null;
  return (
    <details className="sub closed-covers" style={{ marginTop: 16 }}>
      <summary>Closed in the last 30 days ({count})</summary>
      <ul style={{ listStyle: "none", padding: 0, margin: "8px 0 0", display: "flex", flexDirection: "column", gap: 6 }}>
        {advised.map((a) => {
          // (BOS-1236) Each line starts with what happened. A replaced plan names and links the newer card from the
          // structured fields BOS-1219 stores, never from the sentence; with no author it still links by id.
          const newer = a.withdrawn?.newer;
          const verb = newer || a.advice?.state === "reissued" ? "Replaced" : a.withdrawn ? "Withdrawn" : a.settled ? (/^allow/i.test(a.settled.answer) ? "Allowed" : /^deny/i.test(a.settled.answer) ? "Denied" : "Answered") : "Handled";
          const newerClosed = newer ? advised.some((o) => o.id === newer.id) : false;
          return (
          <li key={a.id} id={`closed-${a.id}`} data-closed-card>
            <details>
              <summary className={`covered-line${newer ? " wraps" : ""}`}>
                <span className="tag grey">{verb}</span> {a.question.split("\n")[0]}{" "}
                <span className="muted">
                  ·{" "}
                  {newer
                    ? newer.author ? `by a newer plan from ${newer.author} at ${atTime(newer.at)}` : `Replaced by a newer plan (${atTime(newer.at)})`
                    : a.withdrawn
                      ? `withdrawn by ${a.withdrawn.by}`
                      : a.settled
                        ? `${settledWord(a.settled.answer)} by ${a.settled.by}`
                        : a.advice?.state === "reissued"
                          ? "replaced by a clearer decision"
                          : "handled by the CEO"}
                </span>
                {newer && (
                  <>
                    {" "}
                    <a
                      href={newerClosed ? `#/decisions` : `#/decisions/${newer.id}`}
                      onClick={newerClosed ? (e) => {
                        // The newer card is closed too: open its line instead of a card that is gone.
                        e.preventDefault();
                        const li = document.getElementById(`closed-${newer.id}`);
                        li?.querySelector("details")?.setAttribute("open", "");
                        li?.scrollIntoView?.({ block: "center" });
                      } : undefined}
                    >
                      Open the newer card ›
                    </a>
                  </>
                )}
              </summary>
              <div className="closed-body" style={{ padding: "8px 0 0 12px", fontSize: 14 }}>
                <TicketRefs about={a.about} />
                {a.withdrawn ? (
                  <p style={{ margin: "4px 0 0" }}>{a.withdrawn.note}{a.withdrawn.notice ? ` (${a.withdrawn.notice})` : ""}</p>
                ) : a.settled ? (
                  <p style={{ margin: "4px 0 0" }}>{a.settled.note ?? "no reason given"}</p>
                ) : (
                  <p style={{ margin: "4px 0 0" }}>{a.advice?.summary ?? "done"}</p>
                )}
                {a.settled?.command && (
                  <pre className="muted">
                    <code>{a.settled.command}</code>
                  </pre>
                )}
                {a.advice?.replacedBy && (
                  <p style={{ margin: "4px 0 0" }}>
                    <a href="#/decisions">See the new one in the list</a>
                  </p>
                )}
              </div>
            </details>
          </li>
          );
        })}
        {notices.map((n) => {
          // A hand-apply card keeps its steps as `handSteps`; a hand-apply to-do as `steps` (BOS-739).
          const steps = n.context.handSteps?.length ? n.context.handSteps : n.context.steps;
          const label = closedLineFor(n);
          return (
            <li key={n.id} data-closed-card>
              <details>
                <summary className="covered-line">
                  <span className="tag grey">{n.notice.newer ? "Replaced" : "Closed"}</span> {label}
                  {n.notice.newer && <span className="muted"> · covered by a newer card ›</span>}
                </summary>
                <div className="closed-body" style={{ padding: "8px 0 0 12px", fontSize: 14 }}>
                  <p style={{ margin: "0 0 4px" }}>{n.notice.text}</p>
                  {n.notice.newer && (
                    <p style={{ margin: "0 0 4px" }}>
                      <a href={`#/decisions/${n.notice.newer.decisionId}`}>Follow the newer card: {n.notice.newer.label}</a>
                    </p>
                  )}
                  {steps?.length ? (
                    <details>
                      <summary className="muted">These steps are kept to read; there is nothing to press.</summary>
                      <ol data-steps style={{ paddingLeft: 20, fontSize: 14 }}>
                        {steps.map((s, i) => (
                          <li key={i}><StepText text={s} /></li>
                        ))}
                      </ol>
                      {n.context.check && (
                        <p className="muted" style={{ fontSize: 13 }}>
                          How to check it worked: <StepText text={n.context.check} />
                        </p>
                      )}
                    </details>
                  ) : null}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
