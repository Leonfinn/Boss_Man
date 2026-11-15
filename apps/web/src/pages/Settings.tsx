import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Company } from "../api";
import { CompanyReviews } from "../components/ReviewPolicy";

import { Section, useAction } from "./settings/shared";
import { Runner } from "./settings/Runner";
import { Credentials } from "./settings/Credentials";
import { ToolServers, DeployTargets } from "./settings/Tools";
import { Funding, ProjectBudgets } from "./settings/Funding";
import { BudgetLimits, FundingCards } from "./Funding";
import { ProjectsPage, ProjectRow, ProjectBrief, ArchiveProject } from "./settings/Projects";
import { Watchdog } from "./settings/Watchdog";
import { GoalCheck, StandingRules, Chapters, AdviceTimeout, WorkflowRetros, TicketPrefix, PermissionJudgeSetting, AutoTempCleanupSetting } from "./settings/Team";
import { FenceSetting, SecondOpinionSetting, NudgeCap, RunTimeLimit } from "./settings/Permissions";
import { WorkspaceDisk, RunLimits, WipLimits, CheckQueueSetting, EmailSetting, PrivateDetails, StopAllWork, SelfDeploy } from "./settings/System";
import { ServerPanel, ThisHost, NetguardAllow } from "./settings/ThisHost";
import { Devices } from "./settings/Devices";
import { ExportCompany, ImportCompany } from "./settings/Transfer";

export { Section, useAction } from "./settings/shared";
export { Runner } from "./settings/Runner";
export { Credentials } from "./settings/Credentials";
export { ToolServers, DeployTargets } from "./settings/Tools";
export { Funding, ProjectBudgets } from "./settings/Funding";
export { ProjectsPage, ProjectRow, ProjectBrief, ArchiveProject } from "./settings/Projects";
export { Watchdog } from "./settings/Watchdog";
export { GoalCheck, StandingRules, Chapters, AdviceTimeout, WorkflowRetros, TicketPrefix, PermissionJudgeSetting, AutoTempCleanupSetting } from "./settings/Team";
export { FenceSetting, SecondOpinionSetting, NudgeCap, RunTimeLimit } from "./settings/Permissions";
export { WorkspaceDisk, RunLimits, WipLimits, CheckQueueSetting, EmailSetting, PrivateDetails, StopAllWork, SelfDeploy, TrialLines, useNow } from "./settings/System";
export { ServerPanel, ThisHost, NetguardAllow, deployerScriptLine } from "./settings/ThisHost";
export { Devices } from "./settings/Devices";
export { ExportCompany, ImportCompany } from "./settings/Transfer";

// The Settings menu (BOS-1019, from the approved structure in BOS-1018): 9 pages in 3 groups, each a URL of its own.
// "On wide screens it is a sticky menu column; on a phone #/settings opens on the menu itself.
export type SettingsPage = "funding" | "secrets" | "tools" | "reviews" | "team" | "watchdog" | "permissions" | "updates" | "limits" | "runner" | "email" | "server" | "devices" | "transfer";
type SettingsEntry = { id: SettingsPage; label: string; hint: string; help: string; allCompanies?: boolean; jump?: Array<{ id: string; label: string }> };
export const SETTINGS_GROUPS: ReadonlyArray<{ label: string; items: readonly SettingsEntry[] }> = [
  {
    label: "Money and access",
    items: [
      { id: "funding", label: "Funding", hint: "Accounts agents run on, and budgets", help: "The subscriptions and API accounts agents run on, so their cost and quota are tracked, and each project's budget." },
      { id: "secrets", label: "Secrets", hint: "Keys and tokens, and who gets them", help: "Every stored credential, who gets it, and when it was used." },
      { id: "tools", label: "Tools and deploys", hint: "Tool servers and deploy targets", help: "Tool servers (MCP) that give agents extra tools, and the deploy targets work can ship to." },
    ],
  },
  {
    label: "How the team works",
    items: [
      { id: "reviews", label: "Reviews", hint: "Who approves work at each risk level", help: "For each risk level, who approves a task's plan, who reviews its code, and whether you sign off before it merges. A project can override this on the Projects page." },
      {
        id: "team",
        label: "Team and CEO",
        hint: "Standing rules, the CEO, nudges, time limits",
        help: "How the team works together: its standing rules, the CEO's chapters, nudges, run time limit, workflow retros and ticket references.",
        jump: [
          { id: "standing-rules-h", label: "Standing rules" },
          { id: "chapters-h", label: "CEO chapters" },
          { id: "advice-timeout-h", label: "Asking the CEO for advice" },
          { id: "nudge-cap-h", label: "Nudges" },
          { id: "run-time-limit-h", label: "Run time limit" },
          { id: "retro-h", label: "Workflow retros" },
          { id: "ticket-prefix-h", label: "Ticket references" },
        ],
      },
      { id: "watchdog", label: "Watchdog", hint: "When the Scrum Master steps in", help: "The Scrum Master's watchdog: who it wakes, its limits and its safety cap." },
      {
        id: "permissions",
        label: "Permissions",
        hint: "What agents may do, and the fence",
        help: "Permission rules for what agents may do, advice on permission cards, the second opinion, and the agent fence.",
        jump: [
          { id: "rules-h", label: "Permission rules" },
          { id: "permission-judge-h", label: "Advice on permission cards" },
          { id: "second-opinion-h", label: "Second opinion" },
          { id: "fence-h", label: "Agent fence" },
        ],
      },
    ],
  },
  {
    // BOS-1492 (from BOS-1491): the old one-page "Server and runner" is split into six pages; the group takes its name,
    // so "Settings → Server and runner → Updates" and "→ Runner" stay true word for word.
    label: "Server and runner",
    items: [
      { id: "updates", label: "Updates", hint: "Stop all work, updates, the runner's update", help: "Stop all work, update this Boss Man and update the runners.", allCompanies: true },
      { id: "limits", label: "Limits and checks", hint: "Agents at once, tickets in progress, checks", help: "How many agents and tickets run at once, and who runs the checks.", allCompanies: true },
      { id: "runner", label: "Runner", hint: "The runner, and the disk for agents' work", help: "The company's runner: its state, its token and add-ons, and the disk for agents' work." },
      { id: "email", label: "Email", hint: "The server that sends Boss Man's email", help: "The outgoing mail server Boss Man sends its email through.", allCompanies: true },
      { id: "server", label: "This server", hint: "Version, this host, the network guard", help: "This server's version and role, the facts only you can give about its host, and the network guard.", allCompanies: true },
      { id: "devices", label: "Devices and privacy", hint: "Your screens, and private details to block", help: "The screens you use Boss Man on, and details agents must never put in public text.", allCompanies: true },
      { id: "transfer", label: "Import and export", hint: "Move a company in or out as one file", help: "Move a company in or out of Boss Man as one file: a backup, a copy for another Boss Man, or a template.", allCompanies: true },
    ],
  },
];
export const SETTINGS_PAGES = SETTINGS_GROUPS.flatMap((g) => g.items);
const settingsEntry = (id: string | undefined) => SETTINGS_PAGES.find((p) => p.id === id);
/** The address of a Settings page: its own URL for a company, else the menu. */
export const settingsPath = (companyId: string | undefined, page: SettingsPage) => (companyId ? `settings/${companyId}/${page}` : "settings");

/**
 * The old Settings addresses and anchors, kept working forever (BOS-1018 build notes). A route as the URL reader
 * makes it (`useRoute` splits on "/"), answered with the address that replaces it, or null for one that still works.
 */
export function settingsRedirect(route: readonly string[], companyId: string | undefined): string | null {
  const [page, ...rest] = route;
  if (page === "settings") {
    // The company's id is the first part after "settings"; the page is the second.
    if (rest.length <= 1) return null;
    const [company, tab] = [rest[0], rest[1]];
    if (settingsEntry(tab)) return null;
    // "Server and runner" was one page (`system`, BOS-1492): it is now a group of six. The old address opens the front
    // page, where that group's pages are one click away, rather than guessing which panel the link was after.
    if (tab === "system") return "settings";
    // The two tabs that were split up (BOS-1018's old → new map): their links land on the page that took each part.
    if (tab === "access") return `settings/${company}/tools`;
    if (tab === "workflow") return `settings/${company}/reviews`;
    // Any other page that no longer exists opens the menu rather than a page that is gone.
    return "settings";
  }
  if (page === "funding") return settingsPath(companyId, "funding");
  if (page === "secrets") return settingsPath(companyId, "secrets");
  // The Rules page was its own page; it is now Permissions, and its scope (a company id, or "all") is kept.
  if (page === "rules") return settingsPath(rest[0] && rest[0] !== "all" ? rest[0] : companyId, "permissions");
  return null;
}

/** "On this page" jump links: Tab reaches each one, and Enter moves focus to the section's heading. */
function JumpLinks({ items: all }: { items: NonNullable<SettingsEntry["jump"]> }) {
  // A section that is hidden (Updates when self-deploy is off) or still loading has no heading to jump to, so its
  // link is left out until it appears (BOS-1063).
  const [present, setPresent] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const read = () => {
      const next = new Set(all.filter((j) => document.getElementById(j.id)).map((j) => j.id));
      setPresent((old) => (old && old.size === next.size && [...next].every((i) => old.has(i)) ? old : next));
    };
    read();
    const watch = typeof MutationObserver === "function" ? new MutationObserver(read) : null;
    watch?.observe(document.body, { childList: true, subtree: true });
    return () => watch?.disconnect();
  }, [all]);
  const items = present ? all.filter((j) => present.has(j.id)) : all;
  if (items.length === 0) return null;
  return (
    <nav aria-label="On this page" className="set-jump">
      <span className="muted">On this page:</span>
      <ul>
        {items.map((j) => (
          <li key={j.id}>
            <a
              href={`#${j.id}`}
              onClick={(e) => {
                // The app routes on the URL hash, so letting the browser follow "#checks-h" would replace the route
                // (#/settings/c1/system) with an unknown one and fall back to the dashboard (BOS-1063). Scroll instead.
                e.preventDefault();
                document.getElementById(j.id)?.scrollIntoView?.({ behavior: "smooth", block: "start" });
                document.getElementById(j.id)?.focus?.({ preventScroll: true });
              }}
            >
              {j.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The Settings page shell: the menu of pages and the page itself. Each item is a page with its own URL, so the
 * menu is a list of links, not a tablist (BOS-1018 §3). Below 900 px the address `#/settings` opens the menu and a
 * page shows "‹ Settings" at the top.
 */
export function Settings({ companies, companyId, tab, go, onChanged, children }: { companies: Company[]; companyId: string | undefined; tab: string | undefined; go: (to: string) => void; onChanged: () => void; children?: ReactNode }) {
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  const current = settingsEntry(tab);
  const heading = useRef<HTMLHeadingElement>(null);
  // Focus goes to the page's title when the page changes (BOS-1018 §3), not on the first draw.
  const shown = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!current) return;
    if (shown.current === undefined) shown.current = current.id;
    else if (shown.current !== current.id) {
      shown.current = current.id;
      heading.current?.focus?.({ preventScroll: false });
    }
  }, [current]);
  const wizard = (
    <button type="button" className="btn" onClick={() => go("setup")}>
      Run the setup wizard
    </button>
  );
  const menu = (
    <nav aria-label="Settings" className={current ? "set-nav" : "set-nav set-nav-index"}>
      {SETTINGS_GROUPS.map((g) => (
        <div key={g.label} className="set-group">
          <h2 id={`set-group-${g.label.replace(/\W+/g, "-").toLowerCase()}`} className="set-group-label">
            {g.label}
          </h2>
          <ul aria-labelledby={`set-group-${g.label.replace(/\W+/g, "-").toLowerCase()}`}>
            {g.items.map((p) => (
              <li key={p.id}>
                <a href={`#/${settingsPath(company?.id, p.id)}`} aria-current={current?.id === p.id ? "page" : undefined} onClick={() => { if (p.id === current?.id) heading.current?.focus?.({ preventScroll: false }); }}>
                  <span className="set-item-label">{p.label}</span>
                  <span className="set-item-hint">{p.hint}</span>
                  <span className="set-item-chevron" aria-hidden="true">›</span>
                </a>
              </li>
            ))}
          </ul>
        </div>
      ))}
      <div className="set-wizard">{wizard}</div>
    </nav>
  );
  const line = !company ? (
    <p>
      Create a company on the Kanban first, or{" "}
      <button type="button" className="linkish" onClick={() => go("setup")}>
        run the setup wizard
      </button>
      .
    </p>
  ) : null;
  const panels: Record<SettingsPage, ReactNode> = {
    funding: (
      <>
        {company ? (
          <div key={company.id} style={{ display: "contents" }}>
            <Funding company={company} onChanged={onChanged} />
            <FundingCards />
            <ProjectBudgets company={company} />
            <BudgetLimits companies={companies} />
          </div>
        ) : (
          line
        )}
        <p className="muted" style={{ fontSize: 14 }}>
          Runs going now are on the <a href="#/runs">Runs page</a>.
        </p>
      </>
    ),
    secrets: <div className="embedded-page">{children}</div>,
    tools: company ? (
      <div key={company.id} style={{ display: "contents" }}>
        <ToolServers company={company} />
        <DeployTargets company={company} />
      </div>
    ) : (
      line
    ),
    reviews: company ? (
      <div key={company.id} style={{ display: "contents" }}>
        <Section id="reviews-h" title="Reviews">
          <p className="muted" style={{ fontSize: 14 }}>
            For each risk level, choose who approves a task's plan, who reviews its code, and whether you sign off before it merges. A project can override this on the Projects page.
          </p>
          <CompanyReviews companyId={company.id} agents={company.agents} />
        </Section>
        <GoalCheck company={company} onChanged={onChanged} />
      </div>
    ) : (
      line
    ),
    team: company ? (
      <div key={company.id} style={{ display: "contents" }}>
        <StandingRules company={company} onChanged={onChanged} />
        <Chapters company={company} />
        <AdviceTimeout company={company} onChanged={onChanged} />
        <NudgeCap company={company} onChanged={onChanged} />
        <RunTimeLimit company={company} onChanged={onChanged} />
        <WorkflowRetros company={company} />
        <TicketPrefix company={company} onChanged={onChanged} />
      </div>
    ) : (
      line
    ),
    watchdog: company ? <Watchdog key={company.id} company={company} /> : line,
    permissions: company ? (
      <div key={company.id} style={{ display: "contents" }}>
        <div className="embedded-page">{children}</div>
        <PermissionJudgeSetting company={company} onChanged={onChanged} />
        <AutoTempCleanupSetting company={company} onChanged={onChanged} />
        <SecondOpinionSetting company={company} />
        <FenceSetting company={company} onChanged={onChanged} />
      </div>
    ) : (
      line
    ),
    updates: (
      <>
        <SelfDeploy go={go} />
        <StopAllWork />
      </>
    ),
    limits: (
      <>
        <RunLimits />
        <WipLimits />
        <CheckQueueSetting />
      </>
    ),
    runner: company ? (
      <div key={company.id} style={{ display: "contents" }}>
        <Runner company={company} />
        <WorkspaceDisk company={company} onChanged={onChanged} />
      </div>
    ) : (
      line
    ),
    email: <EmailSetting />,
    server: (
      <>
        <ServerPanel />
        <ThisHost />
        <NetguardAllow />
      </>
    ),
    devices: (
      <>
        <Devices />
        <PrivateDetails />
      </>
    ),
    transfer: (
      <>
        {company ? <ExportCompany key={company.id} company={company} /> : line}
        <ImportCompany go={go} onChanged={onChanged} />
      </>
    ),
  };
  if (!current) {
    // The menu itself (BOS-1018 §3): the phone's opening screen, and where a bare #/settings lands.
    return (
      <>
        <header className="page-head">
          <div>
            <h1>Settings</h1>
            <p className="sub">How {company?.name ?? "this company"} and this Boss Man are set up. Projects and their repos are on the Projects page.</p>
          </div>
          <div className="set-head-wizard">{wizard}</div>
        </header>
        {menu}
      </>
    );
  }
  return (
    <>
      <header className="page-head">
        <div>
          <a className="set-back" href="#/settings" onClick={(e) => { e.preventDefault(); go("settings"); }}>
            ‹ Settings
          </a>
          <h1 ref={heading} tabIndex={-1}>
            {current.label}
            {current.allCompanies && <span className="tag set-scope">All companies</span>}
          </h1>
          <p className="sub">{current.help}</p>
        </div>
        <div className="set-head-wizard">{wizard}</div>
      </header>
      <div className="set-layout">
        {menu}
        <div className="set-page">
          {current.jump && <JumpLinks items={current.jump} />}
          <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>{panels[current.id]}</div>
        </div>
      </div>
    </>
  );
}
