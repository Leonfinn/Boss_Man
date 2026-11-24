import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import { api, ApiError, type ActiveRun, type Company, type Decision, type DecisionTally, type NoticeFeed, type TeamAlert, type AdvisedDecision, type ClosedNoticeCard } from "./api";
import { art } from "./brand";
import { companyFigure, Sidebar } from "./components/Sidebar";
import { State } from "./components/State";
import { useMediaQuery, usePoll, useRoute } from "./hooks";
import { useNewBuild } from "./new-build";
import { DRAFT_CHANGED, hasAnyDraft } from "./drafts";
import { setHold, useHold } from "./hold";
import { checkNow, serverDown, subscribeServer } from "./server-watch";
import { Auth } from "./pages/Auth";
import { lazyPage, PageSuspense } from "./lazy-page";
import { settingsRedirect } from "./pages/settings-redirect";
import { atTime, drainTiming, waitingFor, wrapUpBannerText, type RunnerCheckView } from "./pages/settings/updates";
import { inLineOf, MergesStuckBannerFor } from "./components/MergesStuckBanner";
import { SearchPalette } from "./components/SearchPalette";
import { Shortcuts } from "./components/Shortcuts";

// BOS-1843: every page below loads when it is first opened. Login, the shell and the banners stay in the entry file.
const Board = lazyPage(() => import("./pages/Board"), "Board");
const Decisions = lazyPage(() => import("./pages/Decisions"), "Decisions");
const Engagement = lazyPage(() => import("./pages/Engagements"), "Engagement");
const Engagements = lazyPage(() => import("./pages/Engagements"), "Engagements");
const Run = lazyPage(() => import("./pages/Run"), "Run");
const Runs = lazyPage(() => import("./pages/Runs"), "Runs");
const MergeQueue = lazyPage(() => import("./pages/MergeQueue"), "MergeQueue");
const MergeHistory = lazyPage(() => import("./pages/MergeHistory"), "MergeHistory");
const Settings = lazyPage(() => import("./pages/Settings"), "Settings");
const ProjectsPage = lazyPage(() => import("./pages/settings/Projects"), "ProjectsPage");
const Ticket = lazyPage(() => import("./pages/Ticket"), "Ticket");
const Rules = lazyPage(() => import("./pages/Rules"), "Rules");
const Secrets = lazyPage(() => import("./pages/Secrets"), "Secrets");
const Notifications = lazyPage(() => import("./pages/Notifications"), "Notifications");
const ScrumMaster = lazyPage(() => import("./pages/ScrumMaster"), "ScrumMaster");
const Workflow = lazyPage(() => import("./pages/Workflow"), "Workflow");
const Plan = lazyPage(() => import("./pages/Plan"), "Plan");
const ChatPage = lazyPage(() => import("./pages/Chat"), "ChatPage");
const Dashboard = lazyPage(() => import("./pages/Dashboard"), "Dashboard");
const SpendReport = lazyPage(() => import("./pages/SpendReport"), "SpendReport");
const Skills = lazyPage(() => import("./pages/Skills"), "Skills");
const Agents = lazyPage(() => import("./pages/Agents"), "Agents");
const SearchPage = lazyPage(() => import("./pages/Search"), "SearchPage");
const Features = lazyPage(() => import("./pages/Features"), "Features");
const Wiki = lazyPage(() => import("./pages/Wiki"), "Wiki");
const Feedback = lazyPage(() => import("./pages/Feedback"), "Feedback");
const Roadmap = lazyPage(() => import("./pages/Roadmap"), "Roadmap");
const Setup = lazyPage(() => import("./pages/Setup"), "Setup");
const SetupChecklist = lazyPage(() => import("./pages/Setup"), "SetupChecklist");

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
const COMPANY_SCREENS = new Set(["scrum-master", "workflow", "chat", "wiki", "features", "feedback", "plan", "merge-queue", "rules", "settings", "projects", "spend"]);
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

type Maintenance = { on: false } | { on: true; kind?: "update" | "settings" | "wrapup" | "building"; reason: string; since: string; deadline: string; runs: number; companies: number; /** BOS-1600: checks on a runner that the swap waits on. */ checks?: number; checksList?: RunnerCheckView[]; /** BOS-2404: the owner's chat answers; false only while a runner is being swapped, until chatBackBy at the latest. */ chatOpen: boolean; chatBackBy?: string | null; /** BOS-1414: false once the drain is past its deadline and waits on the owner, so nothing is held for it. */ blocking?: boolean; /** BOS-1877: the drain's phase, forecast and whether it ran past it. */ phase?: "waiting" | "swapping"; expectedFinishAt?: string | null; overdue?: boolean; /** BOS-1951: merges being pushed to main (named by ticket), and a wait on nothing Boss Man can name. */ merges?: number; mergesList?: { ticket: string | null }[]; unknownWait?: boolean; /** BOS-2056: when the owner's wrap-up was asked and which update it is for. */ wrapSince?: string; wrapForUpdate?: "server" | "runner" | "none" };

/** On every page while a runner update is draining (docs/09-self-deploy.md): nothing new starts until the runs below finish. */
function UpdateBanner({ m }: { m: Maintenance | null }) {
  if (!m?.on) return null;
  if (m.kind === "wrapup")
    return (
      <p className="banner" role="status" style={{ margin: "0 0 16px" }}>
        {wrapUpBannerText(m)}
      </p>
    );
  if (m.kind === "building")
    return (
      <p className="banner" role="status" style={{ margin: "0 0 16px" }}>
        A runner update is being built. New runs wait until it has gone in; runs already going carry on. Cancel it on Settings → Server and runner → Updates if you need new work to start now.
      </p>
    );
  const waiting = waitingFor(m);
  if (m.kind === "settings")
    return (
      <p className="banner" role="status" style={{ margin: "0 0 16px" }}>
        {m.blocking === false
          ? `Applying a runner setting change (for example Check slots): ${waiting}. This is not a runner update, and new runs are not held while it waits for your answer in Settings → Server and runner → Updates.`
          : `Applying a runner setting change (for example Check slots): ${waiting}. This is not a runner update: the runner image stays the same. Nothing new starts until it is done.`}
      </p>
    );
  if (m.blocking === false)
    return (
      <p className="banner" role="status" style={{ margin: "0 0 16px" }}>
        Update pending: {waiting}. It is past its deadline and waits for your answer in Settings → Server and runner → Updates. New runs are not held for it.
      </p>
    );
  const timing = drainTiming(m);
  return (
    <p className="banner" role="status" style={{ margin: "0 0 16px" }}>
      Update pending: {waiting}. {timing ? `${timing} ` : ""}Nothing new starts until it is done.{" "}
      {m.overdue && m.phase === "waiting" ? (
        <>
          {m.unknownWait ? "It is running late: Boss Man cannot say what it is waiting for. " : "It is past the time given: "}
          <a href="#/settings/updates">choose in Settings → Server and runner → Updates</a> to stop the checks and update now, keep waiting, or cancel the update. Nothing that has started is stopped unless you choose that. The chat keeps answering meanwhile.{" "}
        </>
      ) : null}
      {m.wrapSince ? `Wrapping up for this update (asked at ${atTime(m.wrapSince)}): it ends by itself when the update goes in. ` : ""}
      {m.runs > 0 && !m.wrapSince
        ? 'To end the runs sooner, use "Ask agents to wrap up" on Settings → Server and runner → Updates.'
        : (m.checks ?? 0) > 0
          ? "To go ahead without waiting, use \"Stop the checks and update now\" on Settings → Server and runner → Updates: they restart from the beginning afterwards."
          : ""}
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
  const [rawRoute, go] = useRoute();
  const companies = usePoll((signal) => api<Company[]>("/api/companies", { signal }), 30_000, "companies");
  // The old Settings addresses keep working (BOS-1019): the redirect runs before anything renders, so an old
  // link lands on the new page and a bookmarked #/rules/a1 opens Permissions for that company.
  const route = rawRoute;
  const page = route[0] ?? "dashboard";
  const routeCompany = route[1] && route[1] !== "all" ? companies.data?.find((c) => c.id === route[1]) : undefined;
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
  // An old bare address such as #/funding carries no company, so the redirect uses the company already
  // selected (BOS-1044), not only the one in the address. It waits for the company list, or it would send
  // a bare #/funding to the menu before it knows which company to use.
  const redirect = page && companies.data ? settingsRedirect(route, routeCompany?.id ?? current?.id) : null;
  useEffect(() => {
    if (redirect) go(redirect);
  }, [redirect, go]);
  // The merge queue badge (BOS-587): approved work waiting to merge, from the same read the screen uses, so
  // the badge and the page share one request. A failure just leaves the badge off. Its stuck count (BOS-767)
  // turns the badge to the warning colour when a jam is there to see.
  const mergeQueue = usePoll(
    (signal) => (current ? api<{ waitingCount: number; lineCount?: number; stuckCount?: number }>(`/api/companies/${current.id}/merge-queue`, { signal }).catch(() => null) : Promise.resolve(null)),
    20_000,
    `merge-badge-${current?.id}`,
  );
  useEffect(() => {
    if (inRoute && inRoute !== chosen) remember(inRoute, setChosen);
  }, [inRoute, chosen]);
  // The Decisions menu badge (BOS-969): what needs the owner now, from the server's one count (the
  // Decisions page heading asks the same function), so the two can't drift. It follows the chosen
  // company and refreshes on the same poll as the queue, and on every answer.
  const decisionsTally = usePoll(
    (signal) =>
      current ? api<DecisionTally>(`/api/decisions/tally?companyId=${current.id}`, { signal }).catch(() => null) : Promise.resolve(null),
    10_000,
    `decisions-tally-${current?.id}`,
  );
  useEffect(() => decisionsTally.reload(), [current?.id]);
  // (BOS-1485) The company switcher's figure for every company: the same tally call, once per company.
  const companyIds = (companies.data ?? []).map((c) => c.id);
  const companyTallies = usePoll(
    async (signal) => {
      const rows = await Promise.all(companyIds.map((id) => api<DecisionTally>(`/api/decisions/tally?companyId=${id}`, { signal }).catch(() => null)));
      const out: Record<string, DecisionTally> = {};
      companyIds.forEach((id, i) => { const t = rows[i]; if (t) out[id] = t; });
      return out;
    },
    10_000,
    `decisions-tally-all-${companyIds.join(",")}`,
  );
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
        decisionsTally={decisionsTally.data}
        companyTallies={companyTallies.data ?? undefined}
        unread={feed.data?.unread ?? 0}
        feedback={companyFigure(unprocessed.data, current?.id)}
        mergeWaiting={mergeQueue.data ? inLineOf(mergeQueue.data) : 0}
        mergeStuck={mergeQueue.data?.stuckCount ?? 0}
        notifications={permission}
        onEnableNotifications={() => void Notification.requestPermission().then(setPermission)}
        onLogout={() => void api("/api/logout", { method: "POST" }).finally(onLogout)}
      />
      <SearchPalette companyId={companyId} go={go} />
      <Shortcuts go={go} hasProjects={(current?.projects?.length ?? 0) > 0} />
      <main>
        <UpdateBanner m={maintenance.data} />
        <HoldBanner />
        <ServerBanner />
        <NewBuildBanner newer={newer} />
        <PageGuard key={route.join("/")}>
        <PageSuspense>
        {redirect ? null : page === "board" ? (
          <Board companies={mine} projectId={route[1]} subpage={route[2]} go={go} onCompaniesChanged={companies.reload} />
        ) : page === "chat" ? (
          <ChatPage companies={list} companyId={companyId} agentId={route[2]} messageId={route[3]} maintenance={maintenance.data} go={go} onChanged={companies.reload} />
        ) : page === "wiki" ? (
          <Wiki companies={list} companyId={companyId} slug={route.slice(2).join("/") || undefined} go={go} />
        ) : page === "agents" ? (
          <Agents company={current} agentId={route[1]} onChanged={companies.reload} />
        ) : page === "skills" ? (
          <Skills company={current} skillId={route[1]} />
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
        ) : page === "merge-history" ? (
          <MergeHistory companies={list} companyId={companyId} />
        ) : page === "search" ? (
          <SearchPage companyId={companyId} go={go} />
        ) : page === "merge-queue" ? (
          <MergeQueue companies={list} companyId={companyId} />
        ) : page === "tickets" && route[1] ? (
          <Ticket key={route[1]} id={route[1]} companies={list} />
        ) : page === "scrum-master" ? (
          <ScrumMaster company={current} />
        ) : page === "workflow" ? (
          <Workflow company={current} />
        ) : page === "notifications" ? (
          <Notifications feed={feed.data} onChanged={feed.reload} companies={companies.data} browserPermission={permission} onEnableBrowser={() => void Notification.requestPermission().then(setPermission)} />
        ) : page === "spend" ? (
          <SpendReport company={current} />
        ) : page === "projects" ? (
          <ProjectsPage companies={list} companyId={companyId} go={go} onChanged={companies.reload} />
        ) : page === "settings" ? (
          <Settings companies={list} companyId={companyId} tab={route[2]} go={go} onChanged={companies.reload}>
            {route[2] === "secrets" ? <Secrets companies={list} companyId={companyId} onChanged={companies.reload} /> : route[2] === "permissions" ? <Rules companies={list} companyId={companyId} go={go} /> : null}
          </Settings>
        ) : page === "engagements" ? (
          route[1] ? <Engagement id={route[1]} /> : <Engagements />
        ) : page === "setup" ? (
          <Setup companies={list} go={go} onChanged={companies.reload} />
        ) : page === "decisions" ? (
          <Decisions decisions={(decisions.data ?? []).filter((d) => !current || d.companyId === current.id)} elsewhere={list.filter((c) => c.id !== current?.id).map((c) => ({ id: c.id, name: c.name, count: companyTallies.data?.[c.id]?.open ?? (decisions.data ?? []).filter((d) => d.companyId === c.id && !d.waiting).length })).filter((c) => c.count)} onPickCompany={pick} companies={mine} loaded={decisions.data !== null} loadError={decisions.error !== null} agentsWorking={runs.data?.length ?? 0} advised={(advised.data ?? []).filter((a) => !current || a.companyId === current.id)} withTeam={(teamAlerts.data ?? []).filter((a) => !current || a.companyId === current.id)} closedNotices={(closedNotices.data ?? []).filter((a) => !current || a.companyId === current.id)} onAnswered={() => { decisions.reload(); decisionsTally.reload(); }} tally={decisionsTally.data} banner={(folded: boolean) => <><MergesStuckBannerFor companyId={current?.id} /><PageSuspense fallback={null}><SetupChecklist companyId={current?.id} go={go} folded={folded} /></PageSuspense></>} />
        ) : (
          <Dashboard company={current} onChanged={companies.reload}decisions={decisions.data === null ? null : decisions.data.filter((d) => !current || d.companyId === current.id)} tally={decisionsTally.data} />
        )}
        </PageSuspense>
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
