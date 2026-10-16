import type { Company, Decision } from "../api";
import { art } from "../brand";

const NAV = [
  { id: "decisions", label: "Decisions" },
  { id: "notifications", label: "Notifications" },
  { id: "chat", label: "Chat" },
  { id: "board", label: "Board" },
  { id: "roadmap", label: "Roadmap" },
  { id: "plan", label: "Plan" },
  { id: "runs", label: "Runs" },
  { id: "engagements", label: "Engagements" },
  { id: "funding", label: "Funding" },
  { id: "rules", label: "Rules" },
  { id: "secrets", label: "Secrets" },
  { id: "settings", label: "Settings" },
];

export function Sidebar(props: {
  active: string;
  companies: Company[];
  decisions: Decision[];
  unread: number;
  notifications: NotificationPermission | "unsupported";
  onEnableNotifications: () => void;
  onLogout: () => void;
}) {
  const waiting = (companyId: string) => props.decisions.filter((d) => d.companyId === companyId).length;
  return (
    <nav className="side" aria-label="Main">
      <div className="brand">
        <img src={art.mark64} alt="" />
        <span>Boss Man</span>
      </div>
      <ul>
        {NAV.map((n) => (
          <li key={n.id}>
            <a className="nav" href={`#/${n.id}`} aria-current={props.active === n.id || (props.active === "tickets" && n.id === "board") ? "page" : undefined}>
              <span>{n.label}</span>
              {n.id === "decisions" && props.decisions.length > 0 && <span className="count" aria-label={`${props.decisions.length} waiting`}>{props.decisions.length}</span>}
              {n.id === "notifications" && props.unread > 0 && <span className="count" aria-label={`${props.unread} unread`}>{props.unread}</span>}
            </a>
          </li>
        ))}
      </ul>
      {props.companies.length > 0 && (
        <section className="companies" aria-labelledby="companies-h">
          <h2 id="companies-h">Companies</h2>
          {props.companies.map((c) => {
            const n = waiting(c.id);
            const [colour, note] = c.paused ? ["#5e6878", "Paused"] : n ? ["#f0b75c", `${n} waiting on you`] : ["#7fd3a5", `${c.agents.length} agent${c.agents.length === 1 ? "" : "s"}`];
            return (
              <div className="company" key={c.id}>
                <span className="dot" style={{ background: colour }} aria-hidden="true" />
                <span>
                  {c.name}
                  <small>{note}</small>
                </span>
              </div>
            );
          })}
        </section>
      )}
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
