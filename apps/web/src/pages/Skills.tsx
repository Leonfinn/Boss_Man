// Skills (R71): the company's library of Agent Skills, and who has each. A skill is added from
// a GitHub link (pinned to a commit), written here, or uploaded as a folder, files or a zip.
import { RUNNER_ADDONS } from "@boss-man/shared";
import { useState, type ChangeEvent, type FormEvent } from "react";
import { unzipSync } from "fflate";
import { api, type Company } from "../api";
import { Markdown } from "../components/Markdown";
import { usePoll } from "../hooks";
import { when } from "./Runs";
import { SaveButton } from "../components/SaveButton";

type SkillRow = { id: string; name: string; description: string; source: "written" | "link" | "upload"; sourceUrl: string | null; sourceRef: string | null; pack: string | null; packUrl: string | null; sizeBytes: number; fileCount: number; updatedAt: string; agents: Array<{ id: string; name: string }> };
type SkillDetail = Omit<SkillRow, "fileCount"> & { files: Array<{ path: string; size: number; text: string | null }>; requiresAddons: string[] | null };
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
          <small className="muted">Every skill under the link is added, pinned to the commit it points at now; several from one link become a pack you can give in one go. Public repositories only for now; a link straight to a SKILL.md file anywhere also works.</small>
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
  const [savedHolders, setSavedHolders] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ name: string; description: string; body: string } | null>(null);
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
  // Only a skill that is just its SKILL.md can be edited here; a linked one follows its source.
  const editable = s.source !== "link" && s.files.length === 1;
  const save = () =>
    void run(async () => {
      await api(`/api/companies/${company.id}/skills/${id}`, { method: "PUT", body: editing });
      setEditing(null);
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
            <button type="button" className="btn" onClick={() => setEditing({ name: s.name, description: s.description, body: stripFrontmatter(md).trim() })}>
              Edit
            </button>
          )}
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
        {(holders || savedHolders) && (
          <SaveButton dirty={!!holders} saved={savedHolders} style={{ marginTop: 10 }} onClick={() => void run(async () => (await api(`/api/companies/${company.id}/skills/${id}/agents`, { method: "PUT", body: { agentIds: holders } }), setHolders(null), setSavedHolders(true), "Saved. Agents get it from their next run."))} />
        )}
        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          The CEO can also give and take skills; you're told when it does. Skills load for Claude agents.
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
          A skill that needs an add-on is left out of runs while the runner doesn't have it working, and you're told once. See Settings → Runner.
        </p>
      </fieldset>

      {note && (
        <p className={note.ok ? "muted" : "error"} role={note.ok ? "status" : "alert"}>
          {note.text}
        </p>
      )}

      {editing ? (
        <section aria-label="Edit skill" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
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
            <textarea id="edit-skill-body" rows={18} value={editing.body} onChange={(e) => setEditing({ ...editing, body: e.target.value })} style={{ padding: "8px 12px", border: "1px solid var(--line-strong)", borderRadius: 8, font: "inherit" }} />
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="btn primary" disabled={!editing.name.trim() || !editing.description.trim()} onClick={save}>
              Save
            </button>
            <button type="button" className="btn" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </section>
      ) : (
        <section aria-label="SKILL.md">
          <Markdown text={stripFrontmatter(md)} />
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
                const r = await api<{ changed: number; added: string[]; gone: string[] }>(`/api/companies/${company.id}/skill-packs/refresh`, { method: "POST", body: { pack } });
                const parts = [r.changed ? `${r.changed} updated` : null, r.added.length ? `added ${r.added.join(", ")}` : null, r.gone.length ? `no longer in the link: ${r.gone.join(", ")}` : null].filter(Boolean);
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

export function Skills({ company }: { company: Company | undefined }) {
  const list = usePoll((signal) => (company ? api<SkillRow[]>(`/api/companies/${company.id}/skills`, { signal }) : Promise.resolve([])), 30_000, company?.id ?? "none");
  const [picked, setPicked] = useState<string | null>(null);
  const [pickedPack, setPickedPack] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  if (!company) return <p>Create a company on the Kanban first.</p>;
  const rows = list.data ?? [];
  const packs = [...new Set(rows.map((r) => r.pack).filter((p): p is string => !!p))].sort();
  const loose = rows.filter((r) => !r.pack);
  const pick = (id: string) => (setPicked(id), setPickedPack(null), setAdding(false));
  const item = (s: SkillRow) => (
    <li key={s.id}>
      <a href="#/skills" aria-current={s.id === picked && !adding ? "page" : undefined} onClick={(e) => (e.preventDefault(), pick(s.id))}>
        <span className="mono">{s.name}</span>
        <small>
          {SOURCE[s.source]} · {s.agents.length ? s.agents.map((a) => a.name).join(", ") : "nobody yet"}
        </small>
      </a>
    </li>
  );
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
            {packs.map((p) => {
              const inPack = rows.filter((r) => r.pack === p);
              return (
                <li key={`pack:${p}`}>
                  <details open={inPack.some((r) => r.id === picked) || undefined}>
                    <summary>
                      <button type="button" className="link mono" aria-current={pickedPack === p && !adding ? "page" : undefined} onClick={(e) => (e.preventDefault(), setPickedPack(p), setPicked(null), setAdding(false))}>
                        {p}
                      </button>{" "}
                      <span className="muted">({inPack.length})</span>
                    </summary>
                    <ul>{inPack.map(item)}</ul>
                  </details>
                </li>
              );
            })}
            {loose.map(item)}
          </ul>
        </nav>
        <div>
          {adding || (!picked && !pickedPack && rows.length === 0) ? (
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
