// Skills (R71): the company's library of Agent Skills, and who has each. A skill is added from
// a GitHub link (pinned to a commit), written here, or uploaded as a folder, files or a zip.
import { harnessLabel, harnessLoadsSkills, RUNNER_ADDONS } from "@boss-man/shared";
import { AddToShortcuts } from "../pinned-pages";
import { NoCompany } from "../components/NoCompany";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";
import { unzipSync } from "fflate";
import { api, ApiError, type Company } from "../api";
import { Markdown } from "../components/Markdown";
import { Loader } from "../components/Loader";
import { LoadError } from "../components/LoadError";
import { useOlder, usePoll } from "../hooks";
import { ShowOlder } from "../components/ShowOlder";
import { diffLines } from "../line-diff";
import { buildCsv, download } from "../csv";
import { away } from "../server-watch";
import { when } from "./Runs";
import { SaveButton } from "../components/SaveButton";
import { clearDraft, readDraft } from "../drafts";
import { DraftTextarea } from "../components/DraftTextarea";
import { Section, useAction } from "./settings/shared";

type SkillInstructions = { path: string | null; body: string | null; empty: boolean; unreadable: boolean };
type SkillRow = { id: string; name: string; description: string; source: "written" | "link" | "upload" | "retro" | "builtin"; sourceUrl: string | null; sourceRef: string | null; pack: string | null; packUrl: string | null; sizeBytes: number; fileCount: number; hasInstructions?: boolean; instructionsPath?: string | null; instructionsUnreadable?: boolean; addedByOwner?: boolean; updatedAt: string; agents: Array<{ id: string; name: string }> };
type SkillDetail = Omit<SkillRow, "fileCount"> & { files: Array<{ path: string; size: number; sha256?: string; text: string | null }>; requiresAddons: string[] | null; instructions?: SkillInstructions };
type Upload = { path: string; content: string };
type Elsewhere = { id: string; name: string; description: string; companyName: string; requiresAddons: string[] | null; fileCount: number; hasScripts: boolean };

const SOURCE: Record<SkillRow["source"], string> = { link: "From a link", written: "Written here", upload: "Uploaded", retro: "From a workflow retro", builtin: "Built in to Boss Man" };
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const stripFrontmatter = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

export function toBase64(bytes: Uint8Array) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Files picked or dropped, as paths and base64; a zip is unpacked first. */
async function readUpload(list: FileList): Promise<Upload[]> {
  const out: Upload[] = [];
  for (const f of Array.from(list)) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (/\.zip$/i.test(f.name)) {
      for (const [path, data] of Object.entries(unzipSync(bytes))) if (!path.endsWith("/") && !path.startsWith("__MACOSX/")) out.push({ path, content: toBase64(data) });
    } else {
      out.push({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, content: toBase64(bytes) });
    }
  }
  return out;
}

function AddSkill({ companyId, onAdded }: { companyId: string; onAdded: (names: string[]) => void }) {
  const [tab, setTab] = useState<"link" | "written" | "upload">("link");
  const [url, setUrl] = useState("");
  const [form, setForm] = useState({ name: "", description: "", body: "" });
  // The skill's text is kept in this browser as it is typed (DR-045); it goes once the skill is made.
  const bodyKey = `skill-new/${companyId}`;
  const [files, setFiles] = useState<Upload[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = tab === "link" ? { from: "link", url: url.trim() } : tab === "written" ? { from: "written", ...form } : { from: "upload", files };
      const added = await api<Array<{ name: string }>>(`/api/companies/${companyId}/skills`, { method: "POST", body });
      setUrl("");
      setForm({ name: "", description: "", body: "" });
      clearDraft(bodyKey);
      setFiles([]);
      onAdded(added.map((s) => s.name));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const pick = async (e: ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files?.length) return;
    try {
      setFiles(await readUpload(e.target.files));
      setError(null);
    } catch {
      setError("Couldn't read those files.");
    }
  };
  const ready = tab === "link" ? /^https:\/\//.test(url.trim()) : tab === "written" ? form.name.trim() && form.description.trim() : files.length > 0;
  return (
    <form className="card" onSubmit={(e) => void submit(e)} style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-labelledby="add-skill-h">
      <h2 id="add-skill-h" style={{ fontSize: 17, fontWeight: 600 }}>
        Add a skill
      </h2>
      <div role="tablist" aria-label="How to add it" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {(
          [
            ["link", "From a link"],
            ["written", "Write one"],
            ["upload", "Upload"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={`btn${tab === id ? " primary" : ""}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "link" && (
        <div className="field">
          <label htmlFor="skill-url">GitHub link to a repository, a folder or a SKILL.md</label>
          <input id="skill-url" type="url" placeholder="https://github.com/owner/repo/tree/main/skills" value={url} onChange={(e) => setUrl(e.target.value)} />
          <small className="muted">Every skill under the link is added, pinned to the commit it points at now; several from one link become a pack you can give in one go. Private repositories work when the company has a git token that can read them (Settings → Secrets); a link straight to a SKILL.md file anywhere also works.</small>
        </div>
      )}
      {tab === "written" && (
        <>
          <div className="field">
            <label htmlFor="skill-name">Name</label>
            <input id="skill-name" maxLength={64} placeholder="release-notes" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="skill-desc">What it does and when to use it</label>
            <input id="skill-desc" maxLength={1024} placeholder="Writes release notes in our style. Use when asked for a changelog." value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <small className="muted">Agents decide when to load a skill from this line, so say when it applies.</small>
          </div>
          <div className="field">
            <label htmlFor="skill-body">Instructions, in Markdown</label>
            <DraftTextarea draftKey={bodyKey} id="skill-body" rows={10} value={form.body} onChange={(text) => setForm({ ...form, body: text })} style={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit" }} />
          </div>
        </>
      )}
      {tab === "upload" && (
        <div className="field">
          <label htmlFor="skill-files">A skill folder, its files, or a .zip</label>
          <input id="skill-files" type="file" multiple onChange={(e) => void pick(e)} />
          <label className="muted" style={{ fontSize: 13 }}>
            or a whole folder: <input type="file" aria-label="Choose a skill folder" {...{ webkitdirectory: "" }} onChange={(e) => void pick(e)} />
          </label>
          {files.length > 0 && <small className="muted">{files.length} files ready{files.some((f) => /(^|\/)SKILL\.md$/.test(f.path)) ? "" : ", but none is SKILL.md"}.</small>}
        </div>
      )}
      <p className="muted" style={{ fontSize: 13 }}>
        Skills are instructions your agents follow, and can include scripts. Add them only from sources you trust, and read a linked skill before giving it to agents.
      </p>
      <div>
        <button type="submit" className="btn primary" disabled={!ready || busy}>
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

/** Skills the owner's other companies already have, copied in instead of imported again (agents are given them afterwards). */
function FromOtherCompany({ company, onAdded }: { company: Company; onAdded: (name: string) => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Elsewhere[] | null>(null);
  const [status, setStatus] = useState<Record<string, { ok: boolean; text: string }>>({});
  const search = useAction();
  const add = useAction();
  const find = (text: string) => void search.run(async () => void setResults(await api<Elsewhere[]>(`/api/companies/${company.id}/skills/elsewhere?q=${encodeURIComponent(text.trim())}`)));
  useEffect(() => find(""), [company.id]);
  const copy = (r: Elsewhere) =>
    void add.run(async () => {
      try {
        const s = await api<{ id: string; name: string }>(`/api/companies/${company.id}/skills/copy`, { method: "POST", body: { skillId: r.id } });
        setStatus((all) => ({ ...all, [r.id]: { ok: true, text: `Added to ${company.name}. Choose who has it.` } }));
        onAdded(s.name);
      } catch (err) {
        setStatus((all) => ({ ...all, [r.id]: { ok: false, text: (err as Error).message } }));
      }
    });
  return (
    <Section id="from-other-h" title="Add from another company">
      <form onSubmit={(e) => (e.preventDefault(), find(q))} style={{ display: "flex", gap: 8 }}>
        <input type="search" aria-label="Search other companies' skills" placeholder="Search by name or description" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        <button type="submit" className="btn" disabled={search.busy}>
          Search
        </button>
      </form>
      {search.view}
      {results && results.length === 0 && <p className="muted">No skills in your other companies{q.trim() ? " match that" : ""}.</p>}
      <ul className="link-list">
        {results?.map((r) => (
          <li key={r.id} style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
            <span style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <strong className="mono">{r.name}</strong>
              <small className="muted">
                {r.companyName} · {r.fileCount} {r.fileCount === 1 ? "file" : "files"}
                {r.hasScripts && " · has scripts"}
                {r.requiresAddons?.length ? ` · needs ${r.requiresAddons.join(", ")}` : ""}
              </small>
              <button type="button" className="btn" style={{ marginLeft: "auto" }} disabled={add.busy || status[r.id]?.ok} onClick={() => copy(r)}>
                {status[r.id]?.ok ? "Added" : `Add to ${company.name}`}
              </button>
            </span>
            <span className="muted" style={{ fontSize: 13 }}>
              {r.description}
            </span>
            {status[r.id] && (
              <span role={status[r.id]!.ok ? "status" : "alert"} className={status[r.id]!.ok ? "muted" : "error"} style={{ fontSize: 13 }}>
                {status[r.id]!.text}
              </span>
            )}
          </li>
        ))}
      </ul>
      <p className="muted" style={{ fontSize: 13 }}>
        Copies the skill's files and details; agents here don't have it until you give it to them. Read any scripts first.
      </p>
    </Section>
  );
}

function SkillView({ company, id, onChanged, onClose }: { company: Company; id: string; onChanged: () => void; onClose: () => void }) {
  const skill = usePoll((signal) => api<SkillDetail>(`/api/companies/${company.id}/skills/${id}`, { signal }), 60_000, id);
  const [holders, setHolders] = useState<string[] | null>(null);
  const [savedHolders, setSavedHolders] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // The edit box is kept in this browser as it is typed (DR-045); it goes once saved, or on Cancel.
  const editKey = `skill-edit/${id}`;
  const [editing, setEditing] = useState<{ name: string; description: string; body: string } | null>(null);
  const s = skill.data;
  if (skill.error && !away(skill.error)) return <LoadError what="the skill" message={skill.error.message} onRetry={skill.reload} />;
  if (!s) return <Loader label="Loading the skill" size={16} />;
  const chosen = holders ?? s.agents.map((a) => a.id);
  const run = async (f: () => Promise<string>) => {
    try {
      setNote({ ok: true, text: await f() });
      skill.reload();
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  const instructions = s.instructions;
  const mainPath = instructions?.path ?? (s.files.some((f) => f.path === "SKILL.md") ? "SKILL.md" : null);
  const md = s.files.find((f) => f.path === mainPath)?.text ?? "";
  const body = instructions ? instructions.body ?? "" : stripFrontmatter(md).trim();
  const unreadable = instructions?.unreadable ?? false;
  const noInstructions = instructions ? instructions.empty && !instructions.unreadable : !body;
  // Only a skill that is just its SKILL.md can be edited here; a linked one follows its source, and a
  // built-in one is fixed text Boss Man ships (BOS-2631), so neither is edited in place.
  // A SKILL.md that isn't text is never opened as an empty editor, so a save can't wipe it.
  const editable = s.source !== "link" && s.source !== "builtin" && s.files.length === 1 && !!mainPath && !unreadable;
  const save = (confirmed = false) =>
    void run(async () => {
      if (!editing) return "Nothing to save.";
      const put = (confirmEmptyBody: boolean) =>
        api(`/api/companies/${company.id}/skills/${id}`, { method: "PUT", body: { ...editing, ...(confirmEmptyBody ? { confirmEmptyBody: true } : {}) } });
      try {
        await put(confirmed);
      } catch (err) {
        if (!confirmed && err instanceof ApiError && err.status === 409 && /instructions/i.test(err.message)) {
          if (window.confirm("This skill has instructions. Saving an empty Instructions box will delete them. Delete them anyway?")) await put(true);
          else return "Nothing saved. The skill's instructions are still there.";
        } else {
          throw err;
        }
      }
      setEditing(null);
      clearDraft(editKey);
      return "Saved. Agents get the new version from their next run.";
    });
  return (
    <article className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }} aria-labelledby="skill-h">
      <header style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 id="skill-h" className="mono" style={{ fontSize: 20, fontWeight: 600 }}>
            {s.name}
          </h2>
          <p>{s.description}</p>
          {noInstructions && (
            <p className="banner" role="status">
              <span>{mainPath ? "No instructions: this skill does nothing when loaded." : "This skill has no SKILL.md, so it does nothing when loaded."}</span>
            </p>
          )}
          {unreadable && (
            <p className="banner" role="status">
              <span>Instructions unreadable: the SKILL.md isn't text, so it can't be shown safely here.</span>
            </p>
          )}
          <p className="muted" style={{ fontSize: 13 }}>
            {SOURCE[s.source]}
            {s.sourceUrl && (
              <>
                {" · "}
                <a href={s.sourceUrl} target="_blank" rel="noopener noreferrer">
                  {s.sourceUrl.replace(/^https:\/\//, "")}
                </a>
                {s.sourceRef && <span className="mono"> @ {s.sourceRef.slice(0, 7)}</span>}
              </>
            )}{" "}
            · {kb(s.sizeBytes)} · changed {when(s.updatedAt)}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          {editable && !editing && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                const kept = readDraft(editKey);
                setEditing({ name: s.name, description: s.description, body: kept || body });
              }}
            >
              Edit
            </button>
          )}
          {s.source === "link" && (
            <button type="button" className="btn" onClick={() => void run(async () => ((await api<{ changed: boolean }>(`/api/companies/${company.id}/skills/${id}/refresh`, { method: "POST" })).changed ? "A newer version was found. It is not installed: it goes to the Security Reviewer, then to Decisions for you." : "Already up to date."))}>
              Check for updates
            </button>
          )}
          {s.source !== "builtin" && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                if (!window.confirm(`Delete ${s.name}? Agents that have it lose it.`)) return;
                void api(`/api/companies/${company.id}/skills/${id}`, { method: "DELETE" }).then(() => (onChanged(), onClose()), (err: Error) => setNote({ ok: false, text: err.message }));
              }}
            >
              Delete
            </button>
          )}
        </div>
      </header>

      <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 14px" }}>
        <legend style={{ padding: "0 6px", fontWeight: 600 }}>Who has it</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
          {company.agents.map((a) => (
            <label key={a.id} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <input type="checkbox" checked={chosen.includes(a.id)} onChange={(e) => setHolders(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))} />
              {a.name}
              {a.role === "ceo" && <span className="muted"> (CEO)</span>}
              {!harnessLoadsSkills(a.agentKind) && <span className="tag red" title={`${harnessLabel(a.agentKind)} can't load skills, so giving it this one does nothing.`}>{harnessLabel(a.agentKind)} can't load skills</span>}
            </label>
          ))}
        </div>
        {(holders || savedHolders) && (
          <SaveButton dirty={!!holders} saved={savedHolders} style={{ marginTop: 10 }} onClick={() => void run(async () => (await api(`/api/companies/${company.id}/skills/${id}/agents`, { method: "PUT", body: { agentIds: holders } }), setHolders(null), setSavedHolders(true), "Saved. Agents get it from their next run."))} />
        )}
        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          The CEO can also give and take skills; you're told when it does. Skills load for agents on Claude Code and OpenCode; Codex agents can't load them.
        </p>
      </fieldset>

      <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 14px" }}>
        <legend style={{ padding: "0 6px", fontWeight: 600 }}>Needs a runner add-on</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
          {RUNNER_ADDONS.map((a) => {
            const needs = s.requiresAddons ?? [];
            return (
              <label key={a.id} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={needs.includes(a.id)}
                  onChange={(e) => {
                    const on = e.target.checked;
                    void run(async () => {
                      await api(`/api/companies/${company.id}/skills/${id}/addons`, { method: "PUT", body: { requires: on ? [...needs, a.id] : needs.filter((x) => x !== a.id) } });
                      return on ? `Saved. ${s.name} goes with runs only while the runner reports ${a.title} working.` : "Saved.";
                    });
                  }}
                />
                {a.title}
              </label>
            );
          })}
        </div>
        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          A skill that needs an add-on is left out of runs while the runner doesn't have it working, and you're told once. See Settings → Server and runner → Runner → Add-ons.
        </p>
      </fieldset>

      {note && (
        <p className={note.ok ? "muted" : "error"} role={note.ok ? "status" : "alert"}>
          {note.text}
        </p>
      )}

      {editing ? (
        <section aria-label="Edit skill" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {readDraft(editKey) && (
            <p className="muted" role="status" style={{ fontSize: 13, margin: 0 }}>
              Draft restored: what you were writing is kept in this browser.{" "}
              <button type="button" className="link" style={{ padding: 0 }} onClick={() => { clearDraft(editKey); setEditing({ ...editing, body }); }}>
                Discard draft
              </button>
            </p>
          )}
          <div className="field">
            <label htmlFor="edit-skill-name">Name</label>
            <input id="edit-skill-name" maxLength={64} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="edit-skill-desc">What it does and when to use it</label>
            <input id="edit-skill-desc" maxLength={1024} value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="edit-skill-body">Instructions, in Markdown</label>
            <DraftTextarea draftKey={editKey} id="edit-skill-body" rows={18} value={editing.body} onChange={(text) => setEditing({ ...editing, body: text })} style={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit" }} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn primary" disabled={!editing.name.trim() || !editing.description.trim()} onClick={() => save()}>
              Save
            </button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </section>
      ) : (
        <section aria-label="SKILL.md">
          <Markdown text={body} linkContext={{ companyId: company.id }} />
        </section>
      )}
      {s.files.length > 1 && (
        <section aria-labelledby="skill-files-h">
          <h3 id="skill-files-h" style={{ fontWeight: 600, marginBottom: 6 }}>
            Files
          </h3>
          <ul className="link-list">
            {s.files.map((f) => (
              <li key={f.path} style={{ flexDirection: "column", alignItems: "stretch" }}>
                <span style={{ display: "flex", gap: 10, alignItems: "center" }}>
                  {f.text !== null && f.path !== "SKILL.md" ? (
                    <button type="button" className="link mono" aria-expanded={open === f.path} onClick={() => setOpen(open === f.path ? null : f.path)}>
                      {f.path}
                    </button>
                  ) : (
                    <span className="mono">{f.path}</span>
                  )}
                  <small className="muted">
                    {f.text === null ? `binary, ${kb(f.size)}` : kb(f.size)}
                    {f.sha256 ? <span title={f.sha256}> · sha256 <span className="mono">{f.sha256.slice(0, 16)}</span></span> : null}
                  </small>
                </span>
                {open === f.path && f.text !== null && <pre className="skill-file">{f.text}</pre>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <SkillHistory companyId={company.id} id={id} />
    </article>
  );
}

type HistoryEntry = { id: string; at: string; what: string; who: string; summary: string; change: { before: string; after: string } | null };
const DIFF_MARK = { add: "+", del: "−", same: " " } as const;

// What changed in this skill and when (BOS-2376); an edit or revert folds out a line diff of SKILL.md.
function SkillHistory({ companyId, id }: { companyId: string; id: string }) {
  const history = usePoll((signal) => api<HistoryEntry[]>(`/api/companies/${companyId}/skills/${id}/history`, { signal }), 60_000, id);
  return (
    <section aria-labelledby="skill-history-h">
      <h3 id="skill-history-h" style={{ fontWeight: 600, marginBottom: 6 }}>
        History
      </h3>
      {history.error ? (
        <LoadError what="the history" message={history.error.message} onRetry={history.reload} />
      ) : !history.data ? (
        <Loader />
      ) : history.data.length === 0 ? (
        <p className="muted">No changes recorded for this skill yet.</p>
      ) : (
        <ul className="link-list">
          {history.data.map((h) => (
            <li key={h.id} style={{ flexDirection: "column", alignItems: "stretch" }}>
              <span>
                <strong>{h.what}</strong> · {h.who} · <small className="muted">{when(h.at)}</small>
              </span>
              <small className="muted">{h.summary}</small>
              {h.change && (
                <details>
                  <summary>What changed</summary>
                  <div style={{ fontFamily: "var(--mono)", fontSize: 13, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                    {diffLines(h.change.before, h.change.after).map((l, i) => (
                      <div key={i} style={l.kind === "add" ? { background: "var(--green-soft)", color: "var(--green-ink)" } : l.kind === "del" ? { background: "var(--red-soft)", color: "var(--red-ink)" } : undefined}>
                        <span aria-hidden="true">{DIFF_MARK[l.kind]} </span>
                        {l.kind !== "same" && <span className="sr-only">{l.kind === "add" ? "Added: " : "Removed: "}</span>}
                        {l.text || " "}
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A pack (R71): skills added together from one link, given, updated and removed as one. */
function PackView({ company, pack, rows, onChanged, onPick, onClose }: { company: Company; pack: string; rows: SkillRow[]; onChanged: () => void; onPick: (id: string) => void; onClose: () => void }) {
  const [holders, setHolders] = useState<string[] | null>(null);
  const [savedHolders, setSavedHolders] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const holds = (agentId: string) => rows.filter((r) => r.agents.some((a) => a.id === agentId)).length;
  const chosen = holders ?? company.agents.filter((a) => holds(a.id) === rows.length).map((a) => a.id);
  const url = rows.find((r) => r.packUrl)?.packUrl;
  const run = async (f: () => Promise<string>) => {
    try {
      setNote({ ok: true, text: await f() });
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  return (
    <article className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }} aria-labelledby="pack-h">
      <header style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <p className="label">Skill pack</p>
          <h2 id="pack-h" className="mono" style={{ fontSize: 20, fontWeight: 600 }}>
            {pack}
          </h2>
          <p className="muted" style={{ fontSize: 13 }}>
            {rows.length} skills
            {url && (
              <>
                {" from "}
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {url.replace(/^https:\/\//, "")}
                </a>
              </>
            )}
            {rows[0]?.sourceRef && <span className="mono"> @ {rows[0].sourceRef.slice(0, 7)}</span>}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            className="btn"
            onClick={() =>
              void run(async () => {
                const r = await api<{ proposed: string[]; unchanged: number; problems: string[] }>(`/api/companies/${company.id}/skill-packs/refresh`, { method: "POST", body: { pack } });
                const parts = [r.proposed.length ? `newer versions of ${r.proposed.join(", ")} are waiting for review and your decision (nothing is installed yet)` : null, r.problems.length ? r.problems.join("; ") : null].filter(Boolean);
                return parts.length ? `${parts.join("; ")}.` : "Already up to date.";
              })
            }
          >
            Check for updates
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (!window.confirm(`Remove all ${rows.length} skills in ${pack}? Agents that have them lose them.`)) return;
              void api(`/api/companies/${company.id}/skill-packs?pack=${encodeURIComponent(pack)}`, { method: "DELETE" }).then(() => (onChanged(), onClose()), (err: Error) => setNote({ ok: false, text: err.message }));
            }}
          >
            Remove pack
          </button>
        </div>
      </header>

      <fieldset style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "10px 14px" }}>
        <legend style={{ padding: "0 6px", fontWeight: 600 }}>Who has the whole pack</legend>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 16px" }}>
          {company.agents.map((a) => {
            const n = holds(a.id);
            return (
              <label key={a.id} style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={chosen.includes(a.id)}
                  ref={(el) => {
                    if (el) el.indeterminate = holders === null && n > 0 && n < rows.length;
                  }}
                  onChange={(e) => setHolders(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))}
                />
                {a.name}
                {!harnessLoadsSkills(a.agentKind) && <span className="tag red" title={`${harnessLabel(a.agentKind)} can't load skills, so giving it these does nothing.`}>{harnessLabel(a.agentKind)} can't load skills</span>}
                {holders === null && n > 0 && n < rows.length && <span className="muted"> ({n} of {rows.length})</span>}
              </label>
            );
          })}
        </div>
        {(holders || savedHolders) && (
          <SaveButton dirty={!!holders} saved={savedHolders} style={{ marginTop: 10 }} onClick={() => void run(async () => (await api(`/api/companies/${company.id}/skill-packs/agents`, { method: "PUT", body: { pack, agentIds: holders } }), setHolders(null), setSavedHolders(true), "Saved. Agents get the pack from their next run."))} />
        )}
      </fieldset>
      {note && (
        <p className={note.ok ? "muted" : "error"} role={note.ok ? "status" : "alert"}>
          {note.text}
        </p>
      )}
      <ul className="link-list">
        {rows.map((r) => (
          <li key={r.id} style={{ alignItems: "baseline" }}>
            <button type="button" className="link mono" onClick={() => onPick(r.id)}>
              {r.name}
            </button>
            <span className="muted" style={{ fontSize: 13 }}>
              {r.description}
            </span>
          </li>
        ))}
      </ul>
    </article>
  );
}

const PROPOSALS_PAGE = 50;
type ProposalRow = { id: string; name: string; source: "draft" | "link" | "retro"; status: string; verdict: string | null; reviewRequired: boolean; overridden: boolean; createdAt: string };
const PROPOSAL_STATUS: Record<string, string> = {
  proposed: "Waiting",
  in_review: "With the Security Reviewer",
  awaiting_owner: "Waiting for your decision",
  installed: "Added",
  rejected: "Not added",
  stale: "Not added: the source changed",
  expired: "Expired after 14 days",
};

/** Skills the CEO proposed, and where each one stands. The decision itself is answered in Decisions. */
function Proposals({ companyId }: { companyId: string }) {
  // The newest PROPOSALS_PAGE, then older ones on "Show older" (BOS-2165): the server never sends the files here.
  // Paths written out inside api(…): the screen inventory (screen-scan.ts) only sees a read written there.
  const list = usePoll((signal) => api<ProposalRow[]>(`/api/companies/${companyId}/skill-proposals?limit=${PROPOSALS_PAGE}`, { signal }), 30_000, companyId);
  const older = useOlder(list.data, PROPOSALS_PAGE, (before) => api<ProposalRow[]>(`/api/companies/${companyId}/skill-proposals?limit=${PROPOSALS_PAGE}&before=${before}`), companyId);
  const rows = older.rows ?? [];
  if (!rows.length) return null;
  return (
    <section className="card" aria-label="Skill proposals" style={{ marginBottom: 16 }}>
      <h2>Skill proposals</h2>
      <ul>
        {rows.map((p) => (
          <li key={p.id}>
            <span className="mono">{p.name}</span> · {p.source === "link" ? "from the internet" : p.source === "retro" ? "from a workflow retro" : "CEO draft"} · {PROPOSAL_STATUS[p.status] ?? p.status}
            {` · security review: ${p.verdict ? p.verdict.replace("_", " ") : "pending"}`}
            {p.overridden ? " · added against the reviewer's advice" : ""}
            {p.status === "awaiting_owner" ? <> · <a href="#/decisions">Decide</a></> : null}
          </li>
        ))}
      </ul>
      <ShowOlder older={older} />
    </section>
  );
}

type Upstream = { status: "current" | "unchecked" } | { status: "newer"; commit: string; date: string | null } | { status: "error"; reason: string };

/** Why a skill needs a look (BOS-2518), from what the page already loads; the first one found names its row tag. */
type Attention = "unreadable" | "no-instructions" | "newer" | "unchecked" | "nobody" | "unloadable" | "healthy";
const needsAttention = (s: SkillRow, u: Upstream | undefined, whatHarness: (agentId: string) => string): Attention | null => {
  if (s.instructionsUnreadable) return "unreadable";
  if (s.hasInstructions === false) return "no-instructions";
  if (u?.status === "newer") return "newer";
  if (u?.status === "error") return "unchecked";
  if (s.agents.length === 0) return "nobody";
  if (s.agents.every((a) => !harnessLoadsSkills(whatHarness(a.id)))) return "unloadable";
  return null;
};
/** The words BOS-2518's row tags use for each reason, so the CSV's "needs attention" column reads the same as the list. */
export const ATTENTION_WORDS: Record<Attention, string> = {
  unreadable: "Instructions unreadable",
  "no-instructions": "No instructions",
  newer: "Newer version available",
  unchecked: "Couldn't check for updates",
  nobody: "Nobody has it",
  unloadable: "Only agents that can't load skills",
  healthy: "",
};

/** Every reason a shown skill needs attention, in the order the row tag picks its first one (BOS-2518); empty when none. */
export function attentionReasons(s: SkillRow, u: Upstream | undefined, whatHarness: (agentId: string) => string): string[] {
  const out: string[] = [];
  if (s.instructionsUnreadable) out.push(ATTENTION_WORDS.unreadable);
  if (s.hasInstructions === false) out.push(ATTENTION_WORDS["no-instructions"]);
  if (u?.status === "newer") out.push(u.date ? `${ATTENTION_WORDS.newer} (${u.date.slice(0, 10)})` : ATTENTION_WORDS.newer);
  if (u?.status === "error") out.push(ATTENTION_WORDS.unchecked);
  if (s.agents.length === 0) out.push(ATTENTION_WORDS.nobody);
  else if (s.agents.every((a) => !harnessLoadsSkills(whatHarness(a.id)))) out.push(ATTENTION_WORDS.unloadable);
  return out;
}

export const SKILLS_CSV_HEAD = ["Name", "Description", "Where from", "Source link", "Pack", "Files", "Size", "Updated", "Agents", "Needs attention"];

/** One row per skill shown, in the order the list shows them (a pack's name, then its skills), from what the page already loads. */
export function skillsToCsv(shown: SkillRow[], u: Record<string, Upstream>, whatHarness: (agentId: string) => string): string {
  return buildCsv(
    SKILLS_CSV_HEAD,
    shown.map((s) => [
      s.name,
      s.description ?? "",
      SOURCE[s.source],
      s.sourceUrl ?? "",
      s.pack ?? "",
      s.fileCount,
      kb(s.sizeBytes),
      s.updatedAt.slice(0, 10),
      s.agents.map((a) => a.name).join("; "),
      attentionReasons(s, u[s.id], whatHarness).join("; "),
    ]),
  );
}

/** The tag on a row that needs attention; 1 and 2 keep the tags they already had. */
function AttentionTag({ why }: { why: Attention }) {
  if (why === "unreadable") return <span className="tag red" title="The SKILL.md isn't text, so its instructions can't be shown.">Instructions unreadable</span>;
  if (why === "no-instructions") return <span className="tag red" title="No instructions: this skill does nothing when loaded.">No instructions</span>;
  if (why === "nobody") return <span className="tag amber" title="Nobody has it: give it to the agents whose work calls for it.">Nobody has it</span>;
  if (why === "unloadable") return <span className="tag red" title="Everyone who has it runs on a harness that can't load skills, so it does nothing.">Only agents that can't load skills</span>;
  return null;
}

/** A text tag (no button): the Refresh button stays the only way to take a newer version. */
function UpstreamTag({ u }: { u: Upstream | undefined }) {
  if (u?.status === "newer") return <span className="tag amber">Newer version available{u.date ? ` (${u.date.slice(0, 10)})` : ""}</span>;
  if (u?.status === "error") return <span className="tag" title={u.reason}>Couldn't check for updates: {u.reason}</span>;
  return null;
}

export function Skills({ company, skillId }: { company: Company | undefined; skillId?: string }) {
  // The server keeps each source's answer for 6 hours, so asking now and then costs GitHub nothing extra.
  const updates = usePoll((signal) => (company ? api<Record<string, Upstream>>(`/api/companies/${company.id}/skills/updates`, { signal }) : Promise.resolve({})), 600_000, company?.id ?? "none");
  const upstream: Record<string, Upstream> = updates.data ?? {};
  const list = usePoll((signal) => (company ? api<SkillRow[]>(`/api/companies/${company.id}/skills`, { signal }) : Promise.resolve([])), 30_000, company?.id ?? "none");
  // #/skills/<id> (the search box, BOS-2347) shows that skill, its pack folded open. App remounts the page on every
  // address change, so the first value is enough. On a phone the view sits under the list, so it is scrolled to.
  const [picked, setPicked] = useState<string | null>(skillId ?? null);
  useEffect(() => {
    if (skillId && list.data?.some((s) => s.id === skillId)) document.getElementById("skill-view")?.scrollIntoView?.({ block: "start" });
  }, [skillId, !!list.data]);
  const [pickedPack, setPickedPack] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // "Needs attention only" (BOS-2518): gathers the problem tags the page already shows into one switch and count.
  const [attentionOnly, setAttentionOnly] = useState(false);
  if (!company) return <NoCompany />;
  const rows = list.data ?? [];
  const needle = filter.trim().toLowerCase();
  const hits = (s: SkillRow) => s.name.toLowerCase().includes(needle) || (s.description ?? "").toLowerCase().includes(needle);
  const whatHarness = (agentId: string) => company.agents.find((c) => c.id === agentId)?.agentKind ?? "";
  const why = (s: SkillRow) => needsAttention(s, upstream[s.id], whatHarness);
  const needing = rows.filter((r) => why(r) !== null).length;
  const wanted = (s: SkillRow) => !attentionOnly || why(s) !== null;
  const allPacks = [...new Set(rows.map((r) => r.pack).filter((p): p is string => !!p))].sort();
  // A pack whose name matches shows all its skills; otherwise only the matching ones. A pack with none
  // needing attention is hidden under the switch (it shows when any of its skills needs attention).
  const packRows = (p: string) => {
    const all = rows.filter((r) => r.pack === p);
    const named = !needle || p.toLowerCase().includes(needle) ? all : all.filter(hits);
    return named.filter(wanted);
  };
  const packs = allPacks.filter((p) => packRows(p).length > 0);
  const loose = rows.filter((r) => !r.pack && (!needle || hits(r)) && wanted(r));
  // The skills the list shows, in its order (each pack's matching skills, then the loose ones), for the Download CSV.
  const shown = [...packs.flatMap((p) => packRows(p)), ...loose];
  const pick = (id: string) => (setPicked(id), setPickedPack(null), setAdding(false));
  const item = (s: SkillRow) => {
    const why1 = why(s);
    return (
    <li key={s.id}>
      <a href="#/skills" aria-current={s.id === picked && !adding ? "page" : undefined} onClick={(e) => (e.preventDefault(), pick(s.id))}>
        <span className="mono">{s.name}</span>
        <AttentionTag why={why1 ?? "healthy"} />
        {/* A pack shows "newer" once, on the pack; its skills show only their own read errors. */}
        <UpstreamTag u={s.pack && upstream[s.id]?.status === "newer" ? undefined : upstream[s.id]} />
        <small>
          {SOURCE[s.source]}{s.addedByOwner && s.source !== "written" ? " · added by the owner, not security-reviewed" : ""} · {s.agents.length ? s.agents.map((a) => (company.agents.find((c) => c.id === a.id) && !harnessLoadsSkills(company.agents.find((c) => c.id === a.id)!.agentKind) ? `${a.name} (can't load skills)` : a.name)).join(", ") : "nobody yet"}
        </small>
      </a>
    </li>
    );
  };
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">{company.name}</p>
          <h1>Skills</h1>
          <AddToShortcuts page="skills" />
          <p className="sub">Reusable instructions your agents load when they're relevant, in the Agent Skills format (a SKILL.md and any files it needs). Give each agent the skills its work calls for.</p>
        </div>
        <button type="button" className="btn primary" onClick={() => (setAdding(true), setPicked(null))}>
          Add a skill
        </button>
      </header>
      {added && (
        <p className="banner" role="status">
          <span>Added {added}. Choose who has it below.</span>
        </p>
      )}
      <Proposals companyId={company.id} />
      <div className="wiki">
        <nav className="card wiki-list" aria-label="Skills">
          {list.data && rows.length === 0 && <p className="muted">No skills yet.</p>}
          {rows.length > 0 && (
            <>
              <div className="field">
                <label htmlFor="skills-filter">Filter</label>
                <input id="skills-filter" type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Name or description" />
              </div>
              <div className="skills-attention">
                <span className="skills-attention-count" id="skills-attention-count">
                  {`${needing} ${needing === 1 ? "needs" : "need"} attention`}
                </span>
                <button type="button" role="switch" aria-checked={attentionOnly} aria-label="Needs attention only" className={`switch${attentionOnly ? " on" : ""}`} onClick={() => setAttentionOnly(!attentionOnly)}>
                  <span className="switch-knob" aria-hidden="true" />
                </button>
                <span className="muted" aria-hidden="true">Needs attention only</span>
                <button type="button" className="btn small" disabled={shown.length === 0} onClick={() => download(`skills-${new Date().toISOString().slice(0, 10)}.csv`, skillsToCsv(shown, upstream, whatHarness))}>
                  Download CSV
                </button>
              </div>
            </>
          )}
          {(needle || attentionOnly) && packs.length === 0 && loose.length === 0 && <p className="muted">{attentionOnly ? "Nothing needs attention." : "No skills match."}</p>}
          <ul>
            {packs.map((p) => {
              const inPack = packRows(p);
              return (
                <li key={`pack:${p}`}>
                  <details open={needle ? true : inPack.some((r) => r.id === picked) || undefined}>
                    <summary>
                      <button type="button" className="link mono" aria-current={pickedPack === p && !adding ? "page" : undefined} onClick={(e) => (e.preventDefault(), setPickedPack(p), setPicked(null), setAdding(false))}>
                        {p}
                      </button>{" "}
                      <span className="muted">({inPack.length})</span>
                      {rows.some((r) => r.pack === p && upstream[r.id]?.status === "newer") && <span className="tag amber">Newer version available</span>}
                    </summary>
                    <ul>{inPack.map(item)}</ul>
                  </details>
                </li>
              );
            })}
            {loose.map(item)}
          </ul>
        </nav>
        <div id="skill-view">
          {adding || (!picked && !pickedPack && rows.length === 0) ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <AddSkill
              companyId={company.id}
              onAdded={(names) => {
                setAdding(false);
                setAdded(names.join(", "));
                list.reload();
                // Several at once were a pack: open the pack, so it can be given in one go.
                void api<SkillRow[]>(`/api/companies/${company.id}/skills`).then((all) => {
                  const first = all.find((s) => s.name === names[0]);
                  if (names.length > 1 && first?.pack) setPickedPack(first.pack);
                  else setPicked(first?.id ?? null);
                });
              }}
            />
            <FromOtherCompany
              company={company}
              onAdded={(name) => {
                setAdded(name);
                list.reload();
              }}
            />
            </div>
          ) : pickedPack && packs.includes(pickedPack) ? (
            <PackView key={pickedPack} company={company} pack={pickedPack} rows={rows.filter((r) => r.pack === pickedPack)} onChanged={list.reload} onPick={pick} onClose={() => setPickedPack(null)} />
          ) : picked ? (
            <SkillView key={picked} company={company} id={picked} onChanged={list.reload} onClose={() => setPicked(null)} />
          ) : (
            <p className="muted card">Pick a skill or a pack on the left, or add one.</p>
          )}
        </div>
      </div>
    </>
  );
}
