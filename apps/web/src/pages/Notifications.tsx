import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Company, type Notice, type NoticeFeed, type NotifyLevel, type NotifySettings } from "../api";
import { usePoll } from "../hooks";
import { away } from "../server-watch";
import { when } from "./Runs";
import { MoreText } from "./Decisions";
import { SaveButton, useSaveState } from "../components/SaveButton";

const LEVEL: Record<NotifyLevel, { label: string; tone: string; help: string }> = {
  note: { label: "Note", tone: "", help: "The feed only" },
  flag: { label: "Flag", tone: "blue", help: "A browser notification" },
  page: { label: "Page", tone: "red", help: "Also the phone: something urgent" },
  ask: { label: "Ask", tone: "amber", help: "Needs an answer" },
};

function Item({ n, onRead }: { n: Notice; onRead: (id: string) => void }) {
  return (
    <li className="card" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 16px", opacity: n.readAt ? 0.7 : 1 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className={`tag ${LEVEL[n.level].tone}`}>{LEVEL[n.level].label}</span>
        {!n.readAt && <span className="tag green">New</span>}
        <strong style={{ fontWeight: 600 }}>{n.title}</strong>
        <span className="muted" style={{ fontSize: 13, marginLeft: "auto" }}>
          {n.company ? `${n.company} · ` : ""}
          {when(n.createdAt)}
        </span>
      </div>
      {n.body && <MoreText text={n.body} lines={3} chars={300} />}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
        <a href={n.link} onClick={() => !n.readAt && onRead(n.id)}>
          See the evidence
        </a>
        {n.demotedBy && (
          <span className="muted">
            Asked as a {n.requested}, sent as a {n.level}: {n.demotedBy === "cap" ? "the agent was over its hourly cap" : "quiet hours"}.
          </span>
        )}
        {n.pushedAt && <span className="muted">Sent to your phone.</span>}
        {n.pushError && <span className="error">Phone push failed: {n.pushError}</span>}
        {!n.readAt && (
          <button type="button" className="btn small" style={{ marginLeft: "auto" }} onClick={() => onRead(n.id)}>
            Mark read
          </button>
        )}
      </div>
    </li>
  );
}

type Form = {
  quiet: boolean;
  start: string;
  end: string;
  timeZone: string;
  cap: number;
  phone: boolean;
  url: string;
  topic: string;
  token: string;
  clearToken: boolean;
  pushLevels: NotifyLevel[];
  phonePush: "urgent" | "all";
  publicUrl: string;
  approveButtons: boolean;
};

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function toForm(s: NotifySettings): Form {
  return {
    quiet: !!s.quietHours,
    start: s.quietHours?.start ?? "22:00",
    end: s.quietHours?.end ?? "07:00",
    timeZone: s.quietHours?.timeZone ?? browserZone(),
    cap: s.agentHourlyCap,
    phone: !!s.ntfy,
    url: s.ntfy?.url ?? "",
    topic: s.ntfy?.topic ?? "",
    token: "",
    clearToken: false,
    pushLevels: s.pushLevels ?? [],
    phonePush: s.phonePush === "all" ? "all" : "urgent",
    publicUrl: s.publicUrl ?? (window.location.protocol === "https:" ? window.location.origin : ""),
    approveButtons: s.approveButtons !== false,
  };
}

function SettingsForm() {
  const [saved, setSaved] = useState<NotifySettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const sv = useSaveState(form);
  useEffect(() => {
    void api<NotifySettings>("/api/notification-settings").then((s) => (setSaved(s), setForm(toForm(s))), (err: Error) => setNote({ ok: false, text: err.message }));
  }, []);
  if (!form) return note ? <p className="error">{note.text}</p> : null;
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote({ ok: true, text: await fn() });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const s = await api<NotifySettings>("/api/notification-settings", {
        method: "PUT",
        body: {
          quietHours: form.quiet ? { start: form.start, end: form.end, timeZone: form.timeZone.trim() } : null,
          agentHourlyCap: form.cap,
          ntfy: form.phone ? { url: form.url.trim(), topic: form.topic.trim(), ...(form.token ? { token: form.token } : form.clearToken ? { token: null } : {}) } : null,
          pushLevels: form.pushLevels,
          phonePush: form.phonePush,
          publicUrl: form.publicUrl.trim() || null,
          approveButtons: form.approveButtons,
        },
      });
      setSaved(s);
      setForm(toForm(s));
      sv.markSaved(toForm(s));
      return "Saved.";
    });
  };
  const test = () => act(async () => (await api("/api/notification-settings/test", { method: "POST" }), "Test sent. Check your phone."));
  const row = { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" } as const;
  const check = { display: "flex", gap: 6, alignItems: "center", minHeight: 32, fontSize: 14 } as const;

  return (
    <form className="card" onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 16 }} aria-labelledby="notify-settings-h">
      <h2 id="notify-settings-h" style={{ fontSize: 17, fontWeight: 600 }}>
        How you're told
      </h2>
      <p className="muted" style={{ fontSize: 14 }}>
        Notes stay in this feed. Flags, pages and asks also show as browser notifications while Boss Man is open in a background tab. Quiet hours and each agent's hourly cap lower a notification's level instead of dropping it.
      </p>

      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={check}>
          <input type="checkbox" checked={form.quiet} onChange={(e) => set({ quiet: e.target.checked })} />
          Quiet hours: pages and asks become flags, flags become notes
        </label>
        {form.quiet && (
          <div style={row}>
            <div className="field">
              <label htmlFor="quiet-start">From</label>
              <input id="quiet-start" type="time" required value={form.start} onChange={(e) => set({ start: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="quiet-end">Until</label>
              <input id="quiet-end" type="time" required value={form.end} onChange={(e) => set({ end: e.target.value })} />
            </div>
            <div className="field" style={{ flex: "1 1 200px" }}>
              <label htmlFor="quiet-tz">Time zone</label>
              <input id="quiet-tz" required value={form.timeZone} onChange={(e) => set({ timeZone: e.target.value })} spellCheck={false} />
            </div>
          </div>
        )}
      </fieldset>

      <div className="field" style={{ maxWidth: 260 }}>
        <label htmlFor="agent-cap">Per agent, per hour, before the rest become notes</label>
        <input id="agent-cap" type="number" min={1} max={100} required value={form.cap} onChange={(e) => set({ cap: Number(e.target.value) })} />
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={check}>
          <input type="checkbox" checked={form.phone} onChange={(e) => set({ phone: e.target.checked })} />
          Send to my phone through my own ntfy server
        </label>
        {form.phone && (
          <>
            <div style={row}>
              <div className="field" style={{ flex: "2 1 260px" }}>
                <label htmlFor="ntfy-url">ntfy server</label>
                <input id="ntfy-url" type="url" required placeholder="https://ntfy.your-tailnet.ts.net" value={form.url} onChange={(e) => set({ url: e.target.value })} spellCheck={false} />
              </div>
              <div className="field" style={{ flex: "1 1 160px" }}>
                <label htmlFor="ntfy-topic">Topic</label>
                <input id="ntfy-topic" required pattern="[A-Za-z0-9_\-]{1,64}" value={form.topic} onChange={(e) => set({ topic: e.target.value })} spellCheck={false} />
              </div>
            </div>
            <div style={row}>
              <div className="field" style={{ flex: "1 1 260px" }}>
                <label htmlFor="ntfy-token">Access token{saved?.ntfy?.hasToken ? " (one is saved; type a new one to replace it)" : ""}</label>
                <input id="ntfy-token" type="password" autoComplete="off" spellCheck={false} value={form.token} onChange={(e) => set({ token: e.target.value, clearToken: false })} />
              </div>
              {saved?.ntfy?.hasToken && (
                <label style={check}>
                  <input type="checkbox" checked={form.clearToken} onChange={(e) => set({ clearToken: e.target.checked, token: "" })} />
                  Remove the saved token
                </label>
              )}
            </div>
            <div className="field" style={{ maxWidth: 360 }}>
              <label htmlFor="phone-push">Send to my phone</label>
              <select id="phone-push" value={form.phonePush} onChange={(e) => set({ phonePush: e.target.value === "all" ? "all" : "urgent" })}>
                <option value="urgent">Urgent only (default)</option>
                <option value="all">All decisions</option>
              </select>
            </div>
            <p className="muted" style={{ fontSize: 14, margin: 0 }}>
              Urgent means a decision that holds up work only you can answer, a deploy that carries the fix for a live problem, a "server unusable" page, or the test button. Urgent pushes go at the top priority (5), which breaks through Do Not Disturb on Android. With All decisions, routine ones go at the normal priority (3). Everything stays on the Decisions and Notifications pages either way.
            </p>
            <label style={check}>
              <input type="checkbox" checked={form.pushLevels.includes("flag")} onChange={(e) => set({ pushLevels: e.target.checked ? [...form.pushLevels, "flag"] : form.pushLevels.filter((x) => x !== "flag") })} />
              Also send flags (normal priority)
            </label>
            <div className="field">
              <label htmlFor="public-url">Boss Man's address on your phone, so a tap opens the evidence</label>
              <input id="public-url" type="url" placeholder="https://bossman.your-tailnet.ts.net" value={form.publicUrl} onChange={(e) => set({ publicUrl: e.target.value })} spellCheck={false} />
            </div>
            <label style={check}>
              <input type="checkbox" checked={form.approveButtons} onChange={(e) => set({ approveButtons: e.target.checked })} />
              Offer an Approve button on simple agent questions
            </label>
            {saved?.approve && (
              <p className="muted" style={{ fontSize: 14 }} aria-live="polite">
                {saved.approve.on ? "Phone Approve: on. Simple agent questions get an Approve button that answers with the agent's recommendation." : `Phone Approve: off because ${saved.approve.why}. Every push still gets an Open in Boss Man button.`}
              </p>
            )}
          </>
        )}
      </fieldset>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <SaveButton {...sv} busy={busy} />
        {saved?.ntfy && (
          <button className="btn" type="button" disabled={busy} onClick={() => void test()}>
            Send a test to my phone
          </button>
        )}
      </div>
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"} style={{ fontSize: 14 }}>
          {note.text}
        </p>
      )}
    </form>
  );
}

type Status = "all" | "unread" | "read";
type Filters = { status: Status; level: NotifyLevel | "all"; company: string };
const NO_FILTERS: Filters = { status: "all", level: "all", company: "all" };
const FILTERS_KEY = "notifications-filters";
const NO_COMPANY = "none";
const LEVEL_PLURAL: Record<NotifyLevel, string> = { note: "Notes", flag: "Flags", page: "Pages", ask: "Asks" };

/** The choices kept for the browser session; anything unreadable falls back to All. */
function readFilters(): Filters {
  try {
    const s = JSON.parse(sessionStorage.getItem(FILTERS_KEY) ?? "null") as Partial<Filters> | null;
    if (s && typeof s === "object") {
      return {
        status: s.status === "unread" || s.status === "read" ? s.status : "all",
        level: s.level && s.level in LEVEL ? s.level : "all",
        company: typeof s.company === "string" && s.company ? s.company : "all",
      };
    }
  } catch {
    /* unreadable: use the default */
  }
  return NO_FILTERS;
}

function FilterBar({ filters, companies, set }: { filters: Filters; companies: Company[]; set: (patch: Partial<Filters>) => void }) {
  const sorted = [...companies].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div role="search" aria-label="Filter notifications" style={{ display: "flex", flexWrap: "wrap", gap: "12px 20px", alignItems: "center", marginBottom: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="label" id="nf-status">
          Status
        </span>
        <div className="segmented" role="group" aria-labelledby="nf-status">
          {(["all", "unread", "read"] as const).map((v) => (
            <button key={v} type="button" className="chip" aria-pressed={filters.status === v} style={filters.status === v ? { fontWeight: 700 } : undefined} onClick={() => set({ status: v })}>
              {v === "all" ? "All" : v === "unread" ? "Unread" : "Read"}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className="label" id="nf-type">
          Type
        </span>
        <div className="segmented" role="group" aria-labelledby="nf-type" style={{ flexWrap: "wrap" }}>
          {(["all", "note", "flag", "page", "ask"] as const).map((v) => (
            <button key={v} type="button" className="chip" aria-pressed={filters.level === v} style={filters.level === v ? { fontWeight: 700 } : undefined} onClick={() => set({ level: v })}>
              {v === "all" ? "All" : LEVEL_PLURAL[v]}
            </button>
          ))}
        </div>
      </div>
      <div className="nf-company" style={{ display: "flex", gap: 8, alignItems: "center", flex: "1 1 200px", minWidth: 200, maxWidth: 280 }}>
        <label className="label" htmlFor="nf-company">
          Company
        </label>
        <select id="nf-company" value={filters.company} onChange={(e) => set({ company: e.target.value })} style={{ flex: 1, minWidth: 0 }}>
          <option value="all">All companies</option>
          {sorted.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option disabled>──────────</option>
          <option value={NO_COMPANY}>No company</option>
        </select>
      </div>
    </div>
  );
}

export function Notifications({ feed, onChanged, companies = null }: { feed: NoticeFeed | null; onChanged: () => void; companies?: Company[] | null }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(readFilters);
  // A remembered company that no longer exists goes back to All companies.
  const filters: Filters = companies && saved.company !== "all" && saved.company !== NO_COMPANY && !companies.some((c) => c.id === saved.company) ? { ...saved, company: "all" } : saved;
  const setFilters = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    setSaved(next);
    try {
      sessionStorage.setItem(FILTERS_KEY, JSON.stringify(next));
    } catch {
      /* storage blocked: the choice lasts until the page reloads */
    }
  };
  const active = filters.status !== "all" || filters.level !== "all" || filters.company !== "all";

  const query = new URLSearchParams();
  if (filters.status !== "all") query.set("status", filters.status);
  if (filters.level !== "all") query.set("level", filters.level);
  if (filters.company !== "all") query.set("company", filters.company);
  const qs = query.toString();
  // With a filter on the page polls its own list, so older notices and new arrivals are matched by the server.
  const filtered = usePoll((signal) => (qs ? api<NoticeFeed>(`/api/notifications?${qs}`, { signal }) : Promise.resolve(null)), 10_000, `notifications-${qs}`);
  const last = useRef<Notice[]>([]);
  const loaded = active ? filtered.data?.items : feed?.items;
  if (loaded) last.current = loaded;
  const items = loaded ?? (active ? last.current : []);
  const updating = active && !filtered.data && !filtered.error;

  const reload = () => {
    onChanged();
    filtered.reload();
  };
  const read = (body: { ids: string[] } | { all: true }) => void api("/api/notifications/read", { method: "POST", body }).then(reload, (err: Error) => setError(err.message));
  const unreadShown = items.filter((n) => !n.readAt);
  const clear = () => setFilters(NO_FILTERS);

  const companyName = filters.company === NO_COMPANY ? "No company" : companies?.find((c) => c.id === filters.company)?.name;
  const parts = [filters.status !== "all" ? (filters.status === "unread" ? "Unread" : "Read") : null, filters.level !== "all" ? LEVEL_PLURAL[filters.level] : null, filters.company !== "all" ? companyName : null].filter(Boolean);
  const full = items.length >= 50;
  const summary = updating ? "Updating…" : `Showing ${full ? "the latest " : ""}${items.length} · ${parts.join(", ")}`;
  const neverAny = !active && feed && !items.length;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Notifications</h1>
          <p className="sub">Everything Boss Man and the agents have told you, newest first, with where to look.</p>
        </div>
        {active
          ? unreadShown.length > 0 && (
              <button className="btn" type="button" onClick={() => read({ ids: unreadShown.map((n) => n.id) })}>
                Mark these read
              </button>
            )
          : (feed?.unread ?? 0) > 0 && (
              <button className="btn" type="button" onClick={() => read({ all: true })}>
                Mark all read
              </button>
            )}
      </header>
      {error && <p className="error">{error}</p>}
      {!neverAny && <FilterBar filters={filters} companies={companies ?? []} set={setFilters} />}
      {active && (
        <div role="status" style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginBottom: 12, fontSize: 14 }}>
          <span className="muted">{summary}</span>
          <button type="button" className="btn small" onClick={clear}>
            Clear filters
          </button>
        </div>
      )}
      {active && filtered.error && !away(filtered.error) && (
        <p className="error" role="alert">
          Couldn't load notifications: {filtered.error.message}. Your filters are kept.{" "}
          <button type="button" className="btn small" onClick={filtered.reload}>
            Try again
          </button>
        </p>
      )}
      {neverAny && <p className="muted">Nothing yet. Decisions that need you, alerts and agents' notes will show here.</p>}
      {active && !updating && !filtered.error && !items.length && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", margin: "16px 0" }}>
          <strong>No notifications match</strong>
          <span className="muted">Try another filter, or clear them to see everything.</span>
          <button type="button" className="btn" onClick={clear}>
            Clear filters
          </button>
        </div>
      )}
      {items.length > 0 && (
        <ul aria-busy={updating} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((n) => (
            <Item key={n.id} n={n} onRead={(id) => read({ ids: [id] })} />
          ))}
        </ul>
      )}
      <SettingsForm />
    </>
  );
}
