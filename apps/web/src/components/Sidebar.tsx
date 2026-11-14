// The sidebar (R72, R75): the company switcher at the top, then the screens in groups. Every
// company screen shows the chosen company. On a phone the groups fold away behind Menu.
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Company, Decision } from "../api";
import { Activity, BookOpen, ChevronsLeft, ChevronsRight, FolderGit2, Bell, GitMerge, Gavel, Handshake, LayoutDashboard, ListChecks, LogOut, Map, Menu as MenuIcon, MessageCircle, MessageSquare, Puzzle, Settings, ShieldCheck, Sparkles, Star, Users, Workflow as WorkflowIcon, type LucideIcon } from "lucide-react";
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
      { id: "roadmap", label: "Roadmap", icon: Map },
      { id: "merge-queue", label: "Merge queue", icon: GitMerge },
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
      { id: "scrum-master", label: "Scrum Master log", icon: ShieldCheck },
      { id: "workflow", label: "Workflow report", icon: WorkflowIcon },
      { id: "engagements", label: "Engagements", icon: Handshake },
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

/**
 * The side menu is an icon-only strip when `collapsed` (BOS-290). The choice is kept on the
 * device by App. On a narrow screen (phone, foldable, tablet) expanding opens it over the page
 * and it closes again after choosing a page or tapping outside, so the page keeps its width.
 */
export function Sidebar(props: {
  active: string;
  activeAgent?: string;
  activeProject?: string;
  companies: Company[];
  current: Company | undefined;
  decisions: Decision[];
  /** (BOS-969) What needs the owner now, from the same server figure the Decisions page heading shows. */
  decisionsTally?: { open: number; waiting: number } | null;
  unread: number;
  feedback: number;
  mergeWaiting: number;
  mergeStuck: number;
  notifications: NotificationPermission | "unsupported";
  collapsed: boolean;
  narrow: boolean;
  onToggleCollapsed: () => void;
  onPickCompany: (id: string) => void;
  onCreateCompany: (name: string) => Promise<void>;
  onEnableNotifications: () => void;
  onLogout: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const nav = useRef<HTMLElement>(null);
  // On a narrow screen an expanded menu covers the page, so it folds away once a page is chosen.
  const closeIfNarrow = () => {
    setMenu(false);
    if (props.narrow && !props.collapsed) props.onToggleCollapsed();
  };
  useEffect(() => {
    if (!props.narrow || props.collapsed || !nav.current) return;
    const onDown = (e: MouseEvent) => {
      if (!nav.current!.contains(e.target as Node)) props.onToggleCollapsed();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onToggleCollapsed();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [props.narrow, props.collapsed, props.onToggleCollapsed]);
  const starred = props.current?.agents.filter((a) => a.starred) ?? [];
  const starredProjects = props.current?.projects?.filter((p) => p.starred) ?? [];
  const waiting = (companyId: string) => props.decisions.filter((d) => d.companyId === companyId).length;
  // (BOS-969) The top company's badge is the server's "needs you now" figure, not every open card:
  // with one company, what it shows is exactly the Decisions page's "to do". Without it, cards not in
  // the "Waiting, nothing to do yet" group stand in, so it is never the inflated number.
  const needsOwner = props.decisions.filter((d) => !d.waiting).filter((d) => !props.current || d.companyId === props.current.id).length;
  const badgeCount = props.decisionsTally ? props.decisionsTally.open : needsOwner;
  const label = GROUPS.flatMap((g) => g.items).find((i) => i.id === props.active || ((props.active === "tickets" || props.active === "board") && i.id === "projects"))?.label ?? "Menu";
  const isCurrent = (id: string) => props.active === id || ((props.active === "tickets" || props.active === "board") && id === "projects");
  const badge = (n: Item) =>
    n.id === "decisions" && badgeCount > 0 ? { value: badgeCount, label: `${badgeCount} waiting` } : n.id === "feedback" && props.feedback > 0 ? { value: props.feedback, label: `${props.feedback} to process` } : n.id === "merge-queue" && props.mergeStuck > 0 ? { value: props.mergeStuck, label: `${props.mergeStuck} stuck`, warn: true } : n.id === "merge-queue" && props.mergeWaiting > 0 ? { value: props.mergeWaiting, label: `${props.mergeWaiting} waiting to merge` } : n.id === "notifications" && props.unread > 0 ? { value: props.unread, label: `${props.unread} unread` } : null;
  return (
    <nav ref={nav} className={`side${props.collapsed ? " collapsed" : ""}`} aria-label="Main">
      <div className="brand">
        <img src={art.mark64} alt="" />
        <span>Boss Man</span>
      </div>
      <div className="side-bar">
        <CompanySwitcher companies={props.companies} current={props.current} waiting={waiting} onPick={props.onPickCompany} onCreate={props.onCreateCompany} />
        <button type="button" className="menu-toggle" aria-expanded={menu} aria-controls="nav-groups" onClick={() => setMenu((m) => !m)}>
          <MenuIcon size={20} strokeWidth={1.75} aria-hidden="true" />
          <span className="sr-only">{menu ? "Close menu" : `Menu, ${label}`}</span>
        </button>
        {/* The strip/expanded switch. Hidden on a phone, which keeps its Menu button above. */}
        <button type="button" className="side-collapse" aria-expanded={!props.collapsed} aria-controls="nav-groups" aria-label={props.collapsed ? "Expand menu" : "Collapse menu"} title={props.collapsed ? "Expand menu" : "Collapse menu"} onClick={props.onToggleCollapsed}>
          {props.collapsed ? <ChevronsRight size={18} strokeWidth={1.75} aria-hidden="true" /> : <ChevronsLeft size={18} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      </div>
      <div id="nav-groups" className={`nav-groups${menu ? " open" : ""}`}>
        {GROUPS.map((g) => (
          <section key={g.title} aria-label={g.title}>
            <h2>{g.title}</h2>
            <ul>
              {g.items.map((n) => {
                const b = badge(n);
                return (
                  <li key={n.id}>
                    <a className="nav" href={`#/${n.id}`} onClick={closeIfNarrow} title={n.label} aria-current={isCurrent(n.id) ? "page" : undefined}>
                      <n.icon size={18} strokeWidth={1.75} aria-hidden="true" />
                      <span className="nav-label">{n.label}</span>
                      {b && <span className={`count${b.warn ? " warn" : ""}`} aria-label={b.label}>{b.value}</span>}
                      {b && <span className={`count-dot${b.warn ? " warn" : ""}`} aria-hidden="true" />}
                    </a>
                    {n.id === "chat" && starred.length > 0 && (
                      <ul className="sub-nav" aria-label="Starred agents">
                        {starred.map((a) => (
                          <li key={a.id}>
                            <a className="nav" href={`#/chat/${a.companyId}/${a.id}`} onClick={closeIfNarrow} aria-current={props.active === "chat" && props.activeAgent === a.id ? "page" : undefined}>
                              <Star size={14} strokeWidth={1.75} aria-hidden="true" />
                              <span className="nav-label">{a.name}</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                    {n.id === "projects" && starredProjects.length > 0 && (
                      <ul className="sub-nav" aria-label="Starred projects">
                        {starredProjects.map((p) => (
                          <li key={p.id}>
                            <a className="nav" href={`#/board/${p.id}`} onClick={closeIfNarrow} aria-current={props.active === "board" && props.activeProject === p.id ? "page" : undefined}>
                              <Star size={14} strokeWidth={1.75} aria-hidden="true" />
                              <span className="nav-label">{p.name}</span>
                            </a>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
        {/* On a phone these sit inside the folded menu, so the header stays one row. */}
        <div className="foot">
          {props.notifications === "default" && (
            <button type="button" onClick={props.onEnableNotifications} title="Turn on browser notifications">
              <span className="label-full">Turn on browser notifications</span>
            </button>
          )}
          {props.notifications === "denied" && <small style={{ color: "var(--side-muted)" }}>Notifications are blocked in this browser.</small>}
          <button type="button" className="logout" onClick={props.onLogout} title="Log out" aria-label="Log out">
            <LogOut size={18} strokeWidth={1.75} aria-hidden="true" className="logout-icon" />
            <span className="label-full">Log out</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
