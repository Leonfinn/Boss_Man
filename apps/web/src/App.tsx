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
import { Roadmap } from "./pages/Roadmap";

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

function Signed({ onLogout }: { onLogout: () => void }) {
  const [route, go] = useRoute();
  const page = route[0] ?? "decisions";
  const companies = usePoll((signal) => api<Company[]>("/api/companies", { signal }), 30_000, "companies");
  const decisions = usePoll((signal) => api<Decision[]>("/api/decisions", { signal }), 10_000, "decisions");
  const runs = usePoll((signal) => api<ActiveRun[]>("/api/runs", { signal }), 15_000, "runs");
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(notifySupported() ? Notification.permission : "unsupported");
  const feed = usePoll((signal) => api<NoticeFeed>("/api/notifications", { signal }), 10_000, "notifications");
  useFeedNotifications(feed.data);
  // Moving between screens refreshes the company list, so names and agents are never stale.
  const reloadCompanies = companies.reload;
  useEffect(() => reloadCompanies(), [page, reloadCompanies]);

  const lost = [companies.error, decisions.error].find((e) => e && e.status === 0);
  const expired = [companies.error, decisions.error].some((e) => e?.status === 401);
  useEffect(() => {
    if (expired) onLogout();
  }, [expired, onLogout]);

  const list = companies.data ?? [];
  return (
    <div className="app">
      <Sidebar
        active={page}
        companies={list}
        decisions={decisions.data ?? []}
        unread={feed.data?.unread ?? 0}
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
          <Board companies={list} projectId={route[1]} go={go} onCompaniesChanged={companies.reload} />
        ) : page === "chat" ? (
          <ChatPage companies={list} companyId={route[1]} go={go} />
        ) : page === "roadmap" ? (
          <Roadmap companies={list} tab={route[1]} go={go} />
        ) : page === "plan" ? (
          <Plan companies={list} companyId={route[1]} go={go} />
        ) : page === "funding" ? (
          <Funding companies={list} />
        ) : page === "runs" ? (
          route[1] ? <Run key={route[1]} runId={route[1]} companies={list} /> : <Runs companies={list} />
        ) : page === "tickets" && route[1] ? (
          <Ticket key={route[1]} id={route[1]} />
        ) : page === "rules" ? (
          <Rules companies={list} companyId={route[1]} go={go} />
        ) : page === "notifications" ? (
          <Notifications feed={feed.data} onChanged={feed.reload} />
        ) : page === "secrets" ? (
          <Secrets />
        ) : page === "settings" ? (
          <Settings companies={list} companyId={route[1]} go={go} onChanged={companies.reload} />
        ) : page === "engagements" ? (
          route[1] ? <Engagement id={route[1]} /> : <Engagements />
        ) : (
          <Decisions decisions={decisions.data ?? []} companies={list} loaded={decisions.data !== null} agentsWorking={runs.data?.length ?? 0} onAnswered={decisions.reload} />
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
