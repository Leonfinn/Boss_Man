// The sidebar (R72, R75): the company switcher at the top, then the screens in groups. Every
// company screen shows the chosen company. On a phone the groups fold away behind Menu.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { figureText } from "@boss-man/shared";
import type { Company, Decision } from "../api";
import { useMediaQuery } from "../hooks";
import { usePinned } from "../pinned-pages";
import { SHORTCUT_ICONS } from "../shortcut-icons";
import { CircleHelp, Pencil, TriangleAlert } from "lucide-react";
import { Activity, BookOpen, ChevronDown, ChevronRight, ChevronsLeft, ChevronsRight, FolderGit2, Bell, GitMerge, Gavel, Handshake, Keyboard, LayoutDashboard, ListChecks, LogOut, Map, Menu as MenuIcon, MessageCircle, MessageSquare, Puzzle, Settings, ShieldCheck, Sparkles, Star, Users, Workflow as WorkflowIcon, type LucideIcon } from "lucide-react";
import { art } from "../brand";
import { SearchButton } from "./SearchPalette";
import { SHOW_SHORTCUTS_EVENT, linkTitle } from "../shortcut-list";

/**
 * R43: a per-company server figure (feedback.toProcess) for the chosen company, the one its own page shows. The
 * Feedback badge used to add up every company's, so it read higher than the Unprocessed tab beside it.
 */
export function companyFigure(byCompany: Record<string, number> | null | undefined, companyId: string | undefined): number {
  return companyId ? (byCompany?.[companyId] ?? 0) : 0;
}

type Item = { id: string; label: string; icon: LucideIcon };
type Group = { group: string; label: string; icon: LucideIcon; items: Item[] };
type Entry = Item | Group;
const isGroup = (e: Entry): e is Group => "group" in e;
// (BOS-1506) About ten rows in three blocks (thin lines between them, no headings); Product, Team and
// Activity hold the rest, one level only (BOS-1018). Settings and Log out are pinned below the list.
const BLOCKS: Entry[][] = [
  [
    { id: "dashboard", label: "Dashboard", icon: LayoutDashboard },
    { id: "decisions", label: "Decisions", icon: Gavel },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "chat", label: "Chat", icon: MessageSquare },
  ],
  [
    { id: "projects", label: "Projects", icon: FolderGit2 },
    {
      group: "product",
      label: "Product",
      icon: Sparkles,
      items: [
        { id: "roadmap", label: "Roadmap", icon: Map },
        { id: "features", label: "Features", icon: Sparkles },
        { id: "feedback", label: "Feedback", icon: MessageCircle },
        { id: "plan", label: "Plan", icon: ListChecks },
      ],
    },
    { id: "merge-queue", label: "Merge queue", icon: GitMerge },
    { id: "wiki", label: "Wiki", icon: BookOpen },
  ],
  [
    {
      group: "team",
      label: "Team",
      icon: Users,
      items: [
        { id: "agents", label: "Agents", icon: Users },
        { id: "skills", label: "Skills", icon: Puzzle },
        { id: "engagements", label: "Engagements", icon: Handshake },
      ],
    },
    {
      group: "activity",
      label: "Activity",
      icon: Activity,
      items: [
        { id: "runs", label: "Runs", icon: Activity },
        { id: "scrum-master", label: "Scrum Master log", icon: ShieldCheck },
        { id: "workflow", label: "Workflow report", icon: WorkflowIcon },
      ],
    },
  ],
];
const SETTINGS: Item = { id: "settings", label: "Settings", icon: Settings };
const ALL_ITEMS: Item[] = [...BLOCKS.flat().flatMap((e) => (isGroup(e) ? e.items : [e])), SETTINGS];
const GROUP_IDS = BLOCKS.flat().filter(isGroup).map((g) => g.group);

// Which groups are unfolded in place is remembered on this device. Nothing saved: all open on a
// window with room, all folded on a phone (its Menu sheet opens short).
const OPEN_KEY = "bm-side-groups";
function readOpen(phone: boolean): string[] {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "null");
    if (Array.isArray(saved)) return saved.filter((x): x is string => typeof x === "string");
  } catch {
    /* storage blocked or unreadable: fall back to the default */
  }
  return phone ? [] : GROUP_IDS;
}

function CompanySwitcher({ companies, current, waiting, onPick, onCreate }: { companies: Company[]; current: Company | undefined; waiting: (id: string) => number; onPick: (id: string) => void; onCreate: (name: string) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const status = (c: Company) => {
    const n = waiting(c.id);
    return c.paused ? (["#5e6878", "Paused"] as const) : n ? (["#f0b75c", figureText("decisions.needYou", n)] as const) : (["#7fd3a5", `${c.agents.length} agent${c.agents.length === 1 ? "" : "s"}`] as const);
  };
  const create = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || creating) return;
    setCreating(true);
    onCreate(name.trim()).then(
      () => (setName(""), setAdding(false), setOpen(false), setError(null)),
      (err: Error) => setError(err.message),
    ).finally(() => setCreating(false));
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
              <button type="submit" disabled={!name.trim() || creating}>
                {creating ? "Creating…" : "Create"}
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
  /** The address parts on screen (e.g. ["settings", "c1", "updates"]), to mark the shortcut that is open. */
  route?: string[];
  activeAgent?: string;
  activeProject?: string;
  companies: Company[];
  current: Company | undefined;
  decisions: Decision[];
  /** (BOS-969) What needs the owner now, from the same server figure the Decisions page heading shows. */
  decisionsTally?: { open: number; waiting: number } | null;
  /** (BOS-1485) The same tally for every company, for the company switcher. */
  companyTallies?: Record<string, { open: number; waiting: number }>;
  unread: number;
  feedback: number;
  /** BOS-2819: false for a company with no code project: no Merge queue row. Absent means true. */
  hasCode?: boolean;
  mergeWaiting: number;
  mergeStuck: number;
  /** Kept for the callers; the browser-notifications button now sits on the Notifications page (BOS-1506). */
  notifications?: NotificationPermission | "unsupported";
  collapsed: boolean;
  narrow: boolean;
  onToggleCollapsed: () => void;
  onPickCompany: (id: string) => void;
  onCreateCompany: (name: string) => Promise<void>;
  onEnableNotifications?: () => void;
  onLogout: () => void;
}) {
  const [menu, setMenu] = useState(false);
  const nav = useRef<HTMLElement>(null);
  // (BOS-1506) Where a group's pages go: in place (a phone's Menu sheet, a window with room) or in a
  // small panel beside the row (the icon strip, or a window too short to unfold them: 1667x724).
  const phone = useMediaQuery("(max-width: 640px)");
  const short = useMediaQuery("(min-width: 641px) and (max-height: 860px)");
  const panelMode = !phone && (props.collapsed || short);
  const [openGroups, setOpenGroups] = useState<string[]>(() => readOpen(phone));
  const [panel, setPanel] = useState<{ id: string; top: number; left: number } | null>(null);
  const toggleGroup = (id: string, button: HTMLElement, rows: number) => {
    if (panelMode) {
      const r = button.getBoundingClientRect();
      // Lined up with its row, but moved up when it would run off the bottom of the window (title + rows + padding).
      const height = 44 + rows * 44 + 16;
      setPanel((p) => (p?.id === id ? null : { id, top: Math.max(8, Math.min(r.top, window.innerHeight - height - 8)), left: r.right + 8 }));
      return;
    }
    setOpenGroups((cur) => {
      const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
      try {
        localStorage.setItem(OPEN_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked: the choice lasts until the page reloads */
      }
      return next;
    });
  };
  // On a narrow screen an expanded menu covers the page, so it folds away once a page is chosen.
  const closeIfNarrow = () => {
    setMenu(false);
    setPanel(null);
    if (props.narrow && !props.collapsed) props.onToggleCollapsed();
  };
  useEffect(() => {
    if (!panelMode) setPanel(null);
  }, [panelMode]);
  useEffect(() => {
    if (!panel) return;
    const onDown = (e: MouseEvent) => {
      if (!(e.target as Element).closest?.(".side-panel, .nav-group-row")) setPanel(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPanel(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [panel]);
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
  // (BOS-1485) Each company's figure in the switcher is the server's tally for that company (the badge's
  // own figure); until it arrives, cards not in the "Waiting, nothing to do yet" group stand in.
  const waiting = (companyId: string) => props.companyTallies?.[companyId]?.open ?? props.decisions.filter((d) => d.companyId === companyId && !d.waiting).length;
  // (BOS-969) The top company's badge is the server's "needs you now" figure, not every open card:
  // with one company, what it shows is exactly the Decisions page's "to do". Without it, cards not in
  // the "Waiting, nothing to do yet" group stand in, so it is never the inflated number.
  const needsOwner = props.decisions.filter((d) => !d.waiting).filter((d) => !props.current || d.companyId === props.current.id).length;
  const badgeCount = props.decisionsTally ? props.decisionsTally.open : needsOwner;
  const isCurrent = (id: string) => props.active === id || ((props.active === "tickets" || props.active === "board") && id === "projects");
  const label = ALL_ITEMS.find((i) => isCurrent(i.id))?.label ?? "Menu";
  // R43 (BOS-1716): every badge's words come from the one label list (@boss-man/shared owner-figures), so the
  // badge reads exactly as the page, banner and dashboard write the same figure.
  const badge = (n: Item) =>
    n.id === "decisions" && badgeCount > 0 ? { value: badgeCount, label: `${figureText("decisions.needYou", badgeCount)}${props.decisionsTally && props.decisionsTally.waiting > 0 ? `, ${figureText("decisions.withTeam", props.decisionsTally.waiting)}` : ""}` } : n.id === "feedback" && props.feedback > 0 ? { value: props.feedback, label: figureText("feedback.toProcess", props.feedback) } : n.id === "merge-queue" && props.mergeStuck > 0 ? { value: props.mergeStuck, label: figureText("mergeQueue.lineStuck", props.mergeStuck), warn: true } : n.id === "merge-queue" && props.mergeWaiting > 0 ? { value: props.mergeWaiting, label: figureText("mergeQueue.inLine", props.mergeWaiting) } : n.id === "notifications" && props.unread > 0 ? { value: props.unread, label: figureText("notifications.unread", props.unread) } : null;
  // BOS-2669: the owner's pinned pages. None pinned (or no provider, as in a bare menu): no section at all.
  const pinned = usePinned();
  const shortcutRows = pinned?.entries ?? [];
  const hash = `#/${(props.route ?? []).join("/")}`;
  const itemLink = (n: Item) => {
    const b = badge(n);
    return (
      <a className="nav" href={`#/${n.id}`} onClick={closeIfNarrow} title={linkTitle(n.id, n.label)} aria-current={isCurrent(n.id) ? "page" : undefined}>
        <n.icon size={18} strokeWidth={1.75} aria-hidden="true" />
        <span className="nav-label">{n.label}</span>
        {b && <span className={`count${b.warn ? " warn" : ""}`} aria-label={b.label}>{b.value}</span>}
        {b && <span className={`count-dot${b.warn ? " warn" : ""}`} aria-hidden="true" />}
      </a>
    );
  };
  return (
    <nav ref={nav} className={`side${props.collapsed ? " collapsed" : ""}`} aria-label="Main">
      <div className="brand">
        <img src={art.mark64} alt="" />
        <span>Boss Man</span>
        {/* The strip/expanded switch, beside the name (BOS-1506). Hidden on a phone, which keeps its Menu button. */}
        <button type="button" className="side-collapse" aria-expanded={!props.collapsed} aria-controls="nav-groups" aria-label={props.collapsed ? "Expand menu" : "Collapse menu"} title={props.collapsed ? "Expand menu" : "Collapse menu"} onClick={props.onToggleCollapsed}>
          {props.collapsed ? <ChevronsRight size={18} strokeWidth={1.75} aria-hidden="true" /> : <ChevronsLeft size={18} strokeWidth={1.75} aria-hidden="true" />}
        </button>
      </div>
      <div className="side-bar">
        <CompanySwitcher companies={props.companies} current={props.current} waiting={waiting} onPick={props.onPickCompany} onCreate={props.onCreateCompany} />
        <button type="button" className="menu-toggle" aria-expanded={menu} aria-controls="nav-groups" onClick={() => setMenu((m) => !m)}>
          <MenuIcon size={20} strokeWidth={1.75} aria-hidden="true" />
          <span className="sr-only">{menu ? "Close menu" : `Menu, ${label}`}</span>
        </button>
        {/* BOS-2192: opens the search box, for touch screens with no Ctrl+K. */}
        <SearchButton />
      </div>
      <div id="nav-groups" className={`nav-groups${menu ? " open" : ""}`}>
        <div className="nav-scroll">
        {shortcutRows.length > 0 && (
          <section className="side-shortcuts" aria-label="Shortcuts">
            <div className="side-shortcuts-head">
              <p className="side-shortcuts-title">Shortcuts</p>
              {pinned && (
                <button type="button" className="side-shortcuts-edit" data-edit-shortcuts aria-label="Edit shortcuts" onClick={() => pinned.openEditor()}>
                  <Pencil size={13} strokeWidth={1.75} aria-hidden="true" />
                  <span>Edit</span>
                </button>
              )}
            </div>
            <ul>
              {shortcutRows.map((e) => {
                const Icon = e.gone ? TriangleAlert : (SHORTCUT_ICONS[e.icon] ?? CircleHelp);
                const here = e.gone ? hash === `#/shortcut-gone/${e.id}` : hash === e.address;
                return (
                  <li key={e.id}>
                    <a className={`nav${pinned?.justAdded === e.id ? " just-added" : ""}${e.gone ? " gone" : ""}`} href={e.gone ? `#/shortcut-gone/${e.id}` : e.address} onClick={closeIfNarrow} title={e.gone ? `${e.name}: page no longer exists` : `Opens ${e.path}`} aria-current={here ? "page" : undefined}>
                      <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
                      <span className="nav-label">
                        {e.name}
                        {e.gone && <small className="nav-here">Page no longer exists</small>}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {BLOCKS.map((block, bi) => (
          <section key={bi} aria-label={["Overview", "Work", "Company"][bi]}>
            <ul>
              {block.filter((entry) => props.hasCode !== false || isGroup(entry) || entry.id !== "merge-queue").map((entry) => {
                if (isGroup(entry)) {
                  const open = !panelMode && openGroups.includes(entry.group);
                  const shown = panelMode && panel?.id === entry.group;
                  const here = entry.items.find((i) => isCurrent(i.id));
                  const bs = entry.items.map(badge).filter((x): x is NonNullable<ReturnType<typeof badge>> => !!x);
                  const total = bs.reduce((s, x) => s + x.value, 0);
                  const gb = bs.length ? { value: total, label: bs.map((x) => x.label).join(", "), warn: bs.some((x) => x.warn) } : null;
                  const links = (
                    <ul aria-label={`${entry.label} pages`}>
                      {entry.items.map((n) => (
                        <li key={n.id}>{itemLink(n)}</li>
                      ))}
                    </ul>
                  );
                  return (
                    <li key={entry.group} className="nav-group">
                      <button type="button" className="nav nav-group-row" aria-expanded={open || shown} aria-controls={`nav-group-${entry.group}`} title={entry.label} data-here={here && !open ? "true" : undefined} onClick={(e) => toggleGroup(entry.group, e.currentTarget, entry.items.length)}>
                        <entry.icon size={18} strokeWidth={1.75} aria-hidden="true" />
                        <span className="nav-label">
                          {entry.label}
                          {here && !open && <small className="nav-here">{here.label}</small>}
                        </span>
                        {gb && !open && <span className={`count${gb.warn ? " warn" : ""}`} aria-label={gb.label}>{gb.value}</span>}
                        {gb && !open && <span className={`count-dot${gb.warn ? " warn" : ""}`} aria-hidden="true" />}
                        {open ? <ChevronDown className="nav-chev" size={16} strokeWidth={1.75} aria-hidden="true" /> : <ChevronRight className="nav-chev" size={16} strokeWidth={1.75} aria-hidden="true" />}
                      </button>
                      {open && <div id={`nav-group-${entry.group}`} className="nav-group-pages">{links}</div>}
                      {shown && (
                        <div id={`nav-group-${entry.group}`} className="side-panel" role="group" aria-label={entry.label} style={{ top: panel!.top, left: panel!.left }}>
                          <p className="side-panel-title">{entry.label}</p>
                          {links}
                        </div>
                      )}
                    </li>
                  );
                }
                const n = entry;
                return (
                  <li key={n.id}>
                    {itemLink(n)}
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
        </div>
        {/* Pinned below the list, so Settings and Log out are in view without scrolling. On a phone they sit inside the folded menu, so the header stays one row. */}
        <div className="side-pinned foot">
          {itemLink(SETTINGS)}
          {/* BOS-2688: opens the "?" list for people who never press "?". Hidden on a phone (styles.css). */}
          <button type="button" className="shortcuts-button" onClick={() => window.dispatchEvent(new Event(SHOW_SHORTCUTS_EVENT))} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
            <Keyboard size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button type="button" className="logout" onClick={props.onLogout} title="Log out" aria-label="Log out">
            <LogOut size={18} strokeWidth={1.75} aria-hidden="true" className="logout-icon" />
            <span className="label-full">Log out</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
