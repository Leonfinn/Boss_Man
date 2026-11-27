// The setup wizard (R56): eight steps from a new install to agents at work, each skippable,
// with progress saved so it resumes. The steps reuse the Settings sections, so there's one way
// to do each thing. What's still undone shows on Decisions until it's done or dismissed.
import { useEffect, useState, type FormEvent } from "react";
import { api, type Company, type FundingSource, type Project } from "../api";
import { SaveButton, useSaveState } from "../components/SaveButton";
import { usePoll } from "../hooks";
import { clearDraft } from "../drafts";
import { DraftTextarea } from "../components/DraftTextarea";
import { Credentials } from "./settings/Credentials";
import { useAction } from "./settings/shared";
import { Funding } from "./settings/Funding";
import { ProjectRow } from "./settings/Projects";
import { ClaudeStep, RunnerStep } from "./SetupClaude";

type Progress = { dismissed: boolean; step: number; companyId: string | null; firstMerge?: { ref: string; minutes: number } | null; work?: "docs" | "code" };
export type ChecklistItem = { id: string; label: string; done: boolean };

const STEPS = [
  { id: "company", title: "Your company", why: "Name it and say what it's for. The CEO plans the work from this." },
  { id: "project", title: "What will your team work on?", why: "Pick the kind of work your team does and name its first project. You can change this later in Settings." },
  { id: "runner", title: "The runner", why: "The runner is the container the company's agents work in. It connects out to this server, so it needs no open ports. The full panel is in Settings." },
  { id: "credential", title: "Claude", why: "Agents need something to run on. Paste the setup token from your Claude Pro or Max subscription: it also pays for the CEO. Or use an API key instead." },
  { id: "git", title: "A git token", why: "So agents can clone, push, and open pull requests on the project's repo." },
  { id: "checks", title: "Checks before merging", why: "Boss Man looks at the repo, through the runner, and proposes the check that runs before work merges. High-risk work can add a slower one." },
  { id: "funding", title: "What pays for the CEO", why: "Funding sources track cost and quota. Choose the one the CEO runs on; the Agents page sets the rest." },
  { id: "ticket", title: "A first task", why: "Optional: something for the team to start on." },
] as const;

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
        <input id="setup-name" required maxLength={80} placeholder="e.g. Boss Man Co" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="setup-mission">What it's for</label>
        <DraftTextarea draftKey={missionKey} id="setup-mission" rows={3} maxLength={2000} placeholder="e.g. Build and run Boss Man itself: features from the roadmap, fixes from feedback." value={mission} onChange={setMission} />
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
    </div>
  );
}

function ChecksStep({ company, onChanged }: { company: Company; onChanged: () => void }) {
  const projects = usePoll((signal) => api<Project[]>(`/api/companies/${company.id}/projects`, { signal }), 60_000, `setup-checks-${company.id}`);
  const withRepo = (projects.data ?? []).filter((p) => p.repoUrl);
  if (!withRepo.length) return <p className="muted">No project has a repo yet. Add one in step 2, then come back for this.</p>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
    <details className="token-help" style={{ fontSize: 14 }}>
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
  const [result, setResult] = useState<{ ok: boolean; canPush: boolean; message: string } | null>(null);
  const withRepo = (projects.data ?? []).filter((p) => p.repoUrl);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Credentials company={company} onChanged={onChanged} />
      {projects.data && <TokenHelp projects={withRepo} />}
      {withRepo.map((p) => (
        <p key={p.id} style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: 0 }}>
          <button type="button" className="btn" onClick={() => void api<{ ok: boolean; canPush: boolean; message: string }>(`/api/projects/${p.id}/check-git-token`, { method: "POST" }).then(setResult, (err) => setResult({ ok: false, canPush: false, message: (err as Error).message })).finally(onChanged)}>
            Check the token against {p.name}
          </button>
          {result && (
            <span role="status" className={result.ok && result.canPush ? "" : "error"}>
              {result.message}
            </span>
          )}
        </p>
      ))}
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
  const [form, setForm] = useState({ title: "", body: "", toCeo: false });
  // The task description is kept in this browser as it is typed (DR-045); it goes once the task is added.
  const bodyKey = `setup-ticket-body/${company.id}`;
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
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
      setNote({ ok: true, text: `Added. Open it from the Kanban, or at #/tickets/${t.id}.` });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  if (!project) return <p className="muted">Name a project first (step 2), then come back for this.</p>;
  return (
    <form onSubmit={add} style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 640 }}>
      <div className="field">
        <label htmlFor="setup-ticket-title">Title</label>
        <input id="setup-ticket-title" required maxLength={200} placeholder="e.g. Read the repo and propose a roadmap" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="setup-ticket-body">Description</label>
        <DraftTextarea draftKey={bodyKey} id="setup-ticket-body" rows={4} value={form.body} onChange={(text) => setForm({ ...form, body: text })} />
      </div>
      {ceo && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
          <input type="checkbox" checked={form.toCeo} onChange={(e) => setForm({ ...form, toCeo: e.target.checked })} />
          Give it to {ceo.name} now (it starts straight away)
        </label>
      )}
      <button type="submit" className="btn primary" style={{ alignSelf: "flex-start" }} disabled={!form.title.trim()}>
        Add the task to {project.name}
      </button>
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"}>
          {note.text}
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
      setStep(Math.min(progress.data.step, STEPS.length - 1));
      setCompanyId(progress.data.companyId);
    }
  }, [progress.data, step]);
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
    save({ step: to, companyId: company?.id ?? null });
    window.scrollTo({ top: 0 });
  };
  const finish = () => {
    save({ dismissed: true, step: STEPS.length - 1 });
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
          <p className="label">Setting up{pos > 0 ? ` · Step ${pos + 1} of ${visible.length}` : ""}</p>
          <h1>{s.title}</h1>
          <p className="sub">{s.why}</p>
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
      <section className="card" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
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
        {step === 2 && company && <RunnerStep company={company} onChanged={refresh} />}
        {step === 3 && company && <ClaudeStep company={company} onChanged={refresh} onTokenSaved={() => setTokenPath(true)} />}
        {step === 4 && company && <GitStep company={company} onChanged={refresh} />}
        {step === 5 && company && <ChecksStep company={company} onChanged={refresh} />}
        {step === 6 && company && <FundingStep company={company} onChanged={refresh} />}
        {step === 7 && company && <TicketStep company={company} />}
        <div className="setup-nav">
          {step > 0 && (
            <button type="button" className="btn" onClick={() => move([...visible].reverse().find(({ i }) => i < step)?.i ?? step - 1)}>
              Back
            </button>
          )}
          {step < last ? (
            <>
              <button type="button" className={done(s.id) ? "btn primary" : "btn"} disabled={!company} onClick={() => move(next)}>
                {done(s.id) ? "Next" : "Skip for now"}
              </button>
            </>
          ) : (
            <button type="button" className="btn primary" onClick={finish}>
              Finish
            </button>
          )}
          {step === 0 && (
            <button type="button" className="linkish" onClick={finish}>
              I know what I'm doing, let me get on with it
            </button>
          )}
        </div>
      </section>
    </>
  );
}
