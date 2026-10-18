// The sidebar (R72, R75): the company switcher at the top, then the screens in groups. Every
// company screen shows the chosen company. On a phone the groups fold away behind Menu.
import { useState, type FormEvent } from "react";
import type { Company, Decision } from "../api";
import { art } from "../brand";

type Item = { id: string; label: string };
const GROUPS: Array<{ title: string | null; items: Item[] }> = [
  {
    title: null,
    items: [
      { id: "dashboard", label: "Dashboard" },
      { id: "decisions", label: "Decisions" },
      { id: "notifications", label: "Notifications" },
      { id: "chat", label: "Chat" },
    ],
  },
  {
    title: "Work",
    items: [
      { id: "board", label: "Kanban" },
      { id: "roadmap", label: "Roadmap" },
      { id: "plan", label: "Plan" },
      { id: "wiki", label: "Wiki" },
      { id: "features", label: "Features" },
      { id: "feedback", label: "Feedback" },
    ],
  },
  {
    title: "Company",
    items: [
      { id: "agents", label: "Agents" },
      { id: "skills", label: "Skills" },
      { id: "runs", label: "Runs" },
      { id: "engagements", label: "Engagements" },
      { id: "funding", label: "Funding" },
      { id: "rules", label: "Rules" },
      { id: "secrets", label: "Secrets" },
      { id: "settings", label: "Settings" },
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
          <section key={g.title ?? "top"} aria-label={g.title ?? "Overview"}>
            {g.title && <h2>{g.title}</h2>}
            <ul>
              {g.items.map((n) => (
                <li key={n.id}>
                  <a className="nav" href={`#/${n.id}`} onClick={() => setMenu(false)} aria-current={props.active === n.id || (props.active === "tickets" && n.id === "board") ? "page" : undefined}>
                    <span>{n.label}</span>
                    {n.id === "decisions" && decisionsHere > 0 && <span className="count" aria-label={`${decisionsHere} waiting`}>{decisionsHere}</span>}
                    {n.id === "feedback" && props.feedback > 0 && <span className="count" aria-label={`${props.feedback} to process`}>{props.feedback}</span>}
                    {n.id === "notifications" && props.unread > 0 && <span className="count" aria-label={`${props.unread} unread`}>{props.unread}</span>}
                  </a>
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
