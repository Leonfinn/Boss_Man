import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { api, ApiError, type ActiveRun, type Company, type Decision, type NoticeFeed, type TeamAlert, type AdvisedDecision, type ClosedNoticeCard } from "./api";
import { art } from "./brand";
import { Sidebar } from "./components/Sidebar";
import { State } from "./components/State";
import { useMediaQuery, usePoll, useRoute } from "./hooks";
import { useNewBuild } from "./new-build";
import { DRAFT_CHANGED, hasAnyDraft } from "./drafts";
import { setHold, useHold } from "./hold";
import { checkNow, serverDown, subscribeServer } from "./server-watch";
import { Auth } from "./pages/Auth";
import { Board } from "./pages/Board";
import { Decisions } from "./pages/Decisions";
import { Engagement, Engagements } from "./pages/Engagements";
import { Run } from "./pages/Run";
import { Runs } from "./pages/Runs";
import { MergeQueue } from "./pages/MergeQueue";
import { ProjectsPage, Settings } from "./pages/Settings";
import { Ticket } from "./pages/Ticket";
import { Rules } from "./pages/Rules";
import { Secrets } from "./pages/Secrets";
import { Funding } from "./pages/Funding";
import { Notifications } from "./pages/Notifications";
import { ScrumMaster } from "./pages/ScrumMaster";
import { Workflow } from "./pages/Workflow";
import { Plan } from "./pages/Plan";
import { ChatPage } from "./pages/Chat";
import { Dashboard } from "./pages/Dashboard";
import { Skills } from "./pages/Skills";
import { Agents } from "./pages/Agents";
import { Features } from "./pages/Features";
import { Wiki } from "./pages/Wiki";
import { Feedback } from "./pages/Feedback";
import { Roadmap } from "./pages/Roadmap";
import { Setup, SetupChecklist } from "./pages/Setup";

type Session = { state: "loading" } | { state: "setup" } | { state: "login" } | { state: "in"; username: string } | { state: "offline" };

const notifySupported = () => typeof window !== "undefined" && "Notification" in window;

/**
 * Shows flags, pages and asks from the notifications feed as browser notifications while no
 * Boss Man tab is visible (R44). The first load only records what's already there, so opening
 * the app never sets off a burst.
 */
function useFeedNotifications(feed: NoticeFeed | null) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!feed) return;
    if (seen.current === null) {
      seen.current = new Set(feed.items.map((n) => n.id));
      return;
    }
    const fresh = feed.items.filter((n) => !seen.current!.has(n.id));
    for (const n of fresh) seen.current.add(n.id);
    const loud = fresh.filter((n) => n.level !== "note" && !n.readAt);
    if (!loud.length || document.visibilityState === "visible" || !notifySupported() || Notification.permission !== "granted") return;
    const top = loud[0]!;
    const n = new Notification(loud.length === 1 ? top.title : `${loud.length} new notifications`, { body: loud.length === 1 ? (top.body ?? "") : top.title, tag: "boss-man" });
    n.onclick = () => {
      window.focus();
      window.location.hash = loud.length === 1 ? top.link : "#/notifications";
      n.close();
    };
  }, [feed]);
}

/** Screens whose address names a company, e.g. #/wiki/<company>/… (R72). */
const COMPANY_SCREENS = new Set(["scrum-master", "workflow", "chat", "wiki", "features", "feedback", "plan", "merge-queue", "rules", "settings", "projects"]);
const CHOSEN = "bm-company";
const SIDE_COLLAPSED = "bm-side-collapsed";
function remember(id: string, set: (id: string) => void) {
  set(id);
  try {
    localStorage.setItem(CHOSEN, id);
  } catch {
    // Storage may be blocked; the choice lasts until the page reloads.
  }
}
/** Whether the side menu is an icon-only strip (BOS-290): the owner's saved choice, else collapsed on a tablet or foldable and expanded on a desktop. */
export function collapsedByDefault(): boolean {
  try {
    const saved = localStorage.getItem(SIDE_COLLAPSED);
    if (saved === "1") return true;
    if (saved === "0") return false;
  } catch {
    // Storage may be blocked; use the default for this width.
  }
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 1180px)").matches : false;
}
function rememberCollapsed(off: boolean, set: (off: boolean) => void) {
  set(off);
  try {
    localStorage.setItem(SIDE_COLLAPSED, off ? "1" : "0");
  } catch {
    // Storage may be blocked; the choice lasts until the page reloads.
  }
}

type Maintenance = { on: false } | { on: true; reason: string; since: string; deadline: string; runs: number; companies: number; /** BOS-349: work runs are still going, so the owner may keep chatting. */ chatOpen: boolean };

/** On every page while a runner update is draining (docs/09-self-deploy.md): nothing new starts until the runs below finish. */
function UpdateBanner({ m }: { m: Maintenance | null }) {
  if (!m?.on) return null;
  const waiting = m.runs > 0 ? `waiting for ${m.runs} run${m.runs === 1 ? "" : "s"} in ${m.companies} ${m.companies === 1 ? "company" : "companies"} to finish` : "swapping the runners now";
  return (
    <p className="banner" role="status" style={{ margin: "0 0 16px" }}>
      Update pending: {waiting}. Nothing new starts until it is done.
    </p>
  );
}

/** On every page once the server serves newer screens than this tab is running (BOS-550): the owner reloads when ready. */
export function NewBuildBanner({ newer }: { newer: boolean }) {
  // BOS-773: if this browser holds any kept text, say plainly that reloading won't lose it, so the
  // owner isn't warned off by the reload prompt. Kept live: it changes as drafts are typed and cleared.
  const [kept, setKept] = useState(() => hasAnyDraft());
  useEffect(() => {
    if (!newer) return;
    const update = () => setKept(hasAnyDraft());
    update();
    window.addEventListener(DRAFT_CHANGED, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(DRAFT_CHANGED, update);
      window.removeEventListener("storage", update);
    };
  }, [newer]);
  if (!newer) return null;
  return (
    <p className="banner" role="status" style={{ margin: "0 0 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span>
        Boss Man has been updated since this page was opened. Reload to see the latest screens; until then some cards may not show properly.
        {kept ? " What you've typed is kept: it comes back when the page reloads." : " Nothing you've typed is lost by reloading: every text box keeps a draft."}
      </span>
      <button className="btn" type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </p>
  );
}

/** On every page while the owner's "Stop all work" hold is on (BOS-836), with the one button that lifts it. */
export function HoldBanner() {
  const hold = useHold();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (hold.data?.paused !== true) return null;
  const resume = async () => {
    setBusy(true);
    setError(null);
    try {
      await setHold(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <p className="banner" role="status" style={{ margin: "0 0 16px", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span>
        <strong>All work is stopped.</strong> No new agent runs start in any company until you resume; runs already going finish by themselves.
      </span>
      <button className="btn" type="button" disabled={busy} onClick={() => void resume()}>
        Resume
      </button>
      {error && <span role="alert" className="error">{error}</span>}
    </p>
  );
}

function useServerDown(): boolean {
  const [down, setDown] = useState(serverDown);
  useEffect(() => {
    const update = () => setDown(serverDown());
    const off = subscribeServer(update);
    update();
    // A check when the app is opened and whenever the tab comes back: a freeze may have missed the last probe.
    if (!down) void checkNow();
    const onVisible = () => {
      if (document.visibilityState === "visible") void checkNow();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      off();
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return down;
}

/**
 * The server is restarting, stalled or unreachable: a small banner over the page, never in place of
 * it (BOS-637). The page keeps what it had and catches up on its own once the server answers again.
 */
export function ServerBanner() {
  const down = useServerDown();
  if (!down) return null;
  return (
    <p className="banner server-banner" role="status" aria-live="polite">
      Boss Man is restarting or switching versions for a moment. This page stays as it is and what you have typed is kept; it will catch up on its own when the server answers.
    </p>
  );
}

function Signed({ onLogout }: { onLogout: () => void }) {
  const [route, go] = useRoute();
  const page = route[0] ?? "dashboard";
  const companies = usePoll((signal) => api<Company[]>("/api/companies", { signal }), 30_000, "companies");
  const decisions = usePoll((signal) => api<Decision[]>("/api/decisions", { signal }), 10_000, "decisions");
  const advised = usePoll((signal) => api<AdvisedDecision[]>("/api/decisions/advised", { signal }), 30_000, "decisions-advised");
  const teamAlerts = usePoll((signal) => api<TeamAlert[]>("/api/decisions/with-team", { signal }), 30_000, "decisions-team");
  // Cards Boss Man closed by itself in the last couple of hours, shown where they were (BOS-739).
  const closedNotices = usePoll((signal) => api<ClosedNoticeCard[]>("/api/decisions/closed-notices", { signal }), 30_000, "decisions-closed");
  const runs = usePoll((signal) => api<ActiveRun[]>("/api/runs", { signal }), 15_000, "runs");
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(notifySupported() ? Notification.permission : "unsupported");
  const feed = usePoll((signal) => api<NoticeFeed>("/api/notifications", { signal }), 10_000, "notifications");
  const maintenance = usePoll((signal) => api<Maintenance>("/api/maintenance", { signal }), 5_000, "maintenance");
  const unprocessed = usePoll((signal) => api<Record<string, number>>("/api/feedback/unprocessed", { signal }), 30_000, "unprocessed");
  const newer = useNewBuild();
  useFeedNotifications(feed.data);
  // Moving between screens refreshes the company list, so names and agents are never stale.
  const reloadCompanies = companies.reload;
  useEffect(() => reloadCompanies(), [page, reloadCompanies]);
  const reloadUnprocessed = unprocessed.reload;
  useEffect(() => reloadUnprocessed(), [route.join("/"), reloadUnprocessed]);

  const lost = [companies.error, decisions.error].find((e) => e && e.status === 0);
  // An away server is the banner's to say, and it goes away by itself: this page keeps its place
  // and catches up, rather than being swapped for an error (BOS-637).
  useEffect(() => {
    if (!lost) return;
    const timer = setTimeout(() => {
      companies.reload();
      decisions.reload();
    }, 3000);
    return () => clearTimeout(timer);
  }, [lost, companies.reload, decisions.reload]);
  const expired = [companies.error, decisions.error].some((e) => e?.status === 401);
  useEffect(() => {
    if (expired) onLogout();
  }, [expired, onLogout]);

  const list = companies.data ?? [];
  // The company every screen shows (R72): the one in the address if the screen has one, else
  // the one last picked in this browser, else the first.
  const [chosen, setChosen] = useState<string | null>(() => {
    try {
      return localStorage.getItem(CHOSEN);
    } catch {
      return null;
    }
  });
  // Tablet and foldable widths start collapsed so the page gets the room (BOS-290); a desktop starts
  // expanded. A saved choice wins. The menu is a bar on a phone, so that width has no strip.
  const narrow = useMediaQuery("(max-width: 1180px)");
  const [collapsed, setCollapsed] = useState<boolean>(collapsedByDefault);
  const inRoute = COMPANY_SCREENS.has(page) && list.some((c) => c.id === route[1]) ? route[1]! : null;
  const current = list.find((c) => c.id === (inRoute ?? chosen)) ?? list[0];
  // The merge queue badge (BOS-587): approved work waiting to merge, from the same read the screen uses, so
  // the badge and the page share one request. A failure just leaves the badge off. Its stuck count (BOS-767)
  // turns the badge to the warning colour when a jam is there to see.
  const mergeQueue = usePoll(
    (signal) => (current ? api<{ waitingCount: number; stuckCount?: number }>(`/api/companies/${current.id}/merge-queue`, { signal }).catch(() => null) : Promise.resolve(null)),
    20_000,
    `merge-badge-${current?.id}`,
  );
  useEffect(() => {
    if (inRoute && inRoute !== chosen) remember(inRoute, setChosen);
  }, [inRoute, chosen]);
  const pick = (id: string) => {
    remember(id, setChosen);
    if (COMPANY_SCREENS.has(page)) go(`${page}/${id}`);
    else if (page === "board" || page === "tickets") go("board");
  };
  const createCompany = async (name: string) => {
    const { company } = await api<{ company: Company }>("/api/companies", { method: "POST", body: { name } });
    companies.reload();
    remember(company.id, setChosen);
    go("board");
  };
  const mine = current ? [current] : [];
  const companyId = inRoute ?? current?.id;
  // A fresh install opens on the setup wizard (R56) until the owner finishes or dismisses it.
  const firstLoad = useRef(true);
  useEffect(() => {
    if (!firstLoad.current || companies.data === null) return;
    firstLoad.current = false;
    if (companies.data.length || page !== "dashboard") return;
    void api<{ dismissed: boolean }>("/api/setup-progress").then((p) => {
      if (!p.dismissed) go("setup");
    }, () => {});
  }, [companies.data, page, go]);
  return (
    <div className={`app${collapsed ? " side-collapsed" : ""}`}>
      <Sidebar
        collapsed={collapsed}
        onToggleCollapsed={() => rememberCollapsed(!collapsed, setCollapsed)}
        narrow={narrow}
        active={page === "funding" || page === "rules" || page === "secrets" ? "settings" : page}
        activeAgent={route[2]}
        activeProject={route[1]}
        companies={list}
        current={current}
        onPickCompany={pick}
        onCreateCompany={createCompany}
        decisions={decisions.data ?? []}
        unread={feed.data?.unread ?? 0}
        feedback={Object.values(unprocessed.data ?? {}).reduce((a, b) => a + b, 0)}
        mergeWaiting={mergeQueue.data?.waitingCount ?? 0}
        mergeStuck={mergeQueue.data?.stuckCount ?? 0}
        notifications={permission}
        onEnableNotifications={() => void Notification.requestPermission().then(setPermission)}
        onLogout={() => void api("/api/logout", { method: "POST" }).finally(onLogout)}
      />
      <main>
        <UpdateBanner m={maintenance.data} />
        <HoldBanner />
        <ServerBanner />
        <NewBuildBanner newer={newer} />
        <PageGuard key={route.join("/")}>
        {page === "board" ? (
          <Board companies={mine} projectId={route[1]} subpage={route[2]} go={go} onCompaniesChanged={companies.reload} />
        ) : page === "chat" ? (
          <ChatPage companies={list} companyId={companyId} agentId={route[2]} maintenance={maintenance.data} go={go} onChanged={companies.reload} />
        ) : page === "wiki" ? (
          <Wiki companies={list} companyId={companyId} slug={route.slice(2).join("/") || undefined} go={go} />
        ) : page === "agents" ? (
          <Agents company={current} onChanged={companies.reload} />
        ) : page === "skills" ? (
          <Skills company={current} />
        ) : page === "features" ? (
          <Features companies={list} companyId={companyId} featureId={route[2]} go={go} />
        ) : page === "feedback" ? (
          <Feedback companies={list} companyId={companyId} noteId={route[2]} go={go} />
        ) : page === "roadmap" ? (
          <Roadmap companies={mine} tab={route[1]} go={go} />
        ) : page === "plan" ? (
          <Plan companies={list} companyId={companyId} go={go} />
        ) : page === "runs" ? (
          route[1] ? <Run key={route[1]} runId={route[1]} companies={list} /> : <Runs companies={list} />
        ) : page === "merge-queue" ? (
          <MergeQueue companies={list} companyId={companyId} />
        ) : page === "tickets" && route[1] ? (
          <Ticket key={route[1]} id={route[1]} companies={list} />
        ) : page === "scrum-master" ? (
          <ScrumMaster company={current} />
        ) : page === "workflow" ? (
          <Workflow company={current} />
        ) : page === "notifications" ? (
          <Notifications feed={feed.data} onChanged={feed.reload} companies={companies.data} />
        ) : page === "funding" || page === "rules" || page === "secrets" ? (
          <Settings companies={list} companyId={companyId} tab={page} go={go} onChanged={companies.reload}>
            {page === "funding" ? <Funding companies={list} /> : page === "rules" ? <Rules companies={list} companyId={companyId} go={go} /> : <Secrets companies={list} companyId={companyId} onChanged={companies.reload} />}
          </Settings>
        ) : page === "projects" ? (
          <ProjectsPage companies={list} companyId={companyId} go={go} onChanged={companies.reload} />
        ) : page === "settings" ? (
          <Settings companies={list} companyId={companyId} tab={route[2]} go={go} onChanged={companies.reload} />
        ) : page === "engagements" ? (
          route[1] ? <Engagement id={route[1]} /> : <Engagements />
        ) : page === "setup" ? (
          <Setup companies={list} go={go} onChanged={companies.reload} />
        ) : page === "decisions" ? (
          <Decisions decisions={(decisions.data ?? []).filter((d) => !current || d.companyId === current.id)} elsewhere={list.filter((c) => c.id !== current?.id).map((c) => ({ id: c.id, name: c.name, count: (decisions.data ?? []).filter((d) => d.companyId === c.id).length })).filter((c) => c.count)} onPickCompany={pick} companies={mine} loaded={decisions.data !== null} agentsWorking={runs.data?.length ?? 0} advised={(advised.data ?? []).filter((a) => !current || a.companyId === current.id)} withTeam={(teamAlerts.data ?? []).filter((a) => !current || a.companyId === current.id)} closedNotices={(closedNotices.data ?? []).filter((a) => !current || a.companyId === current.id)} onAnswered={decisions.reload} banner={<SetupChecklist companyId={current?.id} go={go} />} />
        ) : (
          <Dashboard company={current} />
        )}
        </PageGuard>
      </main>
    </div>
  );
}

export function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const check = useCallback(async () => {
    try {
      const { needsSetup } = await api<{ needsSetup: boolean }>("/api/setup");
      if (needsSetup) return setSession({ state: "setup" });
      const me = await api<{ username: string }>("/api/me");
      setSession({ state: "in", username: me.username });
    } catch (err) {
      setSession(err instanceof ApiError && err.status === 401 ? { state: "login" } : { state: "offline" });
    }
  }, []);
  useEffect(() => void check(), [check]);
  // Can't reach the server when the page opens: keep trying quietly, and show it once it answers
  // (BOS-637). A freeze at startup should cost a few seconds, not the "Try again" click.
  useEffect(() => {
    if (session.state !== "offline") return;
    const timer = setInterval(() => void check(), 4000);
    return () => clearInterval(timer);
  }, [session.state, check]);
  const loggedOut = useCallback(() => setSession({ state: "login" }), []);

  switch (session.state) {
    case "loading":
      return null;
    case "offline":
      return (
        <main className="auth">
          <ServerBanner />
          <State img={art.stuck} alt="Can't reach the server" title="Can't reach the Boss Man server">
            <p>Trying again every few seconds; this page will open on its own as soon as the server answers.</p>
            <button className="btn primary" type="button" onClick={() => void check()}>
              Try again
            </button>
          </State>
        </main>
      );
    case "setup":
    case "login":
      return <Auth firstRun={session.state === "setup"} onDone={(username) => setSession({ state: "in", username })} />;
    case "in":
      return <Signed onLogout={loggedOut} />;
  }
}

/** A page that throws shows what went wrong instead of blanking the whole app; moving to another page resets it. */
export class PageGuard extends Component<{ children: ReactNode }, { error: Error | null; where: string }> {
  state = { error: null as Error | null, where: "" };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  // Which components it was in: the error's own stack is React's internals, which says nothing about the page.
  componentDidCatch(_error: Error, info: ErrorInfo) {
    this.setState({ where: (info.componentStack ?? "").trim().split("\n").slice(0, 8).join("\n") });
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="card" role="alert" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <h2 style={{ fontSize: 17 }}>This page hit an error</h2>
        <p className="muted">The rest of Boss Man still works. If it happens again, send a screenshot of this message.</p>
        <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", fontSize: 12 }}>{`${this.state.error.name}: ${this.state.error.message}\n${(this.state.error.stack ?? "").split("\n").slice(0, 4).join("\n")}${this.state.where ? `\nIn:\n${this.state.where}` : ""}`}</pre>
        <div>
          <button type="button" className="btn" onClick={() => this.setState({ error: null, where: "" })}>
            Try again
          </button>
        </div>
      </section>
    );
  }
}
