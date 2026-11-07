// The company wiki (R69): Markdown pages the owner and agents share. Pages written for a
// ticket link back to it, and every save is kept, so an older version can be put back.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Menu as MenuIcon } from "lucide-react";
import { api, type Company } from "../api";
import { Markdown, headingId } from "../components/Markdown";
import { useMediaQuery, usePoll } from "../hooks";
import { away } from "../server-watch";
import { when } from "./Runs";
import { SaveButton, useSaveState } from "../components/SaveButton";

type PageRow = { id: string; slug: string; folder: string; title: string; ticketId: string | null; updatedAt: string; updatedBy: string | null };
type Revision = { id: string; createdAt: string; agent: string | null; runId: string | null; size?: number };
// revisionCount is every version, which can be more than the first page the page carries (BOS-496).
type PageDetail = { id: string; slug: string; folder: string; title: string; body: string; updatedAt: string; updatedBy: string | null; revisions: Revision[]; revisionCount?: number; tickets: Array<{ id: string; title: string }> };
type OldVersion = { id: string; title: string; body: string; createdAt: string; agent: string | null };

type Draft = { title: string; body: string; folder: string };

function Editor({ initial, folders, onSave, onCancel, saveLabel }: { initial: Draft; folders: string[]; onSave: (v: Draft) => Promise<void>; onCancel: () => void; saveLabel: string }) {
  const [title, setTitle] = useState(initial.title);
  const [folder, setFolder] = useState(initial.folder);
  const [body, setBody] = useState(initial.body);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    onSave({ title: title.trim(), body, folder }).catch((err: Error) => setError(err.message));
  };
  return (
    <form className="card wiki-editor" onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="field">
        <label htmlFor="wiki-title">Title</label>
        <input id="wiki-title" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="wiki-folder">Folder</label>
        <input id="wiki-folder" value={folder} maxLength={400} list="wiki-folders" placeholder="Top level. Use / for folders inside folders, e.g. Research/Competitors" onChange={(e) => setFolder(e.target.value)} />
        <datalist id="wiki-folders">
          {folders.map((f) => (
            <option key={f} value={f} />
          ))}
        </datalist>
      </div>
      <div style={{ display: "flex", gap: 8 }} role="group" aria-label="Editor view">
        <button type="button" className={`btn${preview ? "" : " primary"}`} aria-pressed={!preview} onClick={() => setPreview(false)}>
          Write
        </button>
        <button type="button" className={`btn${preview ? " primary" : ""}`} aria-pressed={preview} onClick={() => setPreview(true)}>
          Preview
        </button>
      </div>
      {preview ? (
        <Markdown text={body || "_Nothing yet._"} />
      ) : (
        <>
          <label htmlFor="wiki-body" className="sr-only">
            Page text, in Markdown
          </label>
          <textarea id="wiki-body" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write in Markdown: # headings, - lists, | tables |, **bold**, [links](#/tickets/…)." />
        </>
      )}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="submit" className="btn primary" disabled={!title.trim()}>
          {saveLabel}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
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

/** An address whose page doesn't exist: say so plainly and offer a search, rather than an empty wiki (BOS-356). */
function NotFound({ companyId, slug, go }: { companyId: string; slug: string; go: (to: string) => void }) {
  const [q, setQ] = useState("");
  const hits = usePoll(
    (signal) => (q.trim() ? api<PageRow[]>(`/api/companies/${companyId}/wiki?q=${encodeURIComponent(q.trim())}`, { signal }) : Promise.resolve([])),
    30_000,
    `not-found/${companyId}/${q}`,
  );
  const found = hits.data ?? [];
  const name = decodeURIComponent(slug) || slug;
  return (
    <article className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 style={{ fontSize: 22, fontWeight: 600 }}>Page not found</h2>
      <p className="muted">
        There's no wiki page at <code>{name}</code>. It may have been deleted or renamed, or the link may be from another company.
      </p>
      <div className="field">
        <label htmlFor="wiki-missing-q">Search the wiki</label>
        <input id="wiki-missing-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Titles and text" />
      </div>
      {q.trim() ? (
        found.length ? (
          <ul>
            {found.map((p) => (
              <li key={p.id} style={{ fontSize: 14 }}>
                <a href={`#/wiki/${companyId}/${p.slug}`}>{p.title}</a> <small className="muted">{p.slug}</small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No page matches "{q.trim()}".</p>
        )
      ) : (
        <p>
          <a href={`#/wiki/${companyId}`} onClick={() => go(`wiki/${companyId}`)}>
            See all pages
          </a>
        </p>
      )}
    </article>
  );
}

function PageView({ companyId, slug, section, folders, go, onChanged, onNewHere }: { companyId: string; slug: string; section?: string; folders: string[]; go: (to: string) => void; onChanged: () => void; onNewHere: (folder: string) => void }) {
  const page = usePoll((signal) => api<PageDetail>(`/api/companies/${companyId}/wiki/${slug}`, { signal }), 30_000, `${companyId}/${slug}`);
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  // Versions opened from "Show older versions", older than the first page the page carries (BOS-496).
  const [older, setOlder] = useState<{ rows: Revision[]; busy: boolean; error: string | null }>({ rows: [], busy: false, error: null });
  const [old, setOld] = useState<OldVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => (setEditing(false), setHistory(false), setOlder({ rows: [], busy: false, error: null }), setOld(null)), [slug]);
  const p = page.data;
  const versions = [...(p?.revisions ?? []), ...older.rows];
  const hasMore = !!p && versions.length < (p.revisionCount ?? p.revisions.length);
  const showMore = async () => {
    if (!p) return;
    setOlder((o) => ({ ...o, busy: true, error: null }));
    try {
      const rows = await api<Revision[]>(`/api/companies/${companyId}/wiki/${slug}?versions=1&offset=${versions.length}`);
      // Drop any overlap, so a save made while paging can't list a version twice.
      setOlder((o) => ({ rows: [...o.rows, ...rows.filter((r) => !p.revisions.some((x) => x.id === r.id) && !o.rows.some((x) => x.id === r.id))], busy: false, error: null }));
    } catch (err) {
      setOlder((o) => ({ ...o, busy: false, error: (err as Error).message }));
    }
  };
  // A link can name a section (slug#Heading); land on that heading once the page has rendered.
  useEffect(() => {
    if (!p || !section) return;
    const wanted = headingId(section);
    const heading = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].find((h) => h.id === wanted || h.textContent?.trim().toLowerCase() === section.trim().toLowerCase());
    heading?.scrollIntoView({ block: "start" });
  }, [p?.id, section]);

  const save = async (v: Draft) => {
    // The owner is replacing the page they just edited, so the agent shrink guard never blocks their own save.
    const saved = await api<{ slug: string }>(`/api/companies/${companyId}/wiki/${slug}`, { method: "PUT", body: { ...v, replace: true } });
    setEditing(false);
    setOld(null);
    onChanged();
    // Moving it to another folder changes its address.
    if (saved.slug !== slug) go(`wiki/${companyId}/${saved.slug}`);
    else page.reload();
  };
  const remove = async () => {
    if (!p || !window.confirm(`Delete "${p.title}" and its history? This can't be undone.`)) return;
    try {
      await api(`/api/companies/${companyId}/wiki/${slug}`, { method: "DELETE" });
      onChanged();
      go(`wiki/${companyId}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  // A version that fails to open says so, instead of the click looking dead (BOS-430).
  const showOld = async (id: string) => {
    setError(null);
    try {
      setOld(await api<OldVersion>(`/api/companies/${companyId}/wiki-revisions/${id}`));
    } catch {
      setError("Couldn't open that version. Try again; nothing on the page has changed.");
    }
  };
  // Putting a version back goes through restore, so the old text comes back even if it looks like a shrink,
  // and the restore is a new version of its own that can be undone (BOS-430).
  const restoreOld = async (revisionId: string) => {
    setError(null);
    try {
      await api(`/api/companies/${companyId}/wiki-restore`, { method: "POST", body: { slug, revisionId } });
      setOld(null);
      setHistory(true);
      onChanged();
      page.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (page.error) return page.error.status === 404 ? <NotFound companyId={companyId} slug={slug} go={go} /> : away(page.error) ? null : <p className="error" role="alert">{page.error.message}</p>;
  if (!p) return null;
  if (editing) return <Editor initial={{ title: p.title, body: p.body, folder: p.folder }} folders={folders} onSave={save} onCancel={() => setEditing(false)} saveLabel="Save page" />;
  return (
    <article className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          {p.folder && (
            <p className="label" aria-label="Folder">
              {p.folder.split("/").join(" / ")}
            </p>
          )}
          <h2 style={{ fontSize: 22, fontWeight: 600 }}>{p.title}</h2>
          <p className="muted" style={{ fontSize: 13 }}>
            Changed {when(p.updatedAt)} by {p.updatedBy ?? "you"}
            {p.tickets.length > 0 && (
              <>
                {" · for "}
                {p.tickets.map((t, i) => (
                  <span key={t.id}>
                    {i > 0 && ", "}
                    <a href={`#/tickets/${t.id}`}>{t.title}</a>
                  </span>
                ))}
              </>
            )}
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" className="btn" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button type="button" className="btn" onClick={() => onNewHere(p.folder)}>
            New page here
          </button>
          <button type="button" className="btn" aria-expanded={history} onClick={() => setHistory((h) => !h)}>
            History ({p.revisionCount ?? p.revisions.length})
          </button>
          <button type="button" className="btn" onClick={() => void remove()}>
            Delete
          </button>
        </div>
      </header>
      {history && (
        <section aria-label="History" style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          <ul style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {versions.map((r, i) => (
              <li key={r.id} style={{ fontSize: 14 }}>
                <button type="button" className="link" onClick={() => void showOld(r.id)}>
                  {when(r.createdAt)}
                </button>{" "}
                by {r.agent ?? "you"}
                {typeof r.size === "number" && <span className="muted"> · {r.size.toLocaleString("en-GB")} characters</span>}
                {i === 0 && " (current)"}
                {r.runId && (
                  <>
                    {" · "}
                    <a href={`#/runs/${r.runId}`}>run</a>
                  </>
                )}
              </li>
            ))}
          </ul>
          {/* Every save is kept, so the oldest is always reachable: page further back to find it (BOS-496). */}
          {hasMore && (
            <button type="button" className="btn" disabled={older.busy} onClick={() => void showMore()}>
              {older.busy ? "Loading…" : `Show older versions (${(p.revisionCount ?? versions.length) - versions.length} more)`}
            </button>
          )}
          {older.error && (
            <p className="error" role="alert">
              {older.error}
            </p>
          )}
        </section>
      )}
      {old && (
        <div className="banner" role="status" style={{ flexWrap: "wrap" }}>
          <span>
            You're looking at the version from {when(old.createdAt)} by {old.agent ?? "you"}.
          </span>
          <button type="button" className="btn primary" onClick={() => void restoreOld(old.id)}>
            Put this version back
          </button>
          <button type="button" className="btn" onClick={() => setOld(null)}>
            Back to the current one
          </button>
        </div>
      )}
      <Markdown text={(old ?? p).body} linkContext={{ companyId }} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

/** Not a stored page: the server builds it when asked (R84). "~" can't appear in a page address. */
const BRIEF = "~brief";

type Semantic = { enabled: boolean; baseUrl: string; model: string; dims: number; secretId: string | null; status?: { pages: number; indexed: number; lastError: { message: string; at: string } | null } };

/** Semantic search: off by default. The key is a secret from the encrypted store. */
function SemanticSettings({ companyId }: { companyId: string }) {
  // Polled while open, so the indexed count moves as pages are embedded in the background.
  const cur = usePoll((signal) => api<Semantic>(`/api/companies/${companyId}/wiki-semantic`, { signal }), 15_000, `sem-${companyId}`);
  const secrets = usePoll((signal) => api<Array<{ id: string; name: string }>>("/api/secrets", { signal }), 600_000, "secrets");
  const [v, setV] = useState<Semantic | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const sv = useSaveState(v);
  // Only the first load fills the form, so a background refresh never overwrites an edit in progress.
  useEffect(() => {
    if (!cur.data || v) return;
    setV(cur.data);
    sv.reset(cur.data);
  }, [cur.data]);
  const status = cur.data?.status;
  const [busy, setBusy] = useState(false);
  if (!v) return null;
  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    api(`/api/companies/${companyId}/wiki-semantic`, { method: "PUT", body: { enabled: v.enabled, baseUrl: v.baseUrl, model: v.model, secretId: v.secretId } })
      .then(
        () => (sv.markSaved(), setMsg(v.enabled ? "Saved. Pages are being embedded in the background." : "Saved.")),
        (err: Error) => setMsg(err.message),
      )
      .finally(() => setBusy(false));
  };
  return (
    <details className="card">
      <summary>Semantic search</summary>
      <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <p className="muted">Wiki text is sent to the provider below to be embedded, and so are search words. Full-text search keeps working if it fails.</p>
        <label>
          <input type="checkbox" checked={v.enabled} onChange={(e) => setV({ ...v, enabled: e.target.checked })} /> Search by meaning as well as words
        </label>
        <div className="field">
          <label htmlFor="sem-url">Provider address</label>
          <input id="sem-url" value={v.baseUrl} onChange={(e) => setV({ ...v, baseUrl: e.target.value })} />
          <small className="muted">Any OpenAI-compatible /embeddings service. Google's own: https://generativelanguage.googleapis.com/v1beta/openai (model gemini-embedding-001).</small>
        </div>
        <div className="field">
          <label htmlFor="sem-model">Model (768 dimensions)</label>
          <input id="sem-model" value={v.model} onChange={(e) => setV({ ...v, model: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="sem-key">API key</label>
          <select id="sem-key" value={v.secretId ?? ""} onChange={(e) => setV({ ...v, secretId: e.target.value || null })}>
            <option value="">None</option>
            {(secrets.data ?? []).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {!v.secretId && <small className="muted">Add the key under Secrets first, then pick it here.</small>}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <SaveButton {...sv} busy={busy} />
          <button type="button" className="btn" onClick={() => api(`/api/companies/${companyId}/wiki-semantic/reindex`, { method: "POST" }).then(() => setMsg("Re-embedding all pages."), (err: Error) => setMsg(err.message))}>
            Re-embed all
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              api<{ ok: boolean; message: string }>(`/api/companies/${companyId}/wiki-semantic/test`, { method: "POST" }).then(
                (r) => (setMsg(r.message), cur.reload()),
                (err: Error) => setMsg(err.message),
              )
            }
          >
            Test
          </button>
        </div>
        {msg && <p role="status">{msg}</p>}
        {cur.data?.enabled && status && (
          <p className={status.lastError ? "error" : "muted"} style={{ fontSize: 14 }}>
            {status.indexed} of {status.pages} pages indexed.
            {status.lastError ? ` Last error (${new Date(status.lastError.at).toLocaleString()}): ${status.lastError.message}. Full-text search is still working.` : status.indexed < status.pages ? " The rest are being embedded." : " Up to date."}
          </p>
        )}
      </form>
    </details>
  );
}

function BriefView({ companyId }: { companyId: string }) {
  const brief = usePoll((signal) => api<{ markdown: string }>(`/api/companies/${companyId}/brief`, { signal }), 30_000, companyId);
  if (brief.error && !away(brief.error)) return <p className="error" role="alert">{brief.error.message}</p>;
  if (!brief.data) return null;
  return (
    <article className="card" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 style={{ fontSize: 22, fontWeight: 600 }}>Company brief</h2>
      <Markdown text={brief.data.markdown} linkContext={{ companyId }} />
    </article>
  );
}

type Folder = { key: string; name: string; path: string; folders: Folder[]; pages: PageRow[] };

/** Pages arranged by folder; folders that differ only in case are one folder. */
function tree(pages: PageRow[]): Folder {
  const root: Folder = { key: "", name: "", path: "", folders: [], pages: [] };
  for (const p of pages) {
    let at = root;
    for (const part of p.folder ? p.folder.split("/") : []) {
      const key = `${at.key}/${part.toLowerCase()}`;
      let next = at.folders.find((f) => f.key === key);
      if (!next) at.folders.push((next = { key, name: part, path: at.path ? `${at.path}/${part}` : part, folders: [], pages: [] }));
      at = next;
    }
    at.pages.push(p);
  }
  const sort = (f: Folder) => {
    f.folders.sort((a, b) => a.name.localeCompare(b.name));
    f.pages.sort((a, b) => a.title.localeCompare(b.title));
    f.folders.forEach(sort);
  };
  sort(root);
  return root;
}

const countPages = (f: Folder): number => f.pages.length + f.folders.reduce((n, x) => n + countPages(x), 0);

/** The folders the reader has opened or closed by hand; until they do, open ones are picked for them. */
type OpenFolders = Record<string, boolean>;

/** Which folders are open. A folder the reader has touched keeps their choice; the rest open when the page in them is open. */
function folderOpen(over: OpenFolders, key: string, currentFolder: string): boolean {
  return over[key] ?? `${currentFolder}/`.startsWith(`${key.slice(1)}/`);
}

function TreeList({ folder, companyId, current, currentFolder, openAll, over, onToggle, onPick }: { folder: Folder; companyId: string; current: string | undefined; currentFolder: string; openAll: boolean; over: OpenFolders; onToggle: (key: string, open: boolean) => void; onPick: () => void }) {
  return (
    <ul>
      {folder.folders.map((f) => (
        <li key={f.key}>
          <details
            open={openAll || folderOpen(over, f.key, currentFolder) || undefined}
            onToggle={(e) => {
              const open = (e.target as HTMLDetailsElement).open;
              if (open !== folderOpen(over, f.key, currentFolder)) onToggle(f.key, open);
            }}
          >
            <summary>
              {f.name} <span className="muted">({countPages(f)})</span>
            </summary>
            <TreeList folder={f} companyId={companyId} current={current} currentFolder={currentFolder} openAll={openAll} over={over} onToggle={onToggle} onPick={onPick} />
          </details>
        </li>
      ))}
      {folder.pages.map((p) => (
        <li key={p.id}>
          <a href={`#/wiki/${companyId}/${p.slug}`} aria-current={p.slug === current ? "page" : undefined} onClick={onPick} title={p.title}>
            <span className="t">{p.title}</span>
            <small>
              {when(p.updatedAt)} · {p.updatedBy ?? "you"}
            </small>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function Wiki({ companies, companyId, slug, go }: { companies: Company[]; companyId: string | undefined; slug: string | undefined; go: (to: string) => void }) {
  // A link can arrive as slug#Heading; the page is the slug, and the rest is the section to land on.
  const hashAt = slug?.indexOf("#") ?? -1;
  const pageSlug = hashAt >= 0 ? slug!.slice(0, hashAt) : slug;
  const rawSection = hashAt >= 0 ? slug!.slice(hashAt + 1) : undefined;
  const section = rawSection
    ? (() => {
        try {
          return decodeURIComponent(rawSection);
        } catch {
          return rawSection;
        }
      })()
    : undefined;
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  const [q, setQ] = useState("");
  // The page list is a drawer below 1180px, the same mark the rest of the app calls a tablet or folded phone.
  const narrow = useMediaQuery("(max-width: 1180px)");
  const [drawer, setDrawer] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // Folders the reader has opened or closed by hand, so the drawer reopens with the same ones open.
  const [over, setOver] = useState<OpenFolders>({});
  // The folder a new page starts in, or null when no page is being created.
  const [creating, setCreating] = useState<string | null>(null);
  const closeDrawer = () => setDrawer(false);
  const onToggleFolder = (key: string, open: boolean) => setOver((o) => ({ ...o, [key]: open }));
  useEffect(() => {
    if (!narrow) setDrawer(false);
  }, [narrow]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setDrawer(false);
      toggleRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);
  const list = usePoll(
    (signal) => (company ? api<PageRow[]>(`/api/companies/${company.id}/wiki${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ""}`, { signal }) : Promise.resolve([])),
    30_000,
    `${company?.id ?? "none"}/${q}`,
  );
  const pages = list.data ?? [];
  const folders = [...new Set(pages.map((p) => p.folder).filter(Boolean))].sort();
  const create = async (v: Draft) => {
    const p = await api<{ slug: string }>(`/api/companies/${company!.id}/wiki`, { method: "POST", body: v });
    setCreating(null);
    list.reload();
    go(`wiki/${company!.id}/${p.slug}`);
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Wiki</h1>
          <p className="sub">The company's shared pages: research, specs, how-tos. Agents write here too, and a page written for a task shows on that task.</p>
        </div>
      </header>
      {company?.agents.some((a) => a.duty === "wiki" && a.paused) && (
        <p className="banner" role="status">
          <span>
            The Wiki Maintainer is paused. To have it file finished work and keep an Index page, choose its model and press Start in <a href={`#/settings/${company.id}`}>Settings</a>.
          </span>
        </p>
      )}
      {!company ? (
        <p>Create a company on the Kanban first.</p>
      ) : (
        <div className="wiki">
          {narrow && (
            <button ref={toggleRef} type="button" className="btn wiki-menu-toggle" aria-expanded={drawer} aria-controls="wiki-pages" aria-label={drawer ? "Hide pages" : "Show pages"} onClick={() => setDrawer((d) => !d)}>
              <MenuIcon size={18} strokeWidth={2} aria-hidden="true" />
              <span>{drawer ? "Hide pages" : "Show pages"}</span>
            </button>
          )}
          {narrow && drawer && <div className="wiki-scrim" onClick={closeDrawer} aria-hidden="true" />}
          <nav
            ref={drawerRef}
            id="wiki-pages"
            className={`card wiki-list${narrow ? " wiki-drawer" : ""}${narrow && drawer ? " open" : ""}`}
            aria-label="Pages"
            aria-hidden={narrow && !drawer ? true : undefined}
            onClick={(e) => {
              // Picking a page closes the drawer; so does starting a new one.
              if (!narrow || !(e.target as HTMLElement).closest("a")) return;
              setDrawer(false);
            }}
          >
            <button type="button" className="btn primary" onClick={() => (setCreating(""), closeDrawer())}>
              New page
            </button>
            <div className="field">
              <label htmlFor="wiki-q">Search</label>
              <input id="wiki-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Titles and text" />
            </div>
            {!q.trim() && (
              <ul>
                <li>
                  <a href={`#/wiki/${company.id}/${BRIEF}`} aria-current={pageSlug === BRIEF && creating === null ? "page" : undefined} onClick={() => (setCreating(null), closeDrawer())}>
                    Company brief
                    <small>read-only, as of now</small>
                  </a>
                </li>
              </ul>
            )}
            {list.data && pages.length === 0 && <p className="muted">{q.trim() ? "No page matches." : "No pages yet."}</p>}
            <SemanticSettings companyId={company.id} />
            <TreeList
              folder={tree(pages)}
              companyId={company.id}
              current={creating === null ? pageSlug : undefined}
              currentFolder={(creating ?? pages.find((p) => p.slug === pageSlug)?.folder ?? "").toLowerCase()}
              openAll={!!q.trim()}
              over={over}
              onToggle={onToggleFolder}
              onPick={() => (setCreating(null), closeDrawer())}
            />
          </nav>
          <div>
            {creating !== null ? (
              <Editor key={creating} initial={{ title: "", body: "", folder: creating }} folders={folders} onSave={create} onCancel={() => setCreating(null)} saveLabel="Create page" />
            ) : pageSlug === BRIEF ? (
              <BriefView companyId={company.id} />
            ) : pageSlug ? (
              <PageView companyId={company.id} slug={pageSlug} section={section} folders={folders} go={go} onChanged={list.reload} onNewHere={setCreating} />
            ) : (
              <p className="muted card">{pages.length ? "Pick a page on the left." : "Start a page with New page, or ask an agent to write one."}</p>
            )}
          </div>
        </div>
      )}
    </>
  );
}
