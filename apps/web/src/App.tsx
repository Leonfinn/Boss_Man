import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ActiveRun, type Company, type Decision, type NoticeFeed } from "./api";
import { art } from "./brand";
import { Sidebar } from "./components/Sidebar";
import { State } from "./components/State";
import { usePoll, useRoute } from "./hooks";
import { Auth } from "./pages/Auth";
import { Board } from "./pages/Board";
import { Decisions } from "./pages/Decisions";
import { Engagement, Engagements } from "./pages/Engagements";
import { Run } from "./pages/Run";
import { Runs } from "./pages/Runs";
import { Settings } from "./pages/Settings";
import { Ticket } from "./pages/Ticket";
import { Rules } from "./pages/Rules";
import { Secrets } from "./pages/Secrets";
import { Funding } from "./pages/Funding";
import { Notifications } from "./pages/Notifications";
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
const COMPANY_SCREENS = new Set(["chat", "wiki", "features", "feedback", "plan", "rules", "settings"]);
const CHOSEN = "bm-company";
function remember(id: string, set: (id: string) => void) {
  set(id);
  try {
    localStorage.setItem(CHOSEN, id);
  } catch {
    // Storage may be blocked; the choice lasts until the page reloads.
  }
}

function Signed({ onLogout }: { onLogout: () => void }) {
  const [route, go] = useRoute();
  const page = route[0] ?? "dashboard";
  const companies = usePoll((signal) => api<Company[]>("/api/companies", { signal }), 30_000, "companies");
  const decisions = usePoll((signal) => api<Decision[]>("/api/decisions", { signal }), 10_000, "decisions");
  const runs = usePoll((signal) => api<ActiveRun[]>("/api/runs", { signal }), 15_000, "runs");
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(notifySupported() ? Notification.permission : "unsupported");
  const feed = usePoll((signal) => api<NoticeFeed>("/api/notifications", { signal }), 10_000, "notifications");
  const unprocessed = usePoll((signal) => api<Record<string, number>>("/api/feedback/unprocessed", { signal }), 30_000, "unprocessed");
  useFeedNotifications(feed.data);
  // Moving between screens refreshes the company list, so names and agents are never stale.
  const reloadCompanies = companies.reload;
  useEffect(() => reloadCompanies(), [page, reloadCompanies]);
  const reloadUnprocessed = unprocessed.reload;
  useEffect(() => reloadUnprocessed(), [route.join("/"), reloadUnprocessed]);

  const lost = [companies.error, decisions.error].find((e) => e && e.status === 0);
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
  const inRoute = COMPANY_SCREENS.has(page) && list.some((c) => c.id === route[1]) ? route[1]! : null;
  const current = list.find((c) => c.id === (inRoute ?? chosen)) ?? list[0];
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
    <div className="app">
      <Sidebar
        active={page}
        companies={list}
        current={current}
        onPickCompany={pick}
        onCreateCompany={createCompany}
        decisions={decisions.data ?? []}
        unread={feed.data?.unread ?? 0}
        feedback={Object.values(unprocessed.data ?? {}).reduce((a, b) => a + b, 0)}
        notifications={permission}
        onEnableNotifications={() => void Notification.requestPermission().then(setPermission)}
        onLogout={() => void api("/api/logout", { method: "POST" }).finally(onLogout)}
      />
      <main>
        {lost ? (
          <State img={art.stuck} alt="Lost connection to the server" title="Lost connection to the server">
            <p>Boss Man keeps working on the server; this page will catch up as soon as it can reach it again.</p>
          </State>
        ) : page === "board" ? (
          <Board companies={mine} projectId={route[1]} go={go} onCompaniesChanged={companies.reload} />
        ) : page === "chat" ? (
          <ChatPage companies={list} companyId={companyId} agentId={route[2]} go={go} />
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
        ) : page === "funding" ? (
          <Funding companies={list} />
        ) : page === "runs" ? (
          route[1] ? <Run key={route[1]} runId={route[1]} companies={list} /> : <Runs companies={list} />
        ) : page === "tickets" && route[1] ? (
          <Ticket key={route[1]} id={route[1]} companies={list} />
        ) : page === "rules" ? (
          <Rules companies={list} companyId={companyId} go={go} />
        ) : page === "notifications" ? (
          <Notifications feed={feed.data} onChanged={feed.reload} />
        ) : page === "secrets" ? (
          <Secrets />
        ) : page === "settings" ? (
          <Settings companies={list} companyId={companyId} go={go} onChanged={companies.reload} />
        ) : page === "engagements" ? (
          route[1] ? <Engagement id={route[1]} /> : <Engagements />
        ) : page === "setup" ? (
          <Setup companies={list} go={go} onChanged={companies.reload} />
        ) : page === "decisions" ? (
          <Decisions decisions={(decisions.data ?? []).filter((d) => !current || d.companyId === current.id)} companies={mine} loaded={decisions.data !== null} agentsWorking={runs.data?.length ?? 0} onAnswered={decisions.reload} banner={<SetupChecklist companyId={current?.id} go={go} />} />
        ) : (
          <Dashboard company={current} />
        )}
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
  const loggedOut = useCallback(() => setSession({ state: "login" }), []);

  switch (session.state) {
    case "loading":
      return null;
    case "offline":
      return (
        <main className="auth">
          <State img={art.stuck} alt="Can't reach the server" title="Can't reach the Boss Man server">
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
