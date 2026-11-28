// The setup wizard (R56): eight steps from a new install to agents at work, each skippable,
// with progress saved so it resumes. The steps reuse the Settings sections, so there's one way
// to do each thing. What's still undone shows on Decisions until it's done or dismissed.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Company, type FundingSource, type Project } from "../api";
import { SaveButton, useSaveState } from "../components/SaveButton";
import { usePoll } from "../hooks";
import { clearDraft } from "../drafts";
import { DraftTextarea } from "../components/DraftTextarea";
import { useAction } from "./settings/shared";
import { Funding } from "./settings/Funding";
import { ProjectRow } from "./settings/Projects";
import { ClaudeStep, RunnerStep } from "./SetupClaude";
import { useStartBlock } from "../components/StartBlock";
import { GuideLink, type GuideSlug } from "../guide-links";

type Progress = { dismissed: boolean; left?: boolean; step: number; companyId: string | null; firstMerge?: { ref: string; minutes: number } | null; work?: "docs" | "code" };
export type ChecklistItem = { id: string; label: string; done: boolean };

const STEPS = [
  { id: "company", title: "Your company", why: "Name it and say what it's for. Boss Man hires a CEO for you, and the CEO plans the work from this." },
  { id: "project", title: "What will your team work on?", why: "Pick the kind of work your team does and name its first project. You can change this later in Settings." },
  { id: "credential", title: "Claude account", why: "Agents need something to run on. Paste the sign-in code from your Claude Pro or Max subscription: it also pays for the CEO. Or use an API key instead." },
  { id: "runner", title: "Your agents' workspace", why: "This is the private space on your machine where your agents do their work. It usually takes under 2 minutes. When it is ready you will see a green Connected." },
  { id: "git", title: "A git token", why: "So agents can clone, push, and open pull requests on the project's repo." },
  { id: "checks", title: "Checks before merging", why: "Boss Man looks at the repo, through the runner, and proposes the check that runs before work merges. High-risk work can add a slower one." },
  { id: "funding", title: "What pays for the CEO", why: "Funding sources track cost and quota. Choose the one the CEO runs on; the Agents page sets the rest." },
  { id: "ticket", title: "First task", why: "Optional: something for the team to start on." },
  { id: "before", title: "Before you go", why: "What is ready, what still stops agents starting, and how Boss Man reaches you." },
] as const;

/** The explainer a step's subtitle links to (BOS-2832), right after the line it explains. */
const STEP_GUIDE: Partial<Record<(typeof STEPS)[number]["id"], { slug: GuideSlug; text: string }>> = {
  company: { slug: "the-ceo", text: "What does the CEO do?" },
  credential: { slug: "connect-a-claude-account", text: "Plan or API key: which is right for me?" },
  runner: { slug: "the-runner", text: "What's the runner?" },
  funding: { slug: "what-agents-cost", text: "What's a funding source?" },
};

/** The saved step number keeps its old meaning (2 = the workspace, 3 = Claude) so an owner mid-wizard when the Claude step moved ahead of the workspace resumes on the same step. The swap is its own inverse: use it on read and on write. */
const savedStep = (n: number) => (n === 2 ? 3 : n === 3 ? 2 : n);

/** The last step (BOS-2818): what is ready and what still stops agents, how permission cards work, and the optional phone push. */
export function BeforeStep({ items, onFix }: { items: ChecklistItem[]; onFix: (stepId: string) => void }) {
  const parts = items.filter((i) => i.id !== "ticket" && STEPS.some((s) => s.id === i.id));
  const ready = parts.filter((i) => i.done);
  const missing = parts.filter((i) => !i.done);
  return (
    <div className="setup-before">
      <h2 style={{ fontSize: 16, fontWeight: 600 }}>Ready</h2>
      {ready.length ? (
        <ul>
          {ready.map((i) => (
            <li key={i.id}>
              <span>✓ {i.label}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing yet.</p>
      )}
      <h2 style={{ fontSize: 16, fontWeight: 600 }}>Still stops agents starting</h2>
      {missing.length ? (
        <ul>
          {missing.map((i) => (
            <li key={i.id}>
              <span>○ {i.label}</span>
              <button type="button" className="btn" onClick={() => onFix(i.id)}>
                Fix this
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Nothing. Your agents can start.</p>
      )}
      <h2 style={{ fontSize: 16, fontWeight: 600 }}>When an agent needs your OK</h2>
      <p style={{ margin: 0 }}>When an agent needs your OK it asks in Decisions. If nobody answers in 10 minutes it is treated as No.</p>
      <p style={{ margin: 0 }}>
        Optional: <a href="#/settings/notifications">Get a push on your phone when agents need you</a>.
      </p>
    </div>
  );
}

function CompanyStep({ company, onCreated }: { company: Company | undefined; onCreated: (id: string) => void }) {
  const [name, setName] = useState(company?.name ?? "");
  const [mission, setMission] = useState(company?.mission ?? "");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  // The mission box is kept in this browser as it is typed (DR-045); it goes once the company is saved.
  const missionKey = `setup-mission/${company?.id ?? "new"}`;
  const [busy, setBusy] = useState(false);
  const sv = useSaveState({ name, mission });
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (company) {
        await api(`/api/companies/${company.id}`, { method: "PATCH", body: { name: name.trim(), mission: mission.trim() || null } });
        onCreated(company.id);
      } else {
        const { company: c } = await api<{ company: Company }>("/api/companies", { method: "POST", body: { name: name.trim(), ...(mission.trim() ? { mission: mission.trim() } : {}) } });
        onCreated(c.id);
      }
      clearDraft(missionKey);
      sv.markSaved();
      setNote({ ok: true, text: "Saved." });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
      <div className="field">
        <label htmlFor="setup-name">Company name</label>
        <input id="setup-name" required maxLength={80} placeholder="e.g. Fernleaf Studio" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="setup-mission">What it's for</label>
        <DraftTextarea draftKey={missionKey} id="setup-mission" rows={3} maxLength={2000} placeholder="e.g. Research and write a monthly report on garden-centre trends for our customers." value={mission} onChange={setMission} />
      </div>
      {company ? (
        <SaveButton {...sv} busy={busy} disabled={!name.trim()} style={{ alignSelf: "flex-start" }} />
      ) : (
        <button type="submit" className="btn primary" style={{ alignSelf: "flex-start" }} disabled={busy || !name.trim()}>
          Create the company
        </button>
      )}
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"}>
          {note.text}
        </p>
      )}
    </form>
  );
}

export type Work = "docs" | "code";

/** The two cards on step 2. Side by side when there is room, stacked on a phone. */
export function WorkChoice({ work, onWork }: { work: Work; onWork: (w: Work) => void }) {
  return (
    <fieldset className="work-choice" style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(240px, 100%), 1fr))" }}>
      <legend className="sr-only">What will your team work on?</legend>
      {(
        [
          { id: "docs", title: "Documents, research and writing", note: "Most teams" },
          { id: "code", title: "Code in a git repository", note: "Agents clone, push and open pull requests" },
        ] as const
      ).map((c) => (
        <label key={c.id} className="card" style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer", borderColor: work === c.id ? "var(--link)" : undefined }}>
          <input type="radio" name="setup-work" checked={work === c.id} onChange={() => onWork(c.id)} />
          <span>
            {c.title}
            <br />
            <small className="muted">{c.note}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function ProjectStep({ company, work, onWork, onChanged }: { company: Company; work: Work; onWork: (w: Work) => void; onChanged: () => void }) {
  const projects = usePoll((signal) => api<Project[]>(`/api/companies/${company.id}/projects`, { signal }), 30_000, `setup-projects-${company.id}`);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/api/companies/${company.id}/projects`, { method: "POST", body: { name: name.trim() } });
      setName("");
      projects.reload();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const list = projects.data ?? [];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <WorkChoice work={work} onWork={onWork} />
      <p style={{ margin: 0 }}>
        <GuideLink slug="work-that-isnt-code">Work that isn't code: what you can skip</GuideLink>
      </p>
      {list.length === 0 && (
        <form onSubmit={add} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
          <div className="field" style={{ flex: "1 1 240px" }}>
            <label htmlFor="setup-project">Project name</label>
            <input id="setup-project" required maxLength={80} placeholder={work === "code" ? "e.g. Boss Man" : "e.g. Market research"} value={name} onChange={(e) => setName(e.target.value)} />
            <small className="muted">A project is one body of work; its tasks sit together on one board.</small>
          </div>
          <button type="submit" className="btn primary" disabled={!name.trim()}>
            Add the project
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {list.map((p) =>
        work === "code" ? (
          <ProjectRow key={p.id} p={p} only="repo" onChanged={onChanged} />
        ) : (
          <p key={p.id} style={{ margin: 0, fontWeight: 600 }}>
            {p.name}
          </p>
        ),
      )}
      {work === "code" && (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          The checks that run before merging are chosen at the "Checks before merging" step, once the runner and git token are set up.
        </p>
      )}
      {work === "code" && (
        <p style={{ margin: 0 }}>
          <GuideLink slug="code-words">Merge or pull request? Code words in plain words</GuideLink>
        </p>
      )}
    </div>
  );
}

function ChecksStep({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const projects = usePoll((signal) => api<Project[]>(`/api/companies/${company.id}/projects`, { signal }), 60_000, `setup-checks-${company.id}`);
  const withRepo = (projects.data ?? []).filter((p) => p.repoUrl);
  if (!withRepo.length) return <p className="muted">No project has a repo yet. Add one in step 2, then come back for this.</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <p style={{ margin: 0 }}>A check is a command that runs on every change before it merges, such as your tests. Not sure? Choose Nothing; you can change it later.</p>
      {withRepo.map((p) => (
        <ProjectRow key={p.id} p={p} only="checks" onChanged={onChanged} />
      ))}
    </div>
  );
}

function TokenHelp({ projects }: { projects: Project[] }) {
  const hosts = new Set(projects.map((p) => p.gitHost ?? (p.repoUrl ? (/^https?:\/\/(www\.)?github\.com\//i.test(p.repoUrl) ? "github" : "gitea") : null)));
  hosts.delete(null);
  const repo = projects.find((p) => p.repoUrl)?.name ?? "the project";
  const both = hosts.size !== 1;
  return (
    <details className="token-help" style={{ fontSize: 14 }} open>
      <summary style={{ cursor: "pointer", color: "var(--link)" }}>How do I get a token?</summary>
      {(both || hosts.has("github")) && (
        <section aria-label="GitHub token steps">
          <h4 style={{ margin: "8px 0 4px" }}>GitHub (fine-grained personal access token)</h4>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            <li>GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.</li>
            <li>Name it (e.g. boss-man) and pick an expiry. 90 days is a sensible default.</li>
            <li>Repository access: Only select repositories, then pick {repo}'s repo.</li>
            <li>Repository permissions: Contents read and write; Pull requests read and write; Workflows read and write (so agents can change the repo's CI files); Actions read and write (so Boss Man can read CI runs, and run again a job that failed by chance); Metadata read-only (added automatically).</li>
            <li>Generate, copy it once, paste it here, then use "Check the token against {repo}".</li>
          </ol>
          <p style={{ margin: "4px 0" }}>
            <a href="https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens" target="_blank" rel="noreferrer">GitHub's own guide</a>
          </p>
        </section>
      )}
      {(both || hosts.has("gitea")) && (
        <section aria-label="Gitea token steps">
          <h4 style={{ margin: "8px 0 4px" }}>Gitea (self-hosted, e.g. http://192.0.2.10:3003)</h4>
          <ol style={{ margin: 0, paddingLeft: 20 }}>
            <li>Gitea → Settings → Applications → Generate New Token.</li>
            <li>Name it and set the repository scope to Read and Write (<span className="mono">write:repository</span>).</li>
            <li>Generate, copy it once, paste it here, then use "Check the token against {repo}".</li>
          </ol>
        </section>
      )}
    </details>
  );
}

function GitStep({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const projects = usePoll((signal) => api<Project[]>(`/api/companies/${company.id}/projects`, { signal }), 60_000, `setup-git-${company.id}`);
  const grants = usePoll((signal) => api<{ id: string; envName: string; secretName: string }[]>(`/api/companies/${company.id}/grants`, { signal }), 30_000, `setup-git-grants-${company.id}`);
  const [result, setResult] = useState<{ ok: boolean; canPush: boolean; message: string } | null>(null);
  const [value, setValue] = useState("");
  const act = useAction();
  // What a half-finished save already made, so a retry doesn't make a second secret.
  const made = useRef<{ secretId?: string }>({});
  const withRepo = (projects.data ?? []).filter((p) => p.repoUrl);
  const connected = grants.data?.find((g) => g.envName === "GIT_TOKEN");
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      if (!made.current.secretId) made.current.secretId = (await api<{ secret: { id: string } }>("/api/secrets", { method: "POST", body: { name: `${company.name} git token`, kind: "generic", value: value.trim() } })).secret.id;
      await api(`/api/secrets/${made.current.secretId}/grants`, { method: "POST", body: { companyId: company.id, envName: "GIT_TOKEN" } });
      made.current = {};
      setValue("");
      grants.reload();
      onChanged();
      return "Saved. The token is stored encrypted and is not shown again. Now use \"Check the token\".";
    });
  };
  const check = (p: Project) =>
    void act.run(async () => {
      const r = await api<{ ok: boolean; canPush: boolean; defaultBranch?: string; message: string }>(`/api/projects/${p.id}/check-git-token`, { method: "POST" });
      setResult(r);
      // Ask the repo once what its main branch is called, so the owner doesn't have to know.
      if (r.ok && r.defaultBranch && r.defaultBranch !== p.defaultBranch) {
        await api(`/api/projects/${p.id}`, { method: "PATCH", body: { defaultBranch: r.defaultBranch } });
        projects.reload();
      }
      onChanged();
    });
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
      <p style={{ margin: 0 }}>Lets your agents save their work to your GitHub repository.</p>
      {connected ? (
        <p role="status">
          <span className="tag green">Saved</span> The git token is saved as <strong>{connected.secretName}</strong>. To change it, use Settings → Secrets.
        </p>
      ) : (
        <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div className="field">
            <label htmlFor="setup-git-token">Git token</label>
            <input id="setup-git-token" type="password" autoComplete="off" spellCheck={false} required value={value} onChange={(e) => {
              made.current = {};
              setValue(e.target.value);
            }} />
          </div>
          <button type="submit" className="btn primary" style={{ alignSelf: "flex-start" }} disabled={act.busy || !value.trim()}>
            Save the token
          </button>
        </form>
      )}
      {projects.data && <TokenHelp projects={withRepo} />}
      {connected &&
        withRepo.map((p) => (
          <p key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: 0 }}>
            <button type="button" className="btn" disabled={act.busy} onClick={() => check(p)}>
              Check the token against {p.name}
            </button>
            {result && (
              <span role="status" className={result.ok && result.canPush ? "" : "error"}>
                {result.message}
              </span>
            )}
          </p>
        ))}
      {act.view}
      <p className="muted" style={{ fontSize: 14, margin: 0 }}>
        Three words you will see: the <strong>default branch</strong> is the main copy of your code that approved work is added to. To <strong>merge</strong> is to add approved work into that copy. A <strong>pull request</strong> is a proposal to merge that you read and accept on GitHub first. Other kinds of key and the full form are in Settings → Secrets.
      </p>
    </div>
  );
}

function FundingStep({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const sources = usePoll((signal) => api<FundingSource[]>("/api/funding-sources", { signal }), 15_000, "setup-sources");
  const ceo = company.agents.find((a) => a.role === "ceo");
  const [error, setError] = useState<string | null>(null);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Funding company={company} onChanged={() => (sources.reload(), onChanged())} />
      {ceo && (
        <div className="field" style={{ maxWidth: 420 }}>
          <label htmlFor="setup-ceo-funding">{ceo.name === "CEO" ? "The CEO" : `${ceo.name} (CEO)`} runs on</label>
          <select
            id="setup-ceo-funding"
            value={ceo.fundingSourceId ?? ""}
            onChange={(e) =>
              void api(`/api/agents/${ceo.id}`, { method: "PATCH", body: { fundingSourceId: e.target.value || null } }).then(
                () => (setError(null), onChanged()),
                (err) => setError((err as Error).message),
              )
            }
          >
            <option value="">Not set</option>
            {(sources.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {error && <small className="error">{error}</small>}
        </div>
      )}
    </div>
  );
}

function TicketStep({ company }: { company: Company }) {
  const projects = usePoll((signal) => api<Project[]>(`/api/companies/${company.id}/projects`, { signal }), 60_000, `setup-ticket-${company.id}`);
  const ceo = company.agents.find((a) => a.role === "ceo");
  // BOS-2814: "starts straight away" only when Claude, what pays for the CEO and the runner are all in place.
  const block = useStartBlock(company.id);
  const ready = block !== null && block.items.length === 0;
  const [form, setForm] = useState({ title: "", body: "", toCeo: false });
  // The task description is kept in this browser as it is typed (DR-045); it goes once the task is added.
  const bodyKey = `setup-ticket-body/${company.id}`;
  const [note, setNote] = useState<{ ok: boolean; text: string; taskId?: string } | null>(null);
  const project = projects.data?.[0];
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!project) return;
    try {
      const t = await api<{ id: string }>(`/api/projects/${project.id}/tickets`, {
        method: "POST",
        body: { title: form.title.trim(), body: form.body.trim() || null, ...(form.toCeo && ceo ? { assigneeAgentId: ceo.id } : {}) },
      });
      setForm({ title: "", body: "", toCeo: false });
      clearDraft(bodyKey);
      setNote({ ok: true, text: "Added.", taskId: t.id });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  if (!project) return <p className="muted">Name a project first (step 2), then come back for this.</p>;
  return (
    <form onSubmit={add} style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
      <div className="field">
        <label htmlFor="setup-ticket-title">Title</label>
        <input id="setup-ticket-title" required maxLength={200} placeholder="e.g. Draft a one-page proposal template for new clients" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="setup-ticket-body">Description</label>
        <DraftTextarea draftKey={bodyKey} id="setup-ticket-body" rows={4} value={form.body} onChange={(text) => setForm({ ...form, body: text })} />
      </div>
      {ceo && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
          <input type="checkbox" checked={form.toCeo} onChange={(e) => setForm({ ...form, toCeo: e.target.checked })} />
          {ready ? `Give it to ${ceo.name} now (it starts straight away)` : `Give it to ${ceo.name}. It starts once Claude is connected and the runner is running.`}
        </label>
      )}
      <button type="submit" className="btn primary" style={{ alignSelf: "flex-start" }} disabled={!form.title.trim()}>
        Add the task to {project.name}
      </button>
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"}>
          {note.text}
          {note.taskId && (
            <>
              {" "}
              <a href={`#/tickets/${note.taskId}`}>Open the task</a>
            </>
          )}
        </p>
      )}
    </form>
  );
}

/** "Finish setting up" (R56): what's still undone, on Decisions, until it's done or dismissed. */
export function SetupChecklist({ companyId, go, folded = false }: { companyId: string | undefined; go: (to: string) => void; folded?: boolean }) {
  const progress = usePoll((signal) => api<Progress>("/api/setup-progress", { signal }), 60_000, "setup-progress");
  const list = usePoll((signal) => (companyId ? api<ChecklistItem[]>(`/api/companies/${companyId}/setup-checklist`, { signal }) : Promise.resolve([])), 30_000, `setup-checklist-${companyId ?? "none"}`);
  const items = list.data ?? [];
  const act = useAction();
  if (!companyId || !progress.data || progress.data.dismissed || !items.length) return null;
  const doneCount = items.filter((i) => i.done).length;
  // Once everything is ticked (the first merge is the last item) the card stays, with the merge time, until dismissed.
  const allDone = doneCount === items.length;
  const Wrap = folded ? "details" : "section";
  return (
    <Wrap className="card" aria-labelledby={folded ? undefined : "finish-setup-h"} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {folded && (
        <summary style={{ fontSize: 16, fontWeight: 600, cursor: "pointer" }}>
          {allDone ? "Setup finished" : "Finish setting up"}: {doneCount} of {items.length} done
        </summary>
      )}
      <div style={{ display: "flex", justifyContent: folded ? "flex-end" : "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {!folded && (
          <h2 id="finish-setup-h" style={{ fontSize: 16, fontWeight: 600 }}>
            {allDone ? "Setup finished" : "Finish setting up"}
          </h2>
        )}
        <span style={{ display: "flex", gap: 8 }}>
          {!allDone && (
            <button type="button" className="btn primary" onClick={() => go("setup")}>
              Continue
            </button>
          )}
          <button
            type="button"
            className="btn"
            disabled={act.busy}
            onClick={() =>
              void act.run(async () => {
                await api("/api/setup-progress", { method: "PUT", body: { dismissed: true } });
                progress.reload();
              })
            }
          >
            {act.busy ? "Saving…" : "Dismiss"}
          </button>
        </span>
      </div>
      {act.view}
      {!folded && (
        <p className="setup-count">
          Setup: {doneCount} of {items.length} done
        </p>
      )}
      <ul className="checklist">
        {items.map((i) => (
          <li key={i.id} className={i.done ? "done" : ""}>
            <span aria-hidden="true">{i.done ? "✓" : "○"}</span> {i.label}
            <span className="sr-only">{i.done ? " (done)" : " (to do)"}</span>
          </li>
        ))}
      </ul>
    </Wrap>
  );
}

export function Setup({ companies, go, onChanged }: { companies: Company[]; go: (to: string) => void; onChanged: () => void }) {
  const progress = usePoll((signal) => api<Progress>("/api/setup-progress", { signal }), 0x7fffffff, "setup-progress-page");
  const [step, setStep] = useState<number | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(null);
  // Saving the Claude setup token also made the funding source, so "What pays for the CEO" is skipped (BOS-1495).
  const [tokenPath, setTokenPath] = useState(false);
  const [chosen, setChosen] = useState<Work | null>(null);
  useEffect(() => {
    if (progress.data && step === null) {
      setStep(savedStep(Math.min(progress.data.step, STEPS.length - 1)));
      setCompanyId(progress.data.companyId);
    }
  }, [progress.data, step]);
  // Focus moves to the step's form each time the step changes (not on the first show), so keyboard and screen-reader users land on it.
  const formRef = useRef<HTMLElement>(null);
  const shown = useRef<number | null>(null);
  useEffect(() => {
    if (step !== null && shown.current !== null && shown.current !== step) formRef.current?.focus({ preventScroll: true });
    shown.current = step;
  }, [step]);
  const company = companies.find((c) => c.id === companyId) ?? (companyId ? undefined : companies[0]);
  const list = usePoll((signal) => (company ? api<ChecklistItem[]>(`/api/companies/${company.id}/setup-checklist`, { signal }) : Promise.resolve([])), 3_000, `setup-steps-${company?.id ?? "none"}`);
  const projs = usePoll((signal) => (company ? api<Project[]>(`/api/companies/${company.id}/projects`, { signal }) : Promise.resolve([] as Project[])), 15_000, `setup-work-${company?.id ?? "none"}`);
  if (step === null) return null;
  // Documents is the default; a project with a repo means Code whatever was clicked.
  const work: Work = (Array.isArray(projs.data) ? projs.data : []).some((p) => p.repoUrl) ? "code" : chosen ?? progress.data?.work ?? "docs";
  const setWork = (w: Work) => {
    setChosen(w);
    save({ work: w });
    list.reload();
  };
  const CODE_ONLY = ["git", "checks"];
  const visible = STEPS.map((x, i) => ({ x, i })).filter(({ x }) => work === "code" || !CODE_ONLY.includes(x.id));
  // After any save in a step: re-read the checklist (so "Next" appears now) and the companies (the CEO's funding).
  const refresh = () => (list.reload(), onChanged());
  const save = (patch: Partial<Progress>) => void api("/api/setup-progress", { method: "PUT", body: patch }).catch(() => {});
  const move = (to: number) => {
    setStep(to);
    save({ step: savedStep(to), companyId: company?.id ?? null });
    window.scrollTo({ top: 0 });
  };
  const finish = () => {
    // Leaving closes the wizard only; the checklist stays until it is all done or Dismiss is pressed on it (F20).
    save({ left: true, step: STEPS.length - 1 });
    go("board");
  };
  const s = STEPS[step]!;
  const done = (id: string) => list.data?.find((i) => i.id === id)?.done ?? false;
  const FUNDING = STEPS.findIndex((x) => x.id === "funding");
  // Going forward steps over the funding step when the token path already did it; Back and the stepper still reach it.
  const after = (from: number) => visible.find(({ i }) => i > from)?.i ?? from + 1;
  const next = after(step) === FUNDING && tokenPath && done("funding") ? after(FUNDING) : after(step);
  const pos = Math.max(0, visible.findIndex(({ i }) => i === step));
  const last = visible[visible.length - 1]!.i;
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">Setting up · step {pos + 1} of {visible.length}</p>
          <progress className="setup-bar" aria-label="Setup progress" max={visible.length} value={pos + 1} />
          <h1>{s.title}</h1>
          <p className="sub">{s.why}</p>
          {STEP_GUIDE[s.id] && (
            <p style={{ marginTop: 4 }}>
              <GuideLink slug={STEP_GUIDE[s.id]!.slug}>{STEP_GUIDE[s.id]!.text}</GuideLink>
            </p>
          )}
        </div>
      </header>
      <ol className="stepper" aria-label="Setup steps">
        {visible.map(({ x, i }, n) => (
          <li key={x.id} aria-current={i === step ? "step" : undefined} className={done(x.id) ? "done" : ""}>
            <button type="button" className="linkish" onClick={() => company && move(i)} disabled={!company && i > 0}>
              <span aria-hidden="true">{done(x.id) ? "✓" : n + 1}</span> {x.title}
            </button>
          </li>
        ))}
      </ol>
      <section ref={formRef} tabIndex={-1} aria-label={s.title} className="card setup-card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {step === 0 && (
          <CompanyStep
            company={company}
            onCreated={(id) => {
              setCompanyId(id);
              save({ companyId: id, step: 0 });
              onChanged();
              list.reload();
            }}
          />
        )}
        {step === 1 && company && <ProjectStep company={company} work={work} onWork={setWork} onChanged={refresh} />}
        {step === 2 && company && <ClaudeStep company={company} onChanged={refresh} onTokenSaved={() => setTokenPath(true)} />}
        {step === 3 && company && <RunnerStep company={company} onChanged={refresh} />}
        {step === 4 && company && <GitStep company={company} onChanged={refresh} />}
        {step === 5 && company && <ChecksStep company={company} onChanged={refresh} />}
        {step === 6 && company && <FundingStep company={company} onChanged={refresh} />}
        {step === 7 && company && <TicketStep company={company} />}
        {step === 8 && company && <BeforeStep items={list.data ?? []} onFix={(id) => move(STEPS.findIndex((x) => x.id === id))} />}
        <div className="setup-nav">
          {step > 0 && (
            <button type="button" className="btn" onClick={() => move([...visible].reverse().find(({ i }) => i < step)?.i ?? step - 1)}>
              Back
            </button>
          )}
          {step < last ? (
            <>
              <button type="button" className="btn primary" disabled={!company || !done(s.id)} onClick={() => move(next)}>
                Next: {STEPS[next]!.title}
              </button>
              {!done(s.id) && (
                <button type="button" className="linkish" disabled={!company} onClick={() => move(next)}>
                  Skip this step
                </button>
              )}
            </>
          ) : (
            <button type="button" className="btn primary" onClick={finish}>
              Leave setup for now
            </button>
          )}
          {step === 0 && (
            <button type="button" className="linkish" onClick={finish}>
              Skip setup for now
            </button>
          )}
        </div>
      </section>
    </>
  );
}
