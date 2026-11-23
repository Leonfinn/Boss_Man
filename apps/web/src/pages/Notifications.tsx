import { useEffect, useRef, useState } from "react";
import { api, type Company, type Notice, type NoticeCounts, type NoticeFeed, type NotifyLevel } from "../api";
import { useOlder, usePoll } from "../hooks";
import { ShowOlder } from "../components/ShowOlder";
import { away } from "../server-watch";
import { when } from "./Runs";
import { MoreText } from "./Decisions";
import { FeedItem, LevelTag, feedTitle } from "../components/FeedItem";

const LEVEL: Record<NotifyLevel, { label: string; tone: string; help: string }> = {
  note: { label: "Note", tone: "", help: "The feed only" },
  flag: { label: "Flag", tone: "blue", help: "A browser notification" },
  page: { label: "Page", tone: "red", help: "Also the phone: something urgent" },
  ask: { label: "Ask", tone: "amber", help: "Needs an answer" },
};

function Item({ n, onRead }: { n: Notice; onRead: (id: string) => void }) {
  // When the question became the title, show only what follows its first line (if anything) as the body.
  const headline = feedTitle(n.title, n.body);
  const rest = headline === n.title ? n.body : (n.body ?? "").trim().split(/\n/).slice(1).join("\n").trim();
  return (
    <li className="card" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 16px", opacity: n.readAt ? 0.7 : 1 }}>
      <FeedItem
        title={headline}
        lines={2}
        small={
          <>
            <LevelTag level={n.level} label={LEVEL[n.level].label} />
            {!n.readAt && <span className="tag">New</span>}
            <span className="muted">
              {n.company ? `${n.company} · ` : ""}
              {when(n.createdAt)}
            </span>
          </>
        }
      />
      {rest && <MoreText text={rest} lines={3} chars={300} />}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
        <a href={n.link} onClick={() => !n.readAt && onRead(n.id)}>
          See the evidence
        </a>
        {n.demotedBy && (
          <span className="muted">
            Asked as a {n.requested}, sent as a {n.level}: {n.demotedBy === "cap" ? "the agent was over its hourly cap" : "quiet hours"}.
          </span>
        )}
        {n.pushedAt && <span className="muted">Accepted by ntfy at {new Date(n.pushedAt).toLocaleTimeString()}.</span>}
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
type Status = "all" | "unread" | "read";
type Filters = { status: Status; level: NotifyLevel | "all"; company: string; text: string };
const NO_FILTERS: Filters = { status: "all", level: "all", company: "all", text: "" };
const SEARCH_MAX = 200;
const SEARCH_DELAY_MS = 300;
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
        text: typeof s.text === "string" ? s.text.trim().slice(0, SEARCH_MAX) : "",
      };
    }
  } catch {
    /* unreadable: use the default */
  }
  return NO_FILTERS;
}

const TYPE_TITLE: Record<NotifyLevel, string> = {
  ask: "Asks need your answer.",
  page: "Pages are urgent and also go to your phone.",
  flag: "Flags also show as a browser notification.",
  note: "Notes stay in this list.",
};
const LEGEND_ID = "nf-legend";
/** The server's default page, and the size "Show older" asks for. */
const NOTICE_PAGE = 50;

/** A chip's number: hidden at 0 or while the counts are unknown, "99+" above 99. */
function Count({ n, amber }: { n: number | undefined; amber?: boolean }) {
  if (!n) return null;
  return (
    <span className={`nf-count${amber ? " amber" : ""}`} aria-hidden="true">
      {n > 99 ? "99+" : n}
    </span>
  );
}

const unreadLabel = (name: string, n: number | undefined) => (n ? `${name}, ${n > 99 ? "more than 99" : n} unread` : name);

/** One row of toggle chips in three groups; a second press turns a chip off (BOS-1277). */
function FilterBar({ filters, companies, counts, unread, set }: { filters: Filters; companies: Company[]; counts: NoticeCounts | undefined; unread: number | undefined; set: (patch: Partial<Filters>) => void }) {
  const [help, setHelp] = useState(false);
  // The typed text is applied after a short pause; a later change to the saved text (Clear filters) replaces what is typed.
  const [draft, setDraft] = useState(filters.text);
  const latestSet = useRef(set);
  latestSet.current = set;
  useEffect(() => {
    const t = draft.trim();
    if (t === filters.text) return;
    const timer = setTimeout(() => latestSet.current({ text: t }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a new draft starts the wait
  }, [draft]);
  useEffect(() => setDraft((d) => (d.trim() === filters.text ? d : filters.text)), [filters.text]);
  const sorted = [...companies].sort((a, b) => a.name.localeCompare(b.name));
  const showNone = filters.company === NO_COMPANY || (counts?.company[NO_COMPANY] ?? 0) > 0;
  const hideCompanies = sorted.length === 1 && !showNone;
  const many = sorted.length > 4;
  const reveal = (e: { currentTarget: HTMLElement }) => e.currentTarget.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  const chip = (key: string, on: boolean, label: string, onClick: () => void, opts: { count?: number | undefined; amber?: boolean; title?: string; shown?: string } = {}) => (
    <button key={key} type="button" className="chip nf" aria-pressed={on} aria-label={unreadLabel(label, opts.count)} title={opts.title ?? (opts.shown && opts.shown !== label ? label : undefined)} onClick={onClick} onFocus={reveal}>
      {on && <span aria-hidden="true">✓ </span>}
      <span className="nf-name">{opts.shown ?? label}</span>
      <Count n={opts.count} amber={opts.amber} />
    </button>
  );
  const toggleStatus = (v: "unread" | "read") => set({ status: filters.status === v ? "all" : v });
  const toggleLevel = (v: NotifyLevel) => set({ level: filters.level === v ? "all" : v });
  const toggleCompany = (v: string) => set({ company: filters.company === v ? "all" : v });
  return (
    <div className="nf-wrap">
      {/* Above the chip row, which scrolls sideways on a phone and would hide it. */}
      <label className="nf-search" style={{ display: "flex", alignItems: "center", gap: 8, margin: "0 0 10px", flexWrap: "wrap" }}>
        <span className="nf-name">Search notifications</span>
        <input type="search" value={draft} maxLength={SEARCH_MAX} placeholder="Words in the title or text" style={{ flex: "1 1 220px", maxWidth: 420 }} onChange={(e) => setDraft(e.target.value)} />
      </label>
      <div className="nf-bar" role="search" aria-label="Filter notifications">
        <div className="nf-group" role="group" aria-label="Read or unread">
          {/* R43: the server's one unread figure, the sidebar badge's (notifications.unread), not a sum made here. */}
          {chip("unread", filters.status === "unread", "Unread", () => toggleStatus("unread"), { count: counts ? unread : undefined })}
          {chip("read", filters.status === "read", "Read", () => toggleStatus("read"))}
        </div>
        <div className="nf-group" role="group" aria-label="Type">
          {(["ask", "page", "flag", "note"] as const).map((v) => chip(v, filters.level === v, LEVEL_PLURAL[v], () => toggleLevel(v), { count: counts?.level[v], amber: v === "ask", title: TYPE_TITLE[v] }))}
          <button type="button" className="nf-help" aria-expanded={help} aria-controls={LEGEND_ID} aria-label="What the types mean" onClick={() => setHelp(!help)} onFocus={reveal}>
            ?
          </button>
        </div>
        {!hideCompanies && (
          <div className="nf-group" role="group" aria-label="Company">
            {many ? (
              <label className="chip nf nf-select" data-on={filters.company !== "all"}>
                <span className="nf-name">Company</span>
                <select aria-label="Company" value={filters.company} onChange={(e) => set({ company: e.target.value })}>
                  <option value="all">All companies</option>
                  {sorted.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  <option disabled>──────────</option>
                  <option value={NO_COMPANY}>No company</option>
                </select>
              </label>
            ) : (
              <>
                {sorted.map((c) => chip(c.id, filters.company === c.id, c.name, () => toggleCompany(c.id), { count: counts?.company[c.id], title: c.name }))}
                {showNone && chip(NO_COMPANY, filters.company === NO_COMPANY, "No company", () => toggleCompany(NO_COMPANY), { count: counts?.company[NO_COMPANY] })}
              </>
            )}
          </div>
        )}
      </div>
      <p id={LEGEND_ID} className="nf-legend muted" hidden={!help}>
        <strong>Asks</strong> need your answer. <strong>Pages</strong> are urgent and also go to your phone. <strong>Flags</strong> also show as a browser notification. <strong>Notes</strong> stay in this list. The numbers count unread ones.
      </p>
    </div>
  );
}

export function Notifications({ feed, onChanged, companies = null, browserPermission, onEnableBrowser }: { feed: NoticeFeed | null; onChanged: () => void; companies?: Company[] | null; browserPermission?: NotificationPermission | "unsupported"; onEnableBrowser?: () => void }) {
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
  const active = filters.status !== "all" || filters.level !== "all" || filters.company !== "all" || filters.text !== "";

  const query = new URLSearchParams();
  if (filters.status !== "all") query.set("status", filters.status);
  if (filters.level !== "all") query.set("level", filters.level);
  if (filters.company !== "all") query.set("company", filters.company);
  if (filters.text) query.set("q", filters.text);
  const qs = query.toString();
  // With a filter on the page polls its own list, so older notices and new arrivals are matched by the server.
  const filtered = usePoll((signal) => (qs ? api<NoticeFeed>(`/api/notifications?${qs}`, { signal }) : Promise.resolve(null)), 10_000, `notifications-${qs}`);
  const last = useRef<Notice[]>([]);
  const loaded = active ? filtered.data?.items : feed?.items;
  if (loaded) last.current = loaded;
  const firstPage = loaded ?? (active ? last.current : []);
  // "Show older" (BOS-2276): the server pages by date, so look up the oldest shown row's time; a new filter starts again.
  const dates = useRef(new Map<string, string>());
  const older = useOlder(
    firstPage,
    NOTICE_PAGE,
    (id) => {
      const q = new URLSearchParams(qs);
      q.set("limit", String(NOTICE_PAGE));
      q.set("before", dates.current.get(id) ?? "");
      return api<NoticeFeed>(`/api/notifications?${q.toString()}`).then((r) => r.items);
    },
    qs,
  );
  const items = older.rows ?? firstPage;
  for (const n of items) dates.current.set(n.id, n.createdAt);
  const updating = active && !filtered.data && !filtered.error;

  const reload = () => {
    onChanged();
    filtered.reload();
  };
  const read = (body: { ids: string[] } | { all: true }) => void api("/api/notifications/read", { method: "POST", body }).then(reload, (err: Error) => setError(err.message));
  const unreadShown = items.filter((n) => !n.readAt);
  const clear = () => setFilters(NO_FILTERS);

  const summary = updating ? "Updating…" : `${older.canMore ? "Latest " : ""}${items.length} shown`;
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
      {/* (BOS-1506) This button used to sit in the side menu; it shows here until the owner turns notifications on. */}
      {browserPermission === "default" && onEnableBrowser && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", margin: "0 0 12px" }}>
          <button className="btn" type="button" onClick={onEnableBrowser}>
            Turn on browser notifications
          </button>
          <span className="muted">Shows flags, pages and asks while Boss Man is open in a background tab.</span>
        </div>
      )}
      {browserPermission === "denied" && <p className="muted">Notifications are blocked in this browser.</p>}
      <p style={{ margin: "0 0 12px" }}>
        <a href="#/settings/notifications">Notification settings</a>
      </p>
      {error && <p className="error">{error}</p>}
      {!neverAny && <FilterBar filters={filters} companies={companies ?? []} counts={feed?.counts} unread={feed?.unread} set={setFilters} />}
      {active && (
        <div role="status" className="nf-summary">
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
      {!updating && <ShowOlder older={older} />}
    </>
  );
}
