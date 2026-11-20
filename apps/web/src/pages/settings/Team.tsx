import { useEffect, useState } from "react";
import { api, type Company } from "../../api";
import { usePoll } from "../../hooks";
import { when } from "../Runs";
import { clearDraft, readDraft } from "../../drafts";
import { DraftTextarea } from "../../components/DraftTextarea";
import { ReadOnlyText } from "../../components/ReadOnlyText";
import { Section, useAction } from "./shared";
import { Loader } from "../../components/Loader";
import { SaveButton } from "../../components/SaveButton";

type Chapter = {
  id: string;
  number: number;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  contextUsed: number | null;
  contextSize: number | null;
  rollRequestedAt: string | null;
  closing: boolean;
  directive: string;
  handoffIn: string | null;
  handoff: string | null;
  handoffBy: string | null;
  runs: number;
};

const ENDED: Record<string, string> = { context: "when its context was 70% full", age: "after 7 days", owner: "when you asked", closed: "early" };

/** The prefix in ticket references (HOL-12). Changing it renames every reference; the numbers stay. */
export function TicketPrefix({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [prefix, setPrefix] = useState(company.ticketPrefix ?? "");
  const [saved, setSaved] = useState(false);
  const act = useAction();
  const value = prefix.trim().toUpperCase();
  const valid = /^[A-Z0-9]{1,10}$/.test(value);
  return (
    <Section id="ticket-prefix-h" title="Ticket references">
      <p className="muted" style={{ fontSize: 14 }}>
        Every ticket in {company.name} has a number, shown as {value || "PREFIX"}-{company.nextTicketNumber ?? 1} for the next one. Numbers carry on across all its projects. Changing the prefix changes how every ticket is shown; the numbers stay.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="ticket-prefix">Prefix</label>
        <input id="ticket-prefix" className="mono" maxLength={10} value={prefix} onChange={(e) => setPrefix(e.target.value)} style={{ width: 120, textTransform: "uppercase" }} />
        <SaveButton
          dirty={value !== (company.ticketPrefix ?? "")}
          saved={saved}
          busy={act.busy}
          disabled={!valid}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { ticketPrefix: value } });
              setSaved(true);
              onChanged();
              return "Saved.";
            })
          }
        />
      </div>
      {act.view}
    </Section>
  );
}

/** Pauses or resumes this one company (the server's POST /api/companies/:id/pause); other companies keep working. */
export async function setCompanyPause(companyId: string, paused: boolean): Promise<void> {
  await api(`/api/companies/${companyId}/pause`, { method: "POST", body: { paused } });
}

export function CompanyPause({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const act = useAction();
  return (
    <Section id="company-pause-h" title="Pause this company">
      <p className="muted" style={{ fontSize: 14 }}>
        {company.paused ? "This company is paused: nothing new starts until you resume it." : "Pausing stops this company from starting new runs. Runs already going finish by themselves, and other companies keep working."}
      </p>
      <button
        type="button"
        className="btn"
        disabled={act.busy}
        onClick={() =>
          void act.run(async () => {
            await setCompanyPause(company.id, !company.paused);
            onChanged();
            return company.paused ? "Resumed." : "Paused.";
          })
        }
      >
        {company.paused ? "Resume company" : "Pause company"}
      </button>
      {act.view}
    </Section>
  );
}

/** CEO continuity: the CEO's current chapter, and the handoffs between chapters. */
export function GoalCheck({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [days, setDays] = useState(String(company.goalCheckDays ?? 14));
  const [saved, setSaved] = useState(false);
  const act = useAction();
  const n = Number(days);
  const valid = Number.isInteger(n) && n >= 1 && n <= 365;
  return (
    <Section id="goal-check-h" title="Did it move the goal?">
      <p className="muted" style={{ fontSize: 14 }}>
        After a feature linked to a key result is released, Boss Man asks you once whether it moved that goal: keep it, change it or drop it.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="goal-days">Ask after (days)</label>
        <input id="goal-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 80 }} />
        <SaveButton
          dirty={days !== String(company.goalCheckDays ?? 14)}
          saved={saved}
          busy={act.busy}
          disabled={!valid}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { goalCheckDays: n } });
              setSaved(true);
              onChanged();
              return "Saved.";
            })
          }
        />
      </div>
      {act.view}
    </Section>
  );
}

type RetroStatus = { agentId: string | null; runner: { id: string; name: string; source: "chosen" | "default" | "ceo" } | null; last: { startedAt: string; doneCount: number; savedAt: string | null } | null; doneSince: number };

/** Workflow retros (docs/19): who runs the team's look-back, when it last ran, and a button to run one now. */
export function WorkflowRetros({ company }: { company: Company }) {
  const [status, setStatus] = useState<RetroStatus | null>(null);
  const act = useAction();
  const load = async () => setStatus(await api<RetroStatus>(`/api/companies/${company.id}/retro-settings`));
  useEffect(() => {
    void load().catch(() => setStatus(null));
  }, [company.id]);
  if (!status) return null;
  const hasPm = company.agents.some((a) => a.template === "product-manager" && !a.paused);
  return (
    <Section id="retro-h" title="Workflow retros">
      <p className="muted" style={{ fontSize: 14 }}>
        Every 20 finished tickets, or after 7 days if anything was finished, one agent looks back over how the team worked and suggests small changes. It never changes anything without approval: the CEO approves playbooks and brief lessons, and you approve the rest.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label htmlFor="retro-agent">Who runs it</label>
        <select
          id="retro-agent"
          value={status.agentId ?? ""}
          disabled={act.busy}
          onChange={(e) =>
            void act.run(async () => {
              setStatus(await api<RetroStatus>(`/api/companies/${company.id}/retro-settings`, { method: "PUT", body: { agentId: e.target.value || null } }));
              return "Saved.";
            })
          }
        >
          <option value="">{hasPm ? "Product Manager (default)" : "CEO (no Product Manager)"}</option>
          {company.agents
            .filter((a) => a.duty !== "assistant")
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
        </select>
      </div>
      <p style={{ fontSize: 14 }}>
        {status.last ? `Last ran ${when(status.last.startedAt)}, over ${status.last.doneCount} finished tickets.` : "It has not run yet. The first one waits for 5 finished tickets."} {status.doneSince} finished since.
      </p>
      <div>
        <button
          type="button"
          className="btn"
          disabled={act.busy || status.doneSince < 1}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}/retro`, { method: "POST" });
              await load();
              return `${status.runner?.name ?? "The agent"} has been asked to run a retro.`;
            })
          }
        >
          Run a retro now
        </button>
      </div>
      {act.view}
    </Section>
  );
}

/** How long the CEO has to act on a decision the owner asked for advice on. */
export function AdviceTimeout({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const [minutes, setMinutes] = useState(String(company.adviceTimeoutMinutes ?? 120));
  const [saved, setSaved] = useState(false);
  const act = useAction();
  const n = Number(minutes);
  const valid = Number.isInteger(n) && n >= 5 && n <= 1440;
  return (
    <Section id="advice-timeout-h" title="Asking the CEO for advice">
      <p className="muted" style={{ fontSize: 14 }}>
        When you press "Ask the CEO for advice" on a decision, the CEO has this long to rewrite or settle it. After that it goes back to you as it was.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="advice-timeout">Minutes the CEO has</label>
        <input id="advice-timeout" type="number" min={5} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} style={{ width: 80 }} />
        <SaveButton
          dirty={minutes !== String(company.adviceTimeoutMinutes ?? 120)}
          saved={saved}
          busy={act.busy}
          disabled={!valid}
          onClick={() =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { adviceTimeoutMinutes: n } });
              setSaved(true);
              onChanged();
              return "Saved.";
            })
          }
        />
      </div>
      {act.view}
    </Section>
  );
}

/** Standing rules (BOS-353): what every agent reads at the start of every run. The owner can edit, clear or undo them here; agents cannot. */
export function StandingRules({ company, onChanged }: { company: Company; onChanged: () => void }) {
  type Rules = { text: string; by: string | null; at: string | null; max: number };
  const [rules, setRules] = useState<Rules | null>(null);
  const [failed, setFailed] = useState(false);
  // What the editor box shows, kept in this browser as it is typed (DR-045). Opening the editor and
  // having a kept draft are separate: a kept draft is never sent by itself, only with the Save button.
  // Cancel keeps the draft (DR-045); the explicit "Discard draft" is the only thing that clears it.
  const draftKey = `standing-rules/${company.id}`;
  const [open, setOpen] = useState(false);
  const [shown, setShown] = useState(() => readDraft(draftKey));
  // Whether a draft is kept, re-read whenever the store changes so the notice and the Edit button agree.
  const [kept, setKept] = useState(() => readDraft(draftKey));
  const cancel = () => {
    setOpen(false);
    setKept(readDraft(draftKey));
    setShown(readDraft(draftKey));
  };
  const act = useAction();
  useEffect(() => {
    let live = true;
    void api<Rules>(`/api/companies/${company.id}/standing-rules`)
      .then((r) => live && setRules(r))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [company.id]);
  const url = `/api/companies/${company.id}/standing-rules`;
  return (
    <Section id="standing-rules-h" title="Standing rules">
      <p className="muted" style={{ fontSize: 14 }}>
        The rules every agent reads at the start of every run. Your CEO can set them, and so can you; no other agent can change them. They are capped at {rules?.max ?? 2000} characters.
      </p>
      {failed ? (
        <p className="muted">Couldn't load the standing rules.</p>
      ) : !rules ? (
        <Loader label="Loading the standing rules" />
      ) : open ? (
        <>
          <DraftTextarea draftKey={draftKey} aria-label="Standing rules" value={shown} onChange={(text) => { setShown(text); setKept(text); }} rows={8} style={{ width: "100%", boxSizing: "border-box", fontFamily: "inherit", fontSize: 14 }} />
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
            <SaveButton
              dirty={shown !== rules.text}
              saved={false}
              busy={act.busy}
              onClick={() =>
                void act.run(async () => {
                  const saved = await api<Rules>(url, { method: "PUT", body: { text: shown } });
                  setRules(saved);
                  setOpen(false);
                  clearDraft(draftKey);
                  setKept("");
                  setShown(saved.text);
                  onChanged();
                  return "Saved.";
                })
              }
            />
            <button type="button" className="btn" disabled={act.busy} onClick={cancel}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {rules.text ? (
            <ReadOnlyText text={rules.text} label="Standing rules" />
          ) : (
            <p className="muted">No standing rules are set yet.</p>
          )}
          <p className="muted" style={{ fontSize: 13, margin: 0 }}>
            {rules.text ? "Last changed by " : "Last cleared by "}
            {rules.by === "undo" ? "an undo" : (rules.by ?? "no one")}
            {rules.at ? ` on ${when(rules.at)}` : ""}.
          </p>
          <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}>
            {kept && (
              <p className="muted" role="status" style={{ fontSize: 13, margin: 0 }}>
                Draft restored: what you were writing is kept in this browser.{" "}
                <button type="button" className="link" style={{ padding: 0 }} onClick={() => { clearDraft(draftKey); setKept(""); setShown(rules.text); }}>
                  Discard draft
                </button>
              </p>
            )}
            <button type="button" className="btn" disabled={act.busy} onClick={() => { setShown(readDraft(draftKey) || rules.text); setOpen(true); }}>
              Edit
            </button>
            {rules.text ? (
              <button
                type="button"
                className="btn"
                disabled={act.busy}
                onClick={() => {
                  if (!confirm("Clear the standing rules? Agents will stop reading them from the next run.")) return;
                  void act.run(async () => {
                    const saved = await api<Rules>(url, { method: "PUT", body: { text: "" } });
                    setRules(saved);
                    clearDraft(draftKey);
                    setKept("");
                    setShown("");
                    onChanged();
                    return "Cleared.";
                  });
                }}
              >
                Clear
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              disabled={act.busy || !rules.at}
              title={!rules.at ? "Nothing to undo yet" : act.busy ? "Saving, one moment" : undefined}
              onClick={() =>
                void act.run(async () => {
                  const saved = await api<Rules>(`${url}/undo`, { method: "POST" });
                  setRules(saved);
                  clearDraft(draftKey);
                  setKept("");
                  setShown(saved.text);
                  onChanged();
                  return "Undone.";
                })
              }
            >
              Undo last change
            </button>
          </div>
        </>
      )}
      {act.view}
    </Section>
  );
}

/** How the rules judge advises on permission cards (BOS-337). It only picks the suggested button; it never answers a card. */
export function PermissionJudgeSetting({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const act = useAction();
  const mode = company.permissionJudge ?? "watch";
  return (
    <Section id="permission-judge-h" title="Advice on permission cards">
      <p className="muted" style={{ fontSize: 14 }}>
        Boss Man can look at where a command reaches (its own folder, secrets, other agents, the network) and suggest Allow or Deny with a one-line reason. It only suggests: you or the CEO still press the button, and pushes to main, publishing, deploys, secrets and other agents' work stay decided by fixed rules.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <label htmlFor="permission-judge">Advice</label>
        <select
          id="permission-judge"
          value={mode}
          disabled={act.busy}
          onChange={(e) =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { permissionJudge: e.target.value } });
              onChanged();
              return "Saved.";
            })
          }
        >
          <option value="advise">Advise: suggest a button and say why</option>
          <option value="watch">Watch: only record what it would suggest next to your answer</option>
          <option value="off">Off: use the older text rules</option>
        </select>
      </div>
      {act.view}
    </Section>
  );
}

/** Plain /tmp cleanups are allowed by the rules with no card (BOS-1453). On by default; each one is logged in the permission history. */
export function AutoTempCleanupSetting({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const act = useAction();
  const on = company.autoTempCleanup !== false;
  return (
    <Section id="auto-temp-cleanup-h" title="Cleaning up temp files">
      <p className="muted" style={{ fontSize: 14 }}>
        When an agent only deletes its own scratch entries directly in /tmp (for example rm -rf /tmp/work-1), Boss Man allows it at once, with no card for you or the CEO, and records the command and the agent in the permission history. Anything else, such as a path with .., a variable or a wildcard, a deeper path, or files in an agent's working copy, still goes to the CEO first. Turn this off to have every cleanup go to the CEO first.
      </p>
      <label>
        <input
          type="checkbox"
          checked={on}
          disabled={act.busy}
          onChange={(e) =>
            void act.run(async () => {
              await api(`/api/companies/${company.id}`, { method: "PATCH", body: { autoTempCleanup: e.target.checked } });
              onChanged();
              return "Saved.";
            })
          }
        />{" "}
        Allow plain /tmp cleanups without asking
      </label>
      {act.view}
    </Section>
  );
}

export function Chapters({ company }: { company: Company }) {
  const list = usePoll((signal) => api<Chapter[]>(`/api/companies/${company.id}/chapters`, { signal }), 30_000, `ch-${company.id}`);
  const act = useAction();
  const chapters = list.data ?? [];
  const current = chapters.find((c) => !c.endedAt);
  const past = chapters.filter((c) => c.endedAt);
  const pct = current?.contextUsed != null && current.contextSize ? current.contextUsed / current.contextSize : null;
  const days = current ? Math.floor((Date.now() - new Date(current.startedAt).getTime()) / 86_400_000) : 0;
  return (
    <Section id="chapters-h" title="CEO chapters">
      <p className="muted" style={{ fontSize: 14 }}>
        The CEO works in chapters: one continuing conversation that starts from the mission and objectives as they were then. A chapter closes when its context is 70% full, after 7 days, or when you ask, and the CEO writes a handoff for the next one. Start a new chapter after changing the mission or objectives so the CEO picks them up.
      </p>
      {current ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <p>
            <strong>Chapter {current.number}</strong>, started {when(current.startedAt)} ({days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"} ago`}), {current.runs} run{current.runs === 1 ? "" : "s"}.{" "}
            {current.closing ? <span className="tag amber">Writing its handoff</span> : current.rollRequestedAt ? <span className="tag amber">Closes at the next run</span> : null}
          </p>
          {pct !== null && (
            <div style={{ display: "flex", gap: 10, alignItems: "center", maxWidth: 420 }}>
              <span className={`bar ${pct >= 0.7 ? "warn" : ""}`} style={{ flex: 1 }} aria-label={`Context ${Math.round(pct * 100)}% full`}>
                <span style={{ width: `${Math.min(100, pct * 100)}%` }} />
              </span>
              <span className="mono muted" style={{ fontSize: 13 }}>
                {Math.round(pct * 100)}% context
              </span>
            </div>
          )}
          <details>
            <summary>Its directive</summary>
            <pre className="chapter-text">{current.directive}</pre>
          </details>
          {current.handoffIn && (
            <details>
              <summary>The handoff it started from</summary>
              <pre className="chapter-text">{current.handoffIn}</pre>
            </details>
          )}
          {!current.rollRequestedAt && !current.closing && (
            <button
              type="button"
              className="btn"
              style={{ alignSelf: "flex-start" }}
              disabled={act.busy}
              onClick={() =>
                window.confirm("Close this chapter? At its next run the CEO writes a handoff, and the run after that starts a new chapter with the current mission and objectives.") &&
                void act.run(async () => {
                  await api(`/api/companies/${company.id}/chapters/roll`, { method: "POST" });
                  list.reload();
                  return "The chapter closes at the CEO's next run.";
                })
              }
            >
              Start a new chapter
            </button>
          )}
        </div>
      ) : (
        list.data && <p>No chapter yet. The first starts the next time the CEO is woken.</p>
      )}
      {past.length > 0 && (
        <div>
          <p className="label">Earlier chapters</p>
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {past.map((c) => (
              <li key={c.id}>
                <details>
                  <summary>
                    Chapter {c.number}: {when(c.startedAt)} to {when(c.endedAt)}, {c.runs} run{c.runs === 1 ? "" : "s"}, ended {ENDED[c.endReason ?? "closed"] ?? c.endReason}
                    {c.handoffBy === "boss_man" ? " (handoff by Boss Man)" : ""}
                  </summary>
                  <pre className="chapter-text">{c.handoff ?? "No handoff."}</pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}
      {act.view}
    </Section>
  );
}
