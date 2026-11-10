import { Fragment, useState } from "react";
import { api } from "../../api";
import { usePoll } from "../../hooks";
import { when } from "../Runs";
import { CHECK_OK, CHECK_TROUBLE, OWNER_FACT_LABELS, STOPPED_CONTAINERS_KEY, problemText, stoppedContainerNames, type HostFactsView } from "../../host-facts-display";
import { Section, useAction } from "./shared";

type Health = { role: "leader" | "standby" | "single"; version: string; commit: string; colour: "blue" | "green" | null; startedAt: string };
type Colour = { colour: "blue" | "green"; up: boolean; role: string | null; commit: string | null; startedAt: string | null };
type BlueGreen = { enabled: false } | { enabled: true; self: "blue" | "green"; colours: Colour[] };
const ROLE_NOTE = { leader: "", standby: " (another copy is in charge; changes here are refused)", single: " (no leader lock)" };

/** Kept in the browser (BOS-924): the owner folds the reported facts away, and the choice stays as they left it. */
const HOST_FACTS_OPEN_KEY = "bossman.hostFacts.open";
const readHostFactsOpen = () => {
  try {
    return localStorage.getItem(HOST_FACTS_OPEN_KEY) === "1";
  } catch {
    return false;
  }
};

/** An add-on state saying it is not up (host-deployer.sh's states: running, stopped, needs_login, not installed). */
const ADDON_RUNNING = "running";
/** An add-on's name as the owner knows it (BOS-986), for the "isn't running" line. */
const ADDON_NAME: Record<string, string> = { tailscale: "private-network", ntfy: "phone-notification", penpot: "design-tool" };

/**
 * What is wrong with the reported facts, for the folded header, so folding never hides a problem (BOS-924):
 * a fact a card needs that is missing, a check that is failing, or an add-on that isn't running.
 */
function reportedProblems(d: HostFactsView): { missing: string[]; failing: string[]; addonsDown: string[] } {
  const missing: string[] = [];
  const failing: string[] = [];
  const addonsDown: string[] = [];
  for (const [k, f] of Object.entries(d.facts)) {
    const v = f.value.trim();
    if (!v) { if (!missing.includes(k)) missing.push(k); }
    else if (k.startsWith("addon.") && v.toLowerCase() !== ADDON_RUNNING) addonsDown.push(k.slice("addon.".length));
    else if (k.startsWith("check.")) {
      const last = k.slice(k.lastIndexOf(".") + 1);
      const wrong = CHECK_TROUBLE.test(last)
        ? v !== "0"
        : CHECK_OK.test(k)
          ? !/^(ok|pass|passed|healthy)$/i.test(v)
          : false;
      if (wrong) failing.push(k);
    }
  }
  for (const k of d.ownerFacts) if (!d.facts[k]?.value.trim() && !missing.includes(k)) missing.push(k);
  return { missing, failing, addonsDown };
}

/** The folded header's one line: what the problems are, in plain words, or nothing when all is well. */
function problemLine(p: { missing: string[]; failing: string[]; addonsDown: string[] }): string | null {
  const bits: string[] = [];
  if (p.missing.length) bits.push(`${p.missing.length} missing`);
  if (p.failing.length) bits.push(`${p.failing.length} check${p.failing.length === 1 ? "" : "s"} failing`);
  if (p.addonsDown.length) bits.push(`${p.addonsDown.length} add-on${p.addonsDown.length === 1 ? "" : "s"} not running`);
  return bits.length ? bits.join(" · ") : null;
}

/** The "Deployer script" line of Settings → This host (BOS-990). */
export function deployerScriptLine(s: { state: string; since?: string }): string {
  if (s.state === "current") return "current";
  if (s.state === "behind") return `behind${s.since ? ` (since ${when(s.since)})` : ""}. A card in your queue has the copy steps.`;
  return "unknown: this host's deployer is too old to report its version. A card in your queue has the copy steps.";
}

/** Settings → This host (BOS-419): what the host deployer reported, and the facts only the owner can confirm. */
export function ThisHost() {
  const facts = usePoll((signal) => api<HostFactsView>("/api/host-facts", { signal }), 30_000, "host-facts");
  const act = useAction();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(readHostFactsOpen);
  const d = facts.data;
  if (!d) return null;
  const keys = Object.keys(d.facts).sort();
  const problems = reportedProblems(d);
  const trouble = problemLine(problems);
  // BOS-986: name what is wrong, not the raw key. The stopped containers come from the host as a list; its reason the
  // code-host read failed comes with the probe result. Both are plain text the host wrote, shown as text only.
  const stopped = stoppedContainerNames(d.facts[STOPPED_CONTAINERS_KEY]?.value ?? "");
  const probeWhy = d.facts["repo.probeWhy"]?.value?.trim() ?? "";
  const problemTexts = [...problems.missing, ...problems.failing].map((k) => ({ key: k, text: problemText(k, d, stopped, probeWhy) }));
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(HOST_FACTS_OPEN_KEY, next ? "1" : "0");
    } catch {}
  };
  const save = (key: string) =>
    act.run(async () => {
      await api("/api/host-facts", { method: "PUT", body: { key, value: draft[key] ?? "" } });
      facts.reload();
      return "Saved.";
    });
  const summary = `${d.hostName ? `${d.hostName}, ` : ""}${when(d.reportedAt)}`;
  return (
    <Section id="this-host-h" title="This host">
      <p className="muted" style={{ fontSize: 14 }}>
        {d.reportedAt
          ? `What the host${d.hostName ? ` ${d.hostName}` : ""} last told Boss Man about itself, ${when(d.reportedAt)}. Agents' cards use these facts, so a card can't be raised while one it needs is missing.`
          : "The host hasn't reported yet. Once its deployer runs, its facts show up here."}
      </p>
      {d.deployerScript && d.deployerScript.state !== "none" && (
        <p data-testid="deployer-script" style={{ fontSize: 14 }}>
          <strong>Deployer script:</strong> {deployerScriptLine(d.deployerScript)}
        </p>
      )}
      {keys.length > 0 && (
        <div className="host-facts">
          <button type="button" className="host-facts-toggle" aria-expanded={open} aria-controls="host-facts-body" onClick={toggle}>
            <span className="pl-arrow" aria-hidden="true">{open ? "▾" : "▸"}</span>
            <span>
              Reported facts ({keys.length}) — {summary}
            </span>
            {trouble && (
              <span className="tag amber" data-testid="host-facts-problems">
                {trouble}
              </span>
            )}
          </button>
          <div id="host-facts-body" hidden={!open} style={open ? undefined : { display: "none" }}>
            {trouble && (
              <div className="muted" data-testid="host-facts-problem-detail" style={{ fontSize: 13 }}>
                <p style={{ marginTop: 0, marginBottom: 4 }}>Worth a look. Raw keys are in the list below.</p>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {problemTexts.map((p) => (
                    <li key={p.key}>{p.text}</li>
                  ))}
                  {problems.addonsDown.map((a) => (
                    <li key={`addon.${a}`}>
                      The {ADDON_NAME[a] ?? a} add-on isn't running, so whatever uses it can't be reached. Turn it back on for this host and it starts again; its own log says why it stopped.
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <dl data-testid="host-facts" className="host-facts-list">
              {keys.map((k) => {
                const f = d.facts[k]!;
                return (
                  <Fragment key={k}>
                    <dt className="mono">{k}</dt>
                    <dd>
                      <span className="mono host-fact-value">{f.value}</span> <span className="muted">({f.source === "host" ? "reported by the host" : "confirmed by you"})</span>
                      {f.conflict && (
                        <span className="error" role="alert">
                          {" "}
                          You confirmed "{f.conflict.confirmed}" but the host reports "{f.conflict.reported}". The host's value is used.
                        </span>
                      )}
                    </dd>
                  </Fragment>
                );
              })}
            </dl>
          </div>
        </div>
      )}
      <h3 style={{ fontSize: 15, fontWeight: 600 }}>Facts only you can give</h3>
      {d.ownerFacts.map((k) => (
        <div key={k} style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label htmlFor={`hf-${k}`}>{OWNER_FACT_LABELS[k] ?? k}</label>
          <input id={`hf-${k}`} className="mono" maxLength={500} placeholder={d.facts[k]?.value ?? ""} value={draft[k] ?? ""} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
          <button type="button" className="btn" disabled={act.busy || !(draft[k] ?? "").trim() || d.facts[k]?.source === "host"} onClick={() => void save(k)}>
            Confirm
          </button>
        </div>
      ))}
      {act.view}
    </Section>
  );
}

type AutomaticEntryView = {
  address: string;
  kind: "tool server" | "git host";
  name: string;
  company: string | null;
  trusted: boolean;
  notAllowed: string | null;
};

type NetguardAllowView = {
  report: {
    mode: string | null;
    entries: { entry: string; coveredBy: string[]; note: string | null }[] | null;
    lineCanGo: boolean;
    automatic: AutomaticEntryView[] | null;
    env: { lines: string[][]; reportedAt: string; envFound: boolean } | null;
    warnings: string[];
  } | null;
};

/** What an address the guard opens by itself is, in plain words. */
function automaticLabel(e: AutomaticEntryView): string {
  return e.kind === "git host" ? `git host for the project "${e.name}"` : `tool server "${e.name}"`;
}

/**
 * Settings → Network guard (BOS-770, BOS-791): what runners may reach. The addresses Boss Man opens by itself (each
 * company's tool servers and project git hosts), then the owner's own BOSSMAN_NETGUARD_ALLOW lines from .env, with the
 * ones Boss Man already covers marked. An address the guard now drops shows as not allowed, with the reason.
 * Read only: it never changes .env.
 */
export function NetguardAllow() {
  const q = usePoll((signal) => api<NetguardAllowView>("/api/netguard-allow", { signal }), 60_000, "netguard-allow");
  const r = q.data?.report;
  if (!r) return null;
  const lines = r.env?.lines ?? [];
  const automatic = r.automatic ?? [];
  const notAllowed = automatic.filter((e) => e.notAllowed !== null);
  return (
    <Section id="netguard-allow-h" title="Network guard">
      <p className="muted" style={{ fontSize: 14 }}>
        Two lists: the addresses Boss Man opens for your runners by itself, and any extra addresses you added in your .env. This page only reports; it never changes .env.
      </p>
      {r.mode === "off" && <p>The network guard is turned off (BOSSMAN_NETGUARD=off), so these lists aren't used.</p>}
      <h3 style={{ fontSize: 15, fontWeight: 600 }}>Allowed automatically</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        Addresses Boss Man opens itself: each company's tool servers and its projects' git hosts. A company's entries are only reachable from that company's own runners.
      </p>
      {r.automatic === null ? (
        <p className="muted" data-testid="netguard-automatic-unknown">Boss Man couldn't work out the addresses it opens by itself just now.</p>
      ) : automatic.length === 0 ? (
        <p data-testid="netguard-automatic-empty">Boss Man opens no extra addresses by itself: no tool servers, no project git addresses.</p>
      ) : (
        <ul data-testid="netguard-automatic" style={{ fontSize: 14 }}>
          {automatic.map((e) => (
            <li key={`${e.company ?? ""}|${e.address}`}>
              <span className="mono">{e.address}</span> <span className="muted">· {automaticLabel(e)}</span>
              {e.company && <span className="muted"> · for {e.company}</span>}
              {e.notAllowed ? (
                <span className="error" data-testid="netguard-not-allowed"> · {e.notAllowed}</span>
              ) : (
                <span className="muted"> · allowed</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {notAllowed.length > 0 && (
        <p className="error" role="alert" data-testid="netguard-not-allowed-summary">
          {notAllowed.length === 1 ? "One address above is not allowed" : `${notAllowed.length} addresses above are not allowed`}, so runners can't reach {notAllowed.length === 1 ? "it" : "them"}.
        </p>
      )}
      <h3 style={{ fontSize: 15, fontWeight: 600 }}>Extra lines from your .env</h3>
      <p className="muted" style={{ fontSize: 14 }}>
        Addresses you added in the BOSSMAN_NETGUARD_ALLOW line in your .env, so every runner may reach them. Anything Boss Man already opens by itself doesn't need a line here.
      </p>
      {r.entries === null ? (
        <p className="muted">The launcher didn't say which entries it uses (it isn't running, or it is older than this page).</p>
      ) : r.entries.length === 0 ? (
        <p data-testid="netguard-allow-empty">You have no extra lines.</p>
      ) : (
        <ul data-testid="netguard-allow-entries" style={{ fontSize: 14 }}>
          {r.entries.map((e) => (
            <li key={e.entry}>
              <span className="mono">{e.entry}</span>
              {e.note && <span className="muted"> · {e.note}</span>}
            </li>
          ))}
        </ul>
      )}
      {r.lineCanGo && r.entries && r.entries.length > 1 && <p data-testid="netguard-allow-line-can-go">Every entry is already allowed by Boss Man; this line can go.</p>}
      {r.env && lines.length > 1 && (
        <div style={{ fontSize: 14 }}>
          <p>Lines in .env (the host reported {when(r.env.reportedAt)}):</p>
          <ol>
            {lines.map((l, i) => (
              <li key={i}>
                <span className="mono">{l.join(" ") || "(empty)"}</span> <span className="muted">{i === lines.length - 1 ? "(used)" : "(ignored)"}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {r.warnings.map((w) => (
        <p key={w} className="error" role="alert">
          {w}
        </p>
      ))}
    </Section>
  );
}

export function ServerPanel() {
  const h = usePoll((signal) => api<Health>("/api/health", { signal }), 10_000, "server-role");
  const bg = usePoll((signal) => api<BlueGreen>("/api/bluegreen", { signal }), 10_000, "bluegreen");
  if (!h.data) return null;
  const { role, version, commit, startedAt } = h.data;
  const b = bg.data;
  return (
    <Section id="server-h" title="Server">
      <dl className="facts" data-testid="server-role">
        <dt>Role</dt>
        <dd>
          <strong>{role}</strong>
          {ROLE_NOTE[role]}
        </dd>
        <dt>Version</dt>
        <dd>
          {version} · <span className="mono">{commit.slice(0, 7)}</span>
        </dd>
        <dt>Running since</dt>
        <dd>{when(startedAt)}</dd>
        {b?.enabled && (
          <>
            <dt>Blue/green</dt>
            <dd>
              On. This page comes from <span className={`tag ${b.self}`}>{b.self}</span>
            </dd>
            {b.colours.map((c) => (
              <ColourRow key={c.colour} c={c} />
            ))}
            {b.colours.some((c) => !c.up) && (
              <>
                <dt>Note</dt>
                <dd data-testid="colour-down-note">
                  {b.colours.find((c) => c.colour === b.self)?.role === "leader"
                    ? "One colour is not running, so there is nothing to switch back to. This is normal after a finished update (the old copy is stopped on purpose); if it is not, check the last update's result."
                    : "This copy is not leading and the other colour is not running, so nothing is in charge. Start the live colour on the host and send it SIGUSR2; the update's alert lists the exact commands. If both colours are stopped this page cannot load at all, so use that alert."}
                </dd>
              </>
            )}
          </>
        )}
      </dl>
    </Section>
  );
}

function ColourRow({ c }: { c: Colour }) {
  const state = !c.up ? "Not running" : c.role === "leader" ? "Live" : c.role === "standby" ? "Standby" : (c.role ?? "Up");
  return (
    <>
      <dt>
        <span className={`tag ${c.colour}`}>{c.colour}</span>
      </dt>
      <dd>
        <span className={c.up ? undefined : "muted"}>{state}</span>
        {c.up && c.commit && (
          <span className="muted">
            {" "}
            · <span className="mono">{c.commit.slice(0, 7)}</span>
            {c.startedAt ? ` · running since ${when(c.startedAt)}` : ""}
          </span>
        )}
      </dd>
    </>
  );
}
