import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, type ActiveRun, type Company, type Decision } from "./api";
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
import { Funding } from "./pages/Funding";

type Session = { state: "loading" } | { state: "setup" } | { state: "login" } | { state: "in"; username: string } | { state: "offline" };

const notifySupported = () => typeof window !== "undefined" && "Notification" in window;

/**
 * Tells the owner about decisions that arrive while no Boss Man tab is visible (R44). The
 * first load only records what's already waiting, so opening the app never sets off a burst.
 */
function useDecisionNotifications(decisions: Decision[] | null) {
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!decisions) return;
    if (seen.current === null) {
      seen.current = new Set(decisions.map((d) => d.id));
      return;
    }
    const fresh = decisions.filter((d) => !seen.current!.has(d.id));
    for (const d of fresh) seen.current.add(d.id);
    if (!fresh.length || document.visibilityState === "visible" || !notifySupported() || Notification.permission !== "granted") return;
    const top = fresh[0]!;
    const n = new Notification(fresh.length === 1 ? `${top.companyName} needs a decision` : `${fresh.length} new decisions`, { body: top.question, tag: "boss-man-decisions" });
    n.onclick = () => {
      window.focus();
      window.location.hash = "#/decisions";
      n.close();
    };
  }, [decisions]);
}

function Signed({ onLogout }: { onLogout: () => void }) {
  const [route, go] = useRoute();
  const page = route[0] ?? "decisions";
  const companies = usePoll((signal) => api<Company[]>("/api/companies", { signal }), 30_000, "companies");
  const decisions = usePoll((signal) => api<Decision[]>("/api/decisions", { signal }), 10_000, "decisions");
  const runs = usePoll((signal) => api<ActiveRun[]>("/api/runs", { signal }), 15_000, "runs");
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(notifySupported() ? Notification.permission : "unsupported");
  useDecisionNotifications(decisions.data);
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
        ) : page === "funding" ? (
          <Funding companies={list} />
        ) : page === "runs" ? (
          route[1] ? <Run key={route[1]} runId={route[1]} companies={list} /> : <Runs companies={list} />
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
