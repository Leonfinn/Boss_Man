import { useEffect, useRef, useState, type FormEvent } from "react";
import { NoCompany } from "../components/NoCompany";
import { figureText } from "@boss-man/shared";
import { api, FEATURE_STATUS_LABEL, IMPORTANCE_LABEL, IMPORTANCES, type Company, type Feature, type FeedbackSettingsView, type Importance, type NoteDetail, type NoteSummary, type ScoredFeatures } from "../api";
import { copyMessage, copyText } from "../clipboard";
import { usePoll } from "../hooks";
import { away } from "../server-watch";
import { when } from "./Runs";
import { NotFoundBlock } from "../components/NotFoundBlock";
import { STATUS_TONE } from "./Features";
import { SaveButton, useSaveState } from "../components/SaveButton";
import { clearDraft } from "../drafts";
import { defaultLinkAddress } from "../link-address";
import type { HostFactsView } from "../host-facts-display";
import { DraftTextarea } from "../components/DraftTextarea";

type State = "unprocessed" | "processed" | "archived";
const TABS: Array<{ id: State; label: string }> = [
  { id: "unprocessed", label: "Unprocessed" },
  { id: "processed", label: "Processed" },
  { id: "archived", label: "Archived" },
];
const SOURCE: Record<string, string> = { owner: "You", chat: "Chat", agent: "An agent", portal: "Portal", email: "Email", import: "Import" };

function AddNote({ companyId, onAdded }: { companyId: string; onAdded: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ text: "", title: "", name: "", email: "", segment: "", source: "owner" });
  // The feedback text is kept in this browser as it is typed (DR-045); it goes once the feedback is saved.
  const textKey = `feedback-new/${companyId}`;
  const [error, setError] = useState<string | null>(null);
  const customers = usePoll((signal) => (open ? api<Array<{ id: string; name: string }>>(`/api/companies/${companyId}/feedback-customers`, { signal }) : Promise.resolve([])), 60_000, `cust-${companyId}-${open}`);
  if (!open)
    return (
      <button type="button" className="btn primary" onClick={() => setOpen(true)}>
        Add feedback
      </button>
    );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void api<{ id: string }>(`/api/companies/${companyId}/feedback`, {
      method: "POST",
      body: {
        text: form.text.trim(),
        ...(form.title.trim() ? { title: form.title.trim() } : {}),
        source: form.source,
        ...(form.name.trim() ? { customer: { name: form.name.trim(), ...(form.email.trim() ? { email: form.email.trim() } : {}), ...(form.segment.trim() ? { segment: form.segment.trim() } : {}) } } : {}),
      },
    }).then(
      (n) => (setForm({ text: "", title: "", name: "", email: "", segment: "", source: "owner" }), clearDraft(textKey), setOpen(false), setError(null), onAdded(n.id)),
      (err: Error) => setError(err.message),
    );
  };
  return (
    <form className="card" onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-label="Add feedback">
      <div className="field">
        <label htmlFor="fb-text">Feedback, as they said it</label>
        <DraftTextarea draftKey={textKey} id="fb-text" rows={5} required maxLength={20_000} autoFocus value={form.text} onChange={(text) => setForm({ ...form, text })} placeholder="Paste an email, a message or your notes from a call." />
      </div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="fb-title">Title (optional)</label>
          <input id="fb-title" maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="fb-name">From (optional)</label>
          <input id="fb-name" list="fb-customers" maxLength={200} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="A person or a company" />
          <datalist id="fb-customers">
            {(customers.data ?? []).map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </div>
        <div className="field">
          <label htmlFor="fb-email">Their email (optional)</label>
          <input id="fb-email" type="email" maxLength={320} value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div className="field">
          <label htmlFor="fb-segment">Segment (optional)</label>
          <input id="fb-segment" maxLength={100} value={form.segment} onChange={(e) => setForm({ ...form, segment: e.target.value })} placeholder="e.g. Enterprise, Trial, Internal" />
        </div>
        <div className="field">
          <label htmlFor="fb-source">Came in by</label>
          <select id="fb-source" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
            <option value="owner">You</option>
            <option value="email">Email</option>
            <option value="import">Import</option>
          </select>
        </div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="btn primary" type="submit">
          Add to the inbox
        </button>
        <button className="btn" type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function ImportancePicker({ value, onChange, name }: { value: Importance; onChange: (v: Importance) => void; name: string }) {
  return (
    <div role="radiogroup" aria-label="How much it matters to them" className="chips">
      {IMPORTANCES.map((i) => (
        <label key={i} className={`chip ${value === i ? "on" : ""}`}>
          <input type="radio" className="visually-hidden" name={name} checked={value === i} onChange={() => onChange(i)} />
          {IMPORTANCE_LABEL[i]}
        </label>
      ))}
    </div>
  );
}

/** Pick (or create) a feature and link the selected passage to it. */
function LinkPanel({ companyId, noteId, highlight, features, onLinked, onClearHighlight }: { companyId: string; noteId: string; highlight: string; features: Feature[]; onLinked: () => void; onClearHighlight: () => void }) {
  const [q, setQ] = useState("");
  const [importance, setImportance] = useState<Importance>("important");
  const [error, setError] = useState<string | null>(null);
  const matches = q.trim() ? features.filter((f) => f.title.toLowerCase().includes(q.trim().toLowerCase())).slice(0, 8) : [];
  const link = async (featureId: string) => {
    try {
      await api(`/api/feedback/${noteId}/insights`, { method: "POST", body: { featureId, importance, ...(highlight ? { highlight } : {}) } });
      setQ("");
      setError(null);
      onClearHighlight();
      onLinked();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const create = async () => {
    try {
      const f = await api<Feature>(`/api/companies/${companyId}/features`, { method: "POST", body: { title: q.trim() } });
      await link(f.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <div className="link-panel">
      <p className="label">Link {highlight ? "the selected passage" : "this note"} to a feature</p>
      {highlight ? (
        <blockquote className="selected">
          {highlight}{" "}
          <button type="button" className="btn small" onClick={onClearHighlight}>
            Use the whole note
          </button>
        </blockquote>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>
          Tip: select a passage in the note first to link just that part.
        </p>
      )}
      <ImportancePicker value={importance} onChange={setImportance} name={`imp-${noteId}`} />
      <div className="field">
        <label htmlFor={`link-q-${noteId}`}>Feature</label>
        <input id={`link-q-${noteId}`} value={q} maxLength={200} onChange={(e) => setQ(e.target.value)} placeholder="Search features, or type a new one" autoComplete="off" />
      </div>
      {q.trim() && (
        <ul className="pick-list">
          {matches.map((f) => (
            <li key={f.id}>
              <button type="button" onClick={() => void link(f.id)}>
                <span>{f.title}</span>
                <span className={`tag ${STATUS_TONE[f.status]}`}>{FEATURE_STATUS_LABEL[f.status]}</span>
              </button>
            </li>
          ))}
          {!features.some((f) => f.title.toLowerCase() === q.trim().toLowerCase()) && (
            <li>
              <button type="button" onClick={() => void create()}>
                <span>
                  Create <b>{q.trim()}</b> and link it
                </span>
              </button>
            </li>
          )}
        </ul>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function NotePane({ id, companyId, features, onChanged, onClose }: { id: string; companyId: string; features: Feature[]; onChanged: () => void; onClose: () => void }) {
  const data = usePoll((signal) => api<NoteDetail>(`/api/feedback/${id}`, { signal }), 60_000, `note-${id}`);
  const [highlight, setHighlight] = useState("");
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLDivElement>(null);
  useEffect(() => setHighlight(""), [id]);
  // Remember a selection made inside the note's text.
  useEffect(() => {
    const on = () => {
      const sel = window.getSelection();
      const el = textRef.current;
      if (!sel || !el || sel.isCollapsed || !sel.anchorNode || !el.contains(sel.anchorNode) || !el.contains(sel.focusNode)) return;
      const text = sel.toString().trim();
      if (text) setHighlight(text.slice(0, 2000));
    };
    document.addEventListener("selectionchange", on);
    return () => document.removeEventListener("selectionchange", on);
  }, []);
  const reload = () => (data.reload(), onChanged());
  const act = (p: Promise<unknown>) => void p.then(() => (setError(null), reload()), (err: Error) => setError(err.message));
  if (data.error && !away(data.error)) return data.error.status === 404 ? <NotFoundBlock title="Note not found" backHref="#/feedback" backLabel="Back to Feedback">This note doesn't exist any more, or the link is wrong.</NotFoundBlock> : <p className="error">{data.error.message}</p>;
  const d = data.data;
  if (!d) return null;
  const n = d.note;
  return (
    <article className="card note-pane" aria-labelledby="note-h">
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 id="note-h" style={{ fontSize: 17, fontWeight: 600 }}>
            {n.title ?? (d.customer ? `From ${d.customer.name}` : "Feedback")}
          </h2>
          <p className="muted" style={{ fontSize: 13, display: "flex", gap: "2px 10px", flexWrap: "wrap" }}>
            {d.customer && (
              <span>
                {d.customer.name}
                {d.customer.segment ? ` · ${d.customer.segment}` : ""}
                {d.customer.email ? ` · ${d.customer.email}` : ""}
              </span>
            )}
            <span>{SOURCE[n.source] ?? n.source}</span>
            <span>{when(n.createdAt)}</span>
            {n.untrusted && <span className="tag">from outside</span>}
          </p>
        </div>
        <button type="button" className="btn small back-btn" onClick={onClose}>
          Back to the list
        </button>
      </div>
      <div ref={textRef} className="note-text">
        {n.text}
      </div>
      {d.insights.length > 0 && (
        <div>
          <p className="label">Linked to</p>
          <ul className="insight-list">
            {d.insights.map((i) => (
              <li key={i.id}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <a href={`#/features/${companyId}/${i.feature.id}`}>{i.feature.title}</a>
                  <select
                    className="mini"
                    aria-label={`How much ${i.feature.title} matters to them`}
                    value={i.importance}
                    onChange={(e) => act(api(`/api/feedback/${id}/insights`, { method: "POST", body: { featureId: i.feature.id, importance: e.target.value, highlight: i.highlight } }))}
                  >
                    {IMPORTANCES.map((x) => (
                      <option key={x} value={x}>
                        {IMPORTANCE_LABEL[x]}
                      </option>
                    ))}
                  </select>
                  <button type="button" className="btn small" style={{ marginLeft: "auto" }} onClick={() => act(api(`/api/insights/${i.id}`, { method: "DELETE" }))}>
                    Unlink
                  </button>
                </div>
                {i.highlight && <blockquote>{i.highlight}</blockquote>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {d.suggestions.length > 0 && (
        <div>
          <p className="label">May be about</p>
          <div className="chips">
            {d.suggestions.map((s) => (
              <button
                key={s.id}
                type="button"
                className="chip"
                title={`Shares: ${s.shared.join(", ")}`}
                onClick={() => act(api(`/api/feedback/${id}/insights`, { method: "POST", body: { featureId: s.id, importance: "important", ...(highlight ? { highlight } : {}) } }).then(() => setHighlight("")))}
              >
                Link to {s.title}
              </button>
            ))}
          </div>
        </div>
      )}
      <LinkPanel companyId={companyId} noteId={id} highlight={highlight} features={features} onLinked={reload} onClearHighlight={() => setHighlight("")} />
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {n.state === "unprocessed" ? (
          <button type="button" className="btn primary" onClick={() => act(api(`/api/feedback/${id}`, { method: "PATCH", body: { state: "processed" } }))}>
            Done: mark processed
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => act(api(`/api/feedback/${id}`, { method: "PATCH", body: { state: "unprocessed" } }))}>
            Back to unprocessed
          </button>
        )}
        {n.state !== "archived" && (
          <button type="button" className="btn" onClick={() => act(api(`/api/feedback/${id}`, { method: "PATCH", body: { state: "archived" } }))}>
            Archive
          </button>
        )}
        <button type="button" className="btn" onClick={() => window.confirm("Delete this feedback and its links?") && void api(`/api/feedback/${id}`, { method: "DELETE" }).then(() => (onChanged(), onClose()), (err: Error) => setError(err.message))}>
          Delete
        </button>
      </div>
      {error && <p className="error">{error}</p>}
    </article>
  );
}

/** The public portal: on or off, its words, and its secret link. */
function PortalSettings({ companyId, shown }: { companyId: string; shown: number }) {
  const s = usePoll((signal) => api<FeedbackSettingsView>(`/api/companies/${companyId}/feedback-settings`, { signal }), 60_000, `portal-${companyId}`);
  const [form, setForm] = useState<{ title: string; intro: string } | null>(null);
  // BOS-967: the optional way back to the owner's website, saved on its own so a bad address
  // blocks only that save. Blank means the portal shows no back link.
  const [back, setBack] = useState<{ url: string; text: string } | null>(null);
  const backProblem = back && back.url.trim() && !/^https:\/\/[^\s]+$/i.test(back.url.trim()) ? "Enter a full web address that starts with https://" : null;
  // The introduction is kept in this browser as it is typed (DR-045); it goes once the portal is saved.
  const introKey = `portal-intro/${companyId}`;
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const d = s.data;
  const hostFacts = usePoll((signal) => api<HostFactsView>("/api/host-facts", { signal }), 60_000, "host-facts-portal");
  const sv = useSaveState(form);
  const [busy, setBusy] = useState(false);
  const [backBusy, setBackBusy] = useState(false);
  const [logoV, setLogoV] = useState(0);
  useEffect(() => {
    if (d && !form) setForm({ title: d.portalTitle ?? "", intro: d.portalIntro ?? "" });
  }, [d, form]);
  useEffect(() => {
    if (d && !back) setBack({ url: d.portalBackUrl ?? "", text: d.portalBackText ?? "" });
  }, [d, back]);
  if (!d || !form || !back) return null;
  const run = (p: Promise<unknown>, ok?: string) => p.then(() => (setNote(ok ? { ok: true, text: ok } : null), s.reload()), (err: Error) => setNote({ ok: false, text: err.message }));
  const logoUrl = `/api/companies/${companyId}/feedback/portal-logo`;
  const pickLogo = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 256 * 1024) return setNote({ ok: false, text: "The logo must be 256 KB or smaller." });
    const r = new FileReader();
    r.onload = () => run(api(`${logoUrl}`, { method: "PUT", body: { data: String(r.result).split(",")[1] ?? "" } }).then(() => setLogoV((v) => v + 1)), "Logo saved.");
    r.readAsDataURL(file);
  };
  // BOS-1603: with no portal address set, never fall back to the owner's own browser address: clients may not reach it.
  const guess = d.portalUrl ? null : defaultLinkAddress({ origin: window.location.origin, facts: hostFacts.data?.facts, who: "clients" });
  const base = d.portalUrl ?? guess?.url ?? "";
  const link = d.portalToken && base ? `${base}/portal.html#${d.portalToken}` : null;
  return (
    <section className="card" aria-labelledby="portal-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 id="portal-h" style={{ fontSize: 17, fontWeight: 600 }}>
        Feedback portal
      </h2>
      <p className="muted" style={{ fontSize: 14 }}>
        A page for people outside: they see the features on the portal (new features go on by default unless they look like security work), vote on how much each matters to them, comment, and suggest ideas. What they send arrives here marked "from outside". Anyone with the link can use it, so share it only where you mean to.
      </p>
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
        <input type="checkbox" checked={d.portalEnabled} onChange={(e) => run(api(`/api/companies/${companyId}/portal`, { method: "PATCH", body: { enabled: e.target.checked } }))} />
        Portal on ({shown} feature{shown === 1 ? "" : "s"} shown)
      </label>
      {d.portalEnabled && link && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input className="search mono" readOnly aria-label="Portal link" value={link} onFocus={(e) => e.currentTarget.select()} style={{ fontSize: 12 }} />
          <button type="button" className="btn small" onClick={() => void copyText(link).then((ok) => setNote({ ok, text: copyMessage(ok, "Link") }))}>
            Copy
          </button>
          <a className="btn small" href={link} target="_blank" rel="noopener noreferrer">
            Open
          </a>
          <button type="button" className="btn small" onClick={() => window.confirm("Make a new link? The old one stops working at once.") && run(api(`/api/companies/${companyId}/portal/rotate`, { method: "POST" }), "New link made; the old one no longer works.")}>
            New link
          </button>
        </div>
      )}
      {d.portalEnabled && d.portalToken && !link && (
        <p className="error" style={{ fontSize: 14 }} data-testid="portal-no-address">
          {guess?.note} Set BOSSMAN_PORTAL_URL (see the install guide) to the address your clients open; the link appears here once it is set.
        </p>
      )}
      {d.portalEnabled && link && (
        <p className="muted" style={{ fontSize: 13 }} data-testid="portal-address-note">
          {guess ? `${guess.note} ` : "This link uses the portal address set in BOSSMAN_PORTAL_URL. "}If you serve the portal on its own port (BOSSMAN_PORTAL_PORT, see the install guide), swap in that address and keep everything after "#".
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setBusy(true);
          run(
            api(`/api/companies/${companyId}/portal`, { method: "PATCH", body: { title: form.title.trim() || null, intro: form.intro.trim() || null } }).then(() => { sv.markSaved(); clearDraft(introKey); }).finally(() => setBusy(false)),
            "Saved.",
          );
        }}
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        <div className="field">
          <label htmlFor="portal-title">Heading</label>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            {d.hasLogo && <img src={`${logoUrl}?v=${logoV}`} alt="Current portal logo" style={{ maxHeight: 32, maxWidth: 96 }} />}
            <input id="portal-title" maxLength={120} placeholder="e.g. What we're building next" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ flex: 1, minWidth: 160 }} />
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <label className="btn small">
              {d.hasLogo ? "Replace" : "Add logo"}
              <input type="file" accept=".png,.jpg,.jpeg,.webp" hidden aria-label="Logo file" onChange={(e) => (pickLogo(e.currentTarget.files?.[0]), (e.currentTarget.value = ""))} />
            </label>
            {d.hasLogo && (
              <button type="button" className="btn small" onClick={() => run(api(logoUrl, { method: "DELETE" }), "Logo removed.")}>
                Remove
              </button>
            )}
            <span className="muted" style={{ fontSize: 13 }}>PNG, JPEG or WebP, up to 256 KB. Shown beside the heading.</span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="portal-intro">Introduction</label>
          <DraftTextarea draftKey={introKey} id="portal-intro" rows={2} maxLength={2000} value={form.intro} onChange={(text) => setForm({ ...form, intro: text })} />
        </div>
        <SaveButton {...sv} busy={busy} style={{ alignSelf: "flex-start" }} />
      </form>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (backProblem) return;
          setBackBusy(true);
          run(
            api(`/api/companies/${companyId}/portal`, { method: "PATCH", body: { backUrl: back.url.trim() || null, backText: back.text.trim() || null } }),
            back.url.trim() ? "Back link saved." : "Back link removed.",
          ).finally(() => setBackBusy(false));
        }}
        style={{ display: "flex", flexDirection: "column", gap: 10 }}
      >
        <div className="field">
          <label htmlFor="portal-back-url">Link back to your website (optional)</label>
          <input
            id="portal-back-url"
            type="url"
            inputMode="url"
            maxLength={2000}
            placeholder="https://example.com"
            value={back.url}
            aria-invalid={!!backProblem}
            aria-describedby={backProblem ? "portal-back-url-error" : undefined}
            onChange={(e) => setBack({ url: e.target.value, text: back.text })}
          />
          {backProblem && (
            <p id="portal-back-url-error" className="error" role="alert">
              {backProblem}
            </p>
          )}
          <span className="muted" style={{ fontSize: 13 }}>
            When set, the portal shows a "back to" bar at the top and a link at the bottom, so a visitor can return to your site. Leave it empty for no bar.
          </span>
        </div>
        <div className="field">
          <label htmlFor="portal-back-text">Link text (optional)</label>
          <input id="portal-back-text" maxLength={40} placeholder="e.g. Boss Man" value={back.text} onChange={(e) => setBack({ url: back.url, text: e.target.value })} />
          <span className="muted" style={{ fontSize: 13 }}>
            Shown after "Back to". Leave it empty to use the portal heading.
          </span>
        </div>
        <SaveButton dirty saved={false} busy={backBusy} disabled={!!backProblem || !back || (!back.url.trim() && !back.text.trim())} style={{ alignSelf: "flex-start" }} />
      </form>
      <fieldset style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
        <legend style={{ fontSize: 14, fontWeight: 600, padding: "0 6px" }}>Short public address</legend>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
          <input
            type="checkbox"
            checked={!!d.portalAtBareAddress}
            aria-describedby="bare-address-help"
            onChange={(e) =>
              run(api(`/api/companies/${companyId}/portal`, { method: "PATCH", body: { portalAtBareAddress: e.target.checked } }), e.target.checked ? "The public address now opens this portal." : "The public address no longer opens this portal.")
            }
          />
          Open this portal at the public address itself{d.portalUrl ? ` (${d.portalUrl})` : ""}, with no secret link part
        </label>
        <p id="bare-address-help" className="muted" style={{ fontSize: 13 }}>
          Anyone who opens that address sees this portal, so use it for a portal meant to be public, such as the one your website links to. Only one company's portal can use it; turning it on here turns it off for any other. The portal must also be turned on.
        </p>
      </fieldset>
      <ConfirmByEmail companyId={companyId} d={d} run={run} />
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"} style={{ fontSize: 14 }}>
          {note.text}
        </p>
      )}
    </section>
  );
}

/** BOS-1388: visitors must click an emailed link before a post, comment or vote counts. Needs outgoing email first. */
function ConfirmByEmail({ companyId, d, run }: { companyId: string; d: FeedbackSettingsView; run: (p: Promise<unknown>, ok?: string) => unknown }) {
  // An older server sends neither number: show the defaults rather than "undefined".
  const savedHours = d.confirmLinkHours ?? 24;
  const savedDays = d.rememberAddressDays ?? 90;
  const [hours, setHours] = useState(String(savedHours));
  const [days, setDays] = useState(String(savedDays));
  const h = Number(hours);
  const dy = Number(days);
  const problem = !Number.isInteger(h) || h < 1 || h > 168 ? "The link must last 1 to 168 hours." : !Number.isInteger(dy) || dy < 1 || dy > 365 ? "Remember a browser for 1 to 365 days." : null;
  const patch = (body: object, ok: string) => run(api(`/api/companies/${companyId}/portal`, { method: "PATCH", body }), ok);
  const blocked = !d.emailReady || !d.portalUrl;
  return (
    <fieldset style={{ border: "1px solid var(--border, #333)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
      <legend style={{ fontSize: 14, fontWeight: 600, padding: "0 6px" }}>Confirm posts by email</legend>
      <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
        <input type="checkbox" checked={d.confirmByEmail} disabled={blocked && !d.confirmByEmail} aria-describedby="confirm-email-help" onChange={(e) => patch({ confirmByEmail: e.target.checked }, e.target.checked ? "Visitors now confirm by email." : "Visitors no longer need to confirm.")} />
        Visitors must click a link we email them before a post, comment or vote counts
      </label>
      <p id="confirm-email-help" className="muted" style={{ fontSize: 13 }}>
        {!d.emailReady
          ? "Set up outgoing email first (Settings → Server and runner → Email): the links are sent from it."
          : !d.portalUrl
            ? "The links need the portal's public address: set BOSSMAN_PORTAL_URL (see the install guide)."
            : "With this on, visitors give an email address. What they send is kept out of sight, and counts for nothing, until they click the emailed link. Unconfirmed posts are deleted when the link runs out."}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!problem) void patch({ confirmLinkHours: h, rememberAddressDays: dy }, "Saved.");
        }}
        style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}
      >
        <div className="field">
          <label htmlFor="confirm-hours">Link works for (hours)</label>
          <input id="confirm-hours" type="number" min={1} max={168} value={hours} onChange={(e) => setHours(e.target.value)} style={{ width: 90 }} />
        </div>
        <div className="field">
          <label htmlFor="confirm-days">Remember a confirmed browser for (days)</label>
          <input id="confirm-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} style={{ width: 90 }} />
        </div>
        <button className="btn small" type="submit" disabled={!!problem || (h === savedHours && dy === savedDays)}>
          Save times
        </button>
      </form>
      {problem && (
        <p role="alert" className="error" style={{ fontSize: 13 }}>
          {problem}
        </p>
      )}
    </fieldset>
  );
}

export function Feedback({ companies, companyId, noteId, go }: { companies: Company[]; companyId: string | undefined; noteId: string | undefined; go: (to: string) => void }) {
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  const [tab, setTab] = useState<State>("unprocessed");
  const [q, setQ] = useState("");
  const [search, setSearch] = useState("");
  const [portal, setPortal] = useState(false);
  const list = usePoll(
    (signal) => (company ? api<NoteSummary[]>(`/api/companies/${company.id}/feedback?state=${tab}${search ? `&q=${encodeURIComponent(search)}` : ""}`, { signal }) : Promise.resolve([])),
    30_000,
    `fb-${company?.id}-${tab}-${search}`,
  );
  const counts = usePoll((signal) => api<Record<string, number>>("/api/feedback/unprocessed", { signal }), 30_000, "fb-counts");
  const features = usePoll((signal) => (company ? api<ScoredFeatures>(`/api/companies/${company.id}/features`, { signal }) : Promise.resolve(null)), 60_000, `fb-features-${company?.id}`);
  const open = (id: string | null) => go(id ? `feedback/${company!.id}/${id}` : `feedback/${company!.id}`);
  const changed = () => (list.reload(), counts.reload(), features.reload());
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Feedback</h1>
          <p className="sub">What people tell each company. Link the passages that ask for something to features, and how much it matters to them.</p>
        </div>
      </header>
      {!company ? (
        <NoCompany />
      ) : (
        <>
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
            <AddNote companyId={company.id} onAdded={(id) => (changed(), setTab("unprocessed"), open(id))} />
            <a href={`#/features/${company.id}`}>Features and priorities</a>
            <button type="button" className="btn small" aria-expanded={portal} onClick={() => setPortal(!portal)} style={{ marginLeft: "auto" }}>
              Feedback portal
            </button>
          </div>
          {portal && <PortalSettings companyId={company.id} shown={(features.data?.features ?? []).filter((f) => f.portalVisible && f.status !== "declined").length} />}
          <div className={`inbox ${noteId ? "has-note" : ""}`}>
            <section className="inbox-list" aria-label="Feedback">
              <div className="tabs" role="tablist" aria-label="Feedback by state">
                {TABS.map((t) => (
                  <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
                    {t.label}
                    {/* R43: the sidebar Feedback badge's figure and label (feedback.toProcess). */}
                    {t.id === "unprocessed" && counts.data?.[company.id] ? <span className="tab-count" aria-label={figureText("feedback.toProcess", counts.data[company.id]!)} title={figureText("feedback.toProcess", counts.data[company.id]!)}>{counts.data[company.id]}</span> : null}
                  </button>
                ))}
              </div>
              <form
                role="search"
                onSubmit={(e) => {
                  e.preventDefault();
                  setSearch(q.trim());
                }}
                style={{ display: "flex", gap: 8 }}
              >
                <label htmlFor="fb-search" className="visually-hidden">
                  Search feedback
                </label>
                <input id="fb-search" className="search" type="search" placeholder="Search text or who it's from" value={q} onChange={(e) => setQ(e.target.value)} />
                <button className="btn small" type="submit">
                  Search
                </button>
              </form>
              {list.data && !list.data.length && <p className="muted">{search ? "Nothing matches." : tab === "unprocessed" ? "Nothing waiting. Add feedback above." : "Nothing here."}</p>}
              <ul className="note-list">
                {(list.data ?? []).map((n) => (
                  <li key={n.id}>
                    <button type="button" aria-current={n.id === noteId ? "true" : undefined} onClick={() => open(n.id)}>
                      <span className="note-head">
                        <b>{n.title ?? n.customer ?? "Anonymous"}</b>
                        <small className="muted">{when(n.createdAt)}</small>
                      </span>
                      <span className="note-snippet">{n.text.slice(0, 160)}</span>
                      <span className="note-meta">
                        {n.title && n.customer && <span>{n.customer}</span>}
                        <span>{SOURCE[n.source] ?? n.source}</span>
                        {n.insightCount > 0 && <span className="tag blue">{n.insightCount} linked</span>}
                        {n.untrusted && <span className="tag">from outside</span>}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            {noteId ? (
              <NotePane key={noteId} id={noteId} companyId={company.id} features={features.data?.features ?? []} onChanged={changed} onClose={() => open(null)} />
            ) : (
              <p className="muted inbox-empty">Pick a note to read it and link it to features.</p>
            )}
          </div>
        </>
      )}
    </>
  );
}
