// Skills (R71): the company's library of Agent Skills, and who has each. A skill is added from
// a GitHub link (pinned to a commit), written here, or uploaded as a folder, files or a zip.
import { useState, type ChangeEvent, type FormEvent } from "react";
import { unzipSync } from "fflate";
import { api, type Company } from "../api";
import { Markdown } from "../components/Markdown";
import { usePoll } from "../hooks";
import { when } from "./Runs";

type SkillRow = { id: string; name: string; description: string; source: "written" | "link" | "upload"; sourceUrl: string | null; sourceRef: string | null; sizeBytes: number; fileCount: number; updatedAt: string; agents: Array<{ id: string; name: string }> };
type SkillDetail = Omit<SkillRow, "fileCount"> & { files: Array<{ path: string; size: number; text: string | null }> };
type Upload = { path: string; content: string };

const SOURCE: Record<SkillRow["source"], string> = { link: "From a link", written: "Written here", upload: "Uploaded" };
const kb = (n: number) => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`);
const stripFrontmatter = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");

function toBase64(bytes: Uint8Array) {
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
          <small className="muted">Every skill under the link is added, pinned to the commit it points at now. Public repositories only for now; a link straight to a SKILL.md file anywhere also works.</small>
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
            <textarea id="skill-body" rows={10} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} style={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit" }} />
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

function SkillView({ company, id, onChanged, onClose }: { company: Company; id: string; onChanged: () => void; onClose: () => void }) {
  const skill = usePoll((signal) => api<SkillDetail>(`/api/companies/${company.id}/skills/${id}`, { signal }), 60_000, id);
  const [holders, setHolders] = useState<string[] | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const s = skill.data;
  if (skill.error) return <p className="error" role="alert">{skill.error.message}</p>;
  if (!s) return null;
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
  const md = s.files.find((f) => f.path === "SKILL.md")?.text ?? "";
  return (
    <article className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }} aria-labelledby="skill-h">
      <header style={{ display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h2 id="skill-h" className="mono" style={{ fontSize: 20, fontWeight: 600 }}>
            {s.name}
          </h2>
          <p>{s.description}</p>
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
          {s.source === "link" && (
            <button type="button" className="btn" onClick={() => void run(async () => ((await api<{ changed: boolean }>(`/api/companies/${company.id}/skills/${id}/refresh`, { method: "POST" })).changed ? "Updated to the latest commit." : "Already up to date."))}>
              Check for updates
            </button>
          )}
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
            </label>
          ))}
        </div>
        {holders && (
          <button type="button" className="btn primary" style={{ marginTop: 10 }} onClick={() => void run(async () => (await api(`/api/companies/${company.id}/skills/${id}/agents`, { method: "PUT", body: { agentIds: holders } }), setHolders(null), "Saved. Agents get it from their next run."))}>
            Save
          </button>
        )}
        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          The CEO can also give and take skills; you're told when it does. Skills load for Claude agents.
        </p>
      </fieldset>

      {note && (
        <p className={note.ok ? "muted" : "error"} role={note.ok ? "status" : "alert"}>
          {note.text}
        </p>
      )}

      <section aria-label="SKILL.md">
        <Markdown text={stripFrontmatter(md)} />
      </section>
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
                  <small className="muted">{f.text === null ? `binary, ${kb(f.size)}` : kb(f.size)}</small>
                </span>
                {open === f.path && f.text !== null && <pre className="skill-file">{f.text}</pre>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}

export function Skills({ company }: { company: Company | undefined }) {
  const list = usePoll((signal) => (company ? api<SkillRow[]>(`/api/companies/${company.id}/skills`, { signal }) : Promise.resolve([])), 30_000, company?.id ?? "none");
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  if (!company) return <p>Create a company on the Kanban first.</p>;
  const rows = list.data ?? [];
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">{company.name}</p>
          <h1>Skills</h1>
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
      <div className="wiki">
        <nav className="card wiki-list" aria-label="Skills">
          {list.data && rows.length === 0 && <p className="muted">No skills yet.</p>}
          <ul>
            {rows.map((s) => (
              <li key={s.id}>
                <a href="#/skills" aria-current={s.id === picked && !adding ? "page" : undefined} onClick={(e) => (e.preventDefault(), setPicked(s.id), setAdding(false))}>
                  <span className="mono">{s.name}</span>
                  <small>
                    {SOURCE[s.source]} · {s.agents.length ? s.agents.map((a) => a.name).join(", ") : "nobody yet"}
                  </small>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div>
          {adding || (!picked && rows.length === 0) ? (
            <AddSkill
              companyId={company.id}
              onAdded={(names) => {
                setAdding(false);
                setAdded(names.join(", "));
                list.reload();
                void api<SkillRow[]>(`/api/companies/${company.id}/skills`).then((all) => setPicked(all.find((s) => s.name === names[0])?.id ?? null));
              }}
            />
          ) : picked ? (
            <SkillView key={picked} company={company} id={picked} onChanged={list.reload} onClose={() => setPicked(null)} />
          ) : (
            <p className="muted card">Pick a skill on the left, or add one.</p>
          )}
        </div>
      </div>
    </>
  );
}
