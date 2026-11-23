// The public feedback portal (portal.html#<token>). It shares nothing with the owner's app
// but the styles; the token after "#" never reaches the server in a URL.
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { clearDraft } from "../drafts";
import { DraftTextarea } from "../components/DraftTextarea";
import { Loader } from "../components/Loader";

type Importance = "nice_to_have" | "important" | "critical";
const LEVELS: Array<{ id: Importance; label: string }> = [
  { id: "nice_to_have", label: "Nice to have" },
  { id: "important", label: "Important" },
  { id: "critical", label: "Critical" },
];
type Stage = "considering" | "planned" | "released";
const STAGES: Array<{ id: Stage; label: string; help: string }> = [
  { id: "considering", label: "Under consideration", help: "Ideas we haven't committed to yet. Tell us how much they'd matter to you." },
  { id: "planned", label: "Planned", help: "On the way. Your vote still helps us decide what comes first." },
  { id: "released", label: "What's new", help: "Features we've released, newest first." },
];
/** The released features grouped under "November 2026" style headings (UTC), newest first. */
export function groupByMonth<T extends { releasedAt?: string | null }>(items: T[]): Array<{ month: string; items: T[] }> {
  const sorted = [...items].sort((a, b) => (b.releasedAt ?? "").localeCompare(a.releasedAt ?? ""));
  const groups: Array<{ month: string; items: T[] }> = [];
  for (const f of sorted) {
    const month = f.releasedAt ? new Date(f.releasedAt).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }) : "Earlier";
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.items.push(f);
    else groups.push({ month, items: [f] });
  }
  return groups;
}
const releaseDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
// BOS-1921: a summary that only repeats the title is shown once (nothing stored changes).
const squash = (s: string) => s.toLowerCase().replace(/\s+/g, " ").replace(/[\s.!?…:;,]+$/, "").trim();
const sameText = (title: string, body: string) => squash(title) === squash(body);
type PortalFeature = { id: string; title: string; description: string | null; stage: Stage; releasedAt?: string | null; myVote: { importance: Importance; comment: string | null } | null };
type Portal = { title: string; intro: string | null; hasLogo: boolean; confirmByEmail?: boolean; rememberedEmail?: string | null; back: { url: string; text: string } | null; features: PortalFeature[] };
/** BOS-1388: with "Confirm posts by email" on, the address is needed and the reason is said once, next to the box. */
type Ask = { required: boolean; remembered: string | null };
const WHY_EMAIL = "We ask for your email only to send you a link that confirms it's you. It counts once you click it. Nobody else ever sees it.";
const CHECK_EMAIL = "Check your email: we sent you a link. It counts once you click it.";

const token = () => decodeURIComponent(window.location.hash.replace(/^#/, ""));

async function call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    credentials: "same-origin",
    headers: { "x-portal-token": token(), ...(init.body !== undefined ? { "content-type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new Error(String(data.message ?? `Something went wrong (${res.status}).`));
  return data as T;
}

function EmailField({ email, onChange, id, ask }: { email: string; onChange: (email: string) => void; id: string; ask: Ask }) {
  return (
    <div className="field">
      <label htmlFor={id}>{ask.required ? "Your email" : "Email, if you'd like to hear back (optional)"}</label>
      <input id={id} type="email" required={ask.required} maxLength={320} autoComplete="email" aria-describedby={ask.required ? `${id}-why` : undefined} value={email} onChange={(e) => onChange(e.target.value)} />
      {ask.required && (
        <p id={`${id}-why`} className="muted" style={{ fontSize: 13 }}>
          {WHY_EMAIL}
        </p>
      )}
    </div>
  );
}

function Who({ name, email, onChange, idPrefix, ask }: { name: string; email: string; onChange: (v: { name: string; email: string }) => void; idPrefix: string; ask: Ask }) {
  return (
    <div className="form-grid">
      <div className="field">
        <label htmlFor={`${idPrefix}-name`}>Your name (optional)</label>
        <input id={`${idPrefix}-name`} maxLength={100} autoComplete="name" value={name} onChange={(e) => onChange({ name: e.target.value, email })} />
      </div>
      <EmailField id={`${idPrefix}-email`} email={email} ask={ask} onChange={(v) => onChange({ name, email: v })} />
    </div>
  );
}

function FeatureCard({ f, onChanged, ask }: { f: PortalFeature; onChanged: () => void; ask: Ask }) {
  const [comment, setComment] = useState(f.myVote?.comment ?? "");
  // A visitor's comment is kept in their browser as they type (DR-045); it goes once it is sent.
  const commentKey = `portal-comment/${f.id}`;
  const [who, setWho] = useState({ name: "", email: ask.remembered ?? "" });
  const [open, setOpen] = useState(false);
  // A vote needs an address when the owner asks for one and this browser hasn't confirmed one: ask before sending it.
  const [asking, setAsking] = useState<Importance | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const vote = (importance: Importance, withComment = false) =>
    void call<{ needsConfirm?: boolean }>(`/api/portal/votes`, { method: "POST", body: { featureId: f.id, importance, ...(withComment ? { comment: comment.trim() || null, name: who.name.trim() || null } : {}), email: who.email.trim() || null } }).then(
      (r) => (setNote({ ok: true, text: r.needsConfirm ? CHECK_EMAIL : withComment ? "Thanks, we've got your comment." : "Thanks for your vote." }), setOpen(withComment ? false : open), setAsking(null), withComment && clearDraft(commentKey), onChanged()),
      (err: Error) => setNote({ ok: false, text: err.message }),
    );
  const pick = (importance: Importance) => (ask.required && !who.email.trim() ? (setAsking(importance), setNote(null)) : vote(importance));
  const remove = () => void call(`/api/portal/votes/${f.id}`, { method: "DELETE" }).then(() => (setNote(null), setComment(""), clearDraft(commentKey), onChanged()), (err: Error) => setNote({ ok: false, text: err.message }));
  const canVote = f.stage !== "released";
  return (
    <li className="card portal-card">
      <h3>{f.title}</h3>
      {f.releasedAt && (
        <p className="muted" style={{ fontSize: 13 }}>
          Released <time dateTime={f.releasedAt}>{releaseDate(f.releasedAt)}</time>
        </p>
      )}
      {f.description && !sameText(f.title, f.description) && <p style={{ whiteSpace: "pre-wrap" }}>{f.description}</p>}
      {canVote && (
        <>
          <p className="label">How much would this matter to you?</p>
          <div className="chips" role="group" aria-label={`How much ${f.title} would matter to you`}>
            {LEVELS.map((l) => (
              <button key={l.id} type="button" className={`chip ${f.myVote?.importance === l.id ? "on" : ""}`} aria-pressed={f.myVote?.importance === l.id} onClick={() => pick(l.id)}>
                {l.label}
              </button>
            ))}
          </div>
          {asking && (
            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                vote(asking);
              }}
              style={{ display: "flex", flexDirection: "column", gap: 10 }}
            >
              <EmailField id={`v-${f.id}-email`} email={who.email} ask={ask} onChange={(email) => setWho({ ...who, email })} />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn primary" type="submit">
                  Send my vote
                </button>
                <button className="btn" type="button" onClick={() => setAsking(null)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
          {f.myVote && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", fontSize: 14 }}>
              {!open && (
                <button type="button" className="btn small" onClick={() => setOpen(true)}>
                  {f.myVote.comment ? "Edit your comment" : "Tell us why"}
                </button>
              )}
              <button type="button" className="btn small" onClick={remove}>
                Remove my vote
              </button>
            </div>
          )}
          {open && f.myVote && (
            <form
              onSubmit={(e: FormEvent) => {
                e.preventDefault();
                vote(f.myVote!.importance, true);
              }}
              style={{ display: "flex", flexDirection: "column", gap: 10 }}
            >
              <div className="field">
                <label htmlFor={`c-${f.id}`}>What would it let you do?</label>
                <DraftTextarea draftKey={commentKey} id={`c-${f.id}`} rows={3} maxLength={2000} value={comment} onChange={setComment} />
              </div>
              <Who name={who.name} email={who.email} onChange={setWho} idPrefix={`w-${f.id}`} ask={ask} />
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn primary" type="submit">
                  Send
                </button>
                <button className="btn" type="button" onClick={() => setOpen(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"} style={{ fontSize: 14 }}>
          {note.text}
        </p>
      )}
    </li>
  );
}

function Idea({ ask }: { ask: Ask }) {
  const [form, setForm] = useState({ title: "", text: "", name: "", email: ask.remembered ?? "", website: "" });
  // A visitor's idea is kept in their browser as they type (DR-045); it goes once it is sent.
  const textKey = "portal-idea";
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void call<{ needsConfirm?: boolean }>(`/api/portal/ideas`, { method: "POST", body: { title: form.title.trim(), text: form.text.trim(), name: form.name.trim() || null, email: form.email.trim() || null, website: form.website } }).then(
      (r) => (setForm({ title: "", text: "", name: "", email: ask.remembered ?? "", website: "" }), clearDraft(textKey), setNote({ ok: true, text: r.needsConfirm ? CHECK_EMAIL : "Thank you! We read every idea." })),
      (err: Error) => setNote({ ok: false, text: err.message }),
    );
  };
  return (
    <form className="card" onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-labelledby="idea-h">
      <h2 id="idea-h" style={{ fontSize: 18, fontWeight: 600 }}>
        Suggest something
      </h2>
      <div className="field">
        <label htmlFor="idea-title">Your idea, in a few words</label>
        <input id="idea-title" required maxLength={200} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="idea-text">What problem would it solve for you?</label>
        <DraftTextarea draftKey={textKey} id="idea-text" required rows={4} maxLength={5000} value={form.text} onChange={(text) => setForm({ ...form, text })} />
      </div>
      <Who name={form.name} email={form.email} onChange={(w) => setForm({ ...form, ...w })} idPrefix="idea" ask={ask} />
      {/* People never see this; bots tend to fill it in. */}
      <div className="visually-hidden" aria-hidden="true">
        <label htmlFor="idea-website">Website</label>
        <input id="idea-website" tabIndex={-1} autoComplete="off" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
      </div>
      <button className="btn primary" type="submit" style={{ alignSelf: "flex-start" }}>
        Send idea
      </button>
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"}>
          {note.text}
        </p>
      )}
    </form>
  );
}

/** The logo as a data: URL: the token travels in a header, which an <img> can't send. */
function useLogo(has: boolean | undefined) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!has) return setSrc(null);
    let live = true;
    void fetch("/api/portal/logo", { headers: { "x-portal-token": token() } })
      .then(async (r) => {
        if (!r.ok) throw new Error("no logo");
        const bytes = new Uint8Array(await r.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        if (live) setSrc(`data:${r.headers.get("content-type") ?? "image/png"};base64,${btoa(bin)}`);
      })
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [has]);
  return src;
}

export function PortalApp() {
  const [data, setData] = useState<Portal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("considering");
  const logo = useLogo(data?.hasLogo);
  const load = useCallback(() => {
    // BOS-1680: with no secret in the link the server decides: it opens the portal the owner chose for the bare
    // address, or answers 404, which is when "incomplete" is the true thing to say.
    void call<Portal>("/api/portal").then(
      (d) => (setData(d), setError(null), (document.title = d.title)),
      (err: Error) => setError(token() ? err.message : "This link is incomplete. Ask for the full portal link."),
    );
  }, []);
  useEffect(() => {
    load();
    window.addEventListener("hashchange", load);
    return () => window.removeEventListener("hashchange", load);
  }, [load]);
  if (error)
    return (
      <main className="portal">
        <p className="error" role="alert">
          {error}
        </p>
      </main>
    );
  if (!data)
    return (
      <main className="portal">
        <Loader label="Loading the feedback page" />
      </main>
    );
  const shown = data.features.filter((f) => f.stage === stage);
  const ask: Ask = { required: !!data.confirmByEmail, remembered: data.rememberedEmail ?? null };
  // BOS-967: when the owner sets a website address, the page gains a bar at the top and a link at the
  // bottom so a visitor can get back to the site. Both are plain links in the same tab.
  const back = data.back ? (
    <a className="portal-back" href={data.back.url}>
      <span aria-hidden="true">←</span> Back to {data.back.text}
    </a>
  ) : null;
  return (
    <>
      {back && (
        <div className="portal-back-bar">
          <div className="portal-back-wrap">{back}</div>
        </div>
      )}
      <main className="portal">
        <header className="page-head">
          <div style={{ display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
            {logo && <img src={logo} alt="" style={{ maxHeight: 112, maxWidth: "40vw", width: "auto" }} />}
            <div>
              <h1>{data.title}</h1>
              {data.intro && <p className="sub" style={{ whiteSpace: "pre-wrap" }}>{data.intro}</p>}
            </div>
          </div>
        </header>
        <div className="tabs" role="tablist" aria-label="Stages">
          {STAGES.map((s) => (
            <button key={s.id} type="button" role="tab" aria-selected={stage === s.id} onClick={() => setStage(s.id)}>
              {s.label}
              <span className="tab-count">{data.features.filter((f) => f.stage === s.id).length}</span>
            </button>
          ))}
        </div>
        <p className="muted" style={{ fontSize: 14 }}>
          {STAGES.find((s) => s.id === stage)!.help}
        </p>
        {stage === "released" && !token() && (
          <p style={{ fontSize: 14 }}>
            <a href="/api/portal/feed.atom">Follow new releases (Atom feed)</a>
          </p>
        )}
        {shown.length && stage === "released" ? (
          groupByMonth(shown).map((g) => (
            <section key={g.month} aria-label={g.month}>
              <h2 style={{ fontSize: 18, fontWeight: 600 }}>{g.month}</h2>
              <ul className="portal-list">
                {g.items.map((f) => (
                  <FeatureCard key={f.id} f={f} onChanged={load} ask={ask} />
                ))}
              </ul>
            </section>
          ))
        ) : shown.length ? (
          <ul className="portal-list">
            {shown.map((f) => (
              <FeatureCard key={`${f.id}:${ask.remembered ?? ""}`} f={f} onChanged={load} ask={ask} />
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing here yet.</p>
        )}
        <Idea key={ask.remembered ?? ""} ask={ask} />
        <p className="muted" style={{ fontSize: 12 }}>
          Votes are remembered in this browser, so you can change them later. What you send goes to the team as feedback.
        </p>
        {back && (
          <div className="portal-back-foot">
            <p>{back}</p>
          </div>
        )}
      </main>
    </>
  );
}
