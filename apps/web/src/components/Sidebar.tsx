// The sidebar (R72, R75): the company switcher at the top, then the screens in groups. Every
// company screen shows the chosen company. On a phone the groups fold away behind Menu.
import { useState, type FormEvent } from "react";
import type { Company, Decision } from "../api";
import { Activity, BookOpen, FolderGit2, Bell, Gavel, Handshake, KeyRound, Kanban, LayoutDashboard, ListChecks, Map, MessageCircle, MessageSquare, Puzzle, Scale, Settings, Sparkles, Star, Users, Wallet, type LucideIcon } from "lucide-react";
import { art } from "../brand";

type Item = { id: string; label: string; icon: LucideIcon };
const GROUPS: Array<{ title: string; items: Item[] }> = [
  {
    title: "Overview",
    items: [
      { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
      { id: "decisions", label: "Decisions", icon: Gavel },
      { id: "notifications", label: "Notifications", icon: Bell },
      { id: "chat", label: "Chat", icon: MessageSquare },
    ],
  },
  {
    title: "Work",
    items: [
      { id: "projects", label: "Projects", icon: FolderGit2 },
      { id: "board", label: "Kanban", icon: Kanban },
      { id: "roadmap", label: "Roadmap", icon: Map },
      { id: "plan", label: "Plan", icon: ListChecks },
      { id: "wiki", label: "Wiki", icon: BookOpen },
      { id: "features", label: "Features", icon: Sparkles },
      { id: "feedback", label: "Feedback", icon: MessageCircle },
    ],
  },
  {
    title: "Company",
    items: [
      { id: "agents", label: "Agents", icon: Users },
      { id: "skills", label: "Skills", icon: Puzzle },
      { id: "runs", label: "Runs", icon: Activity },
      { id: "engagements", label: "Engagements", icon: Handshake },
      { id: "funding", label: "Funding", icon: Wallet },
      { id: "rules", label: "Rules", icon: Scale },
      { id: "secrets", label: "Secrets", icon: KeyRound },
      { id: "settings", label: "Settings", icon: Settings },
    ],
  },
];

function CompanySwitcher({ companies, current, waiting, onPick, onCreate }: { companies: Company[]; current: Company | undefined; waiting: (id: string) => number; onPick: (id: string) => void; onCreate: (name: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const status = (c: Company) => {
    const n = waiting(c.id);
    return c.paused ? (["#5e6878", "Paused"] as const) : n ? (["#f0b75c", `${n} waiting on you`] as const) : (["#7fd3a5", `${c.agents.length} agent${c.agents.length === 1 ? "" : "s"}`] as const);
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate(name.trim()).then(
      () => (setName(""), setAdding(false), setOpen(false), setError(null)),
      (err: Error) => setError(err.message),
    );
  };
  if (!current) return null;
  const [colour, note] = status(current);
  return (
    <div className="switcher">
      <button type="button" className="switcher-button" aria-expanded={open} aria-controls="company-menu" onClick={() => setOpen((o) => !o)}>
        <span className="dot" style={{ background: colour }} aria-hidden="true" />
        <span className="switcher-name">
          {current.name}
          <small>{note}</small>
        </span>
        <span aria-hidden="true">▾</span>
        <span className="sr-only">Switch company</span>
      </button>
      {open && (
        <div id="company-menu" className="switcher-menu">
          <ul aria-label="Companies">
            {companies.map((c) => {
              const [col, n] = status(c);
              return (
                <li key={c.id}>
                  <button type="button" aria-current={c.id === current.id ? "true" : undefined} onClick={() => (onPick(c.id), setOpen(false))}>
                    <span className="dot" style={{ background: col }} aria-hidden="true" />
                    <span className="switcher-name">
                      {c.name}
                      <small>{n}</small>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {adding ? (
            <form onSubmit={create} className="switcher-new">
              <label htmlFor="new-company" className="sr-only">
                New company name
              </label>
              <input id="new-company" autoFocus maxLength={80} placeholder="Company name" value={name} onChange={(e) => setName(e.target.value)} />
              <button type="submit" disabled={!name.trim()}>
                Create
              </button>
              {error && <small role="alert">{error}</small>}
            </form>
          ) : (
            <button type="button" className="switcher-add" onClick={() => setAdding(true)}>
              + New company
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar(props: {
  active: string;
  activeAgent?: string;
  companies: Company[];
  current: Company | undefined;
  decisions: Decision[];
  unread: number;
  feedback: number;
  notifications: NotificationPermission | "unsupported";
  onPickCompany: (id: string) => void;
  onCreateCompany: (name: string) => Promise<void>;
  onEnableNotifications: () => void;
  onLogout: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const starred = props.current?.agents.filter((a) => a.starred) ?? [];
  const waiting = (companyId: string) => props.decisions.filter((d) => d.companyId === companyId).length;
  const decisionsHere = props.current ? waiting(props.current.id) : props.decisions.length;
  const label = GROUPS.flatMap((g) => g.items).find((i) => i.id === props.active || (props.active === "tickets" && i.id === "board"))?.label ?? "Menu";
  return (
    <nav className="side" aria-label="Main">
      <div className="brand">
        <img src={art.mark64} alt="" />
        <span>Boss Man</span>
      </div>
      <CompanySwitcher companies={props.companies} current={props.current} waiting={waiting} onPick={props.onPickCompany} onCreate={props.onCreateCompany} />
      <button type="button" className="menu-toggle" aria-expanded={menu} aria-controls="nav-groups" onClick={() => setMenu((m) => !m)}>
        {menu ? "Close menu" : `Menu · ${label}`}
      </button>
      <div id="nav-groups" className={`nav-groups${menu ? " open" : ""}`}>
        {GROUPS.map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h2>{g.title}</h2>
            <ul>
              {g.items.map((n) => (
                <li key={n.id}>
                  <a className="nav" href={`#/${n.id}`} onClick={() => setMenu(false)} aria-current={props.active === n.id || (props.active === "tickets" && n.id === "board") ? "page" : undefined}>
                    <n.icon size={18} strokeWidth={1.75} aria-hidden="true" />
                    <span className="nav-label">{n.label}</span>
                    {n.id === "decisions" && decisionsHere > 0 && <span className="count" aria-label={`${decisionsHere} waiting`}>{decisionsHere}</span>}
                    {n.id === "feedback" && props.feedback > 0 && <span className="count" aria-label={`${props.feedback} to process`}>{props.feedback}</span>}
                    {n.id === "notifications" && props.unread > 0 && <span className="count" aria-label={`${props.unread} unread`}>{props.unread}</span>}
                  </a>
                  {n.id === "chat" && starred.length > 0 && (
                    <ul className="sub-nav" aria-label="Starred agents">
                      {starred.map((a) => (
                        <li key={a.id}>
                          <a className="nav" href={`#/chat/${a.companyId}/${a.id}`} onClick={() => setMenu(false)} aria-current={props.active === "chat" && props.activeAgent === a.id ? "page" : undefined}>
                            <Star size={14} strokeWidth={1.75} aria-hidden="true" />
                            <span className="nav-label">{a.name}</span>
                          </a>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="foot">
        {props.notifications === "default" && (
          <button type="button" onClick={props.onEnableNotifications}>
            Turn on browser notifications
          </button>
        )}
        {props.notifications === "denied" && <small style={{ color: "var(--side-muted)" }}>Notifications are blocked in this browser.</small>}
        <button type="button" onClick={props.onLogout}>
          Log out
        </button>
      </div>
    </nav>
  );
}
