import { useState } from "react";
import { api, type Company, type FundingSource } from "../../api";
import { usePoll } from "../../hooks";
import { toBase64 } from "../Skills";
import { ReadOnlyText } from "../../components/ReadOnlyText";
import { Section, useAction } from "./shared";

type ImportPreview = {
  company: { name: string; nameTaken: boolean };
  counts: Record<"agents" | "skills" | "projects" | "objectives" | "features" | "toolServers" | "wikiPages" | "tickets", number>;
  agents: Array<{ name: string; role: string; title: string | null; agentKind: string; model: string | null; instructions: string | null }>;
  skills: Array<{ name: string; renamedFrom: string | null; description: string; scripts: string[] }>;
  secrets: Array<{ name: string; envName: string; agents: string[] }>;
  projects: Array<{ name: string; verifyCommand: string | null; deepVerifyCommand: string | null }>;
  toolServers: Array<{ name: string; url: string; opens: string | null; stackService: boolean }>;
  gitHosts: Array<{ project: string; url: string; opens: string | null; stackService: boolean }>;
  /** BOS-2242: one plain line per company setting the package carries (agent approvals, templates, retro, second opinion).
   * Optional: a server from before BOS-2242 answers without it, and the page must still render. */
  settings?: string[];
  warnings: string[];
};

/** Downloads the company as one zip (docs/11). Secret values are never in it. */
export function ExportCompany({ company }: { company: Company }) {
  const [wiki, setWiki] = useState(true);
  const [tickets, setTickets] = useState<"none" | "open" | "all">("open");
  return (
    <Section id="export-h" title={`Export ${company.name}`}>
      <p className="muted" style={{ fontSize: 14 }}>
        One zip with the company's agents and their instructions, skills, projects, plan, tool servers, deploy targets, permission rules and the company's own settings. Secrets are listed by name and who has them; their values never leave Boss Man.
      </p>
      <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="checkbox" checked={wiki} onChange={(e) => setWiki(e.target.checked)} /> Include the wiki
      </label>
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        <label htmlFor="export-tickets">Tickets</label>
        <select id="export-tickets" value={tickets} onChange={(e) => setTickets(e.target.value as typeof tickets)}>
          <option value="none">None</option>
          <option value="open">Open ones only</option>
          <option value="all">All, including done</option>
        </select>
        <a className="btn" href={`/api/companies/${company.id}/export?wiki=${wiki ? 1 : 0}&tickets=${tickets}`} download>
          Download
        </a>
      </div>
    </Section>
  );
}

/** Reads a package, shows what it holds, then creates it as a new company (docs/11). */
export function ImportCompany({ go, onChanged }: { go: (to: string) => void; onChanged: () => void }) {
  const [zip, setZip] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [name, setName] = useState("");
  const [funding, setFunding] = useState("");
  const [allowStack, setAllowStack] = useState(false);
  const [done, setDone] = useState<{ companyId: string; name: string; checklist: string[] } | null>(null);
  const sources = usePoll((signal) => api<FundingSource[]>("/api/funding-sources", { signal }), 60_000, "sources");
  const act = useAction();
  const look = async (z: string, n?: string) => {
    const p = await api<ImportPreview>("/api/companies/import/preview", { method: "POST", body: { zip: z, ...(n ? { name: n } : {}) } });
    setPreview(p);
    setAllowStack(false);
    setName(p.company.name);
  };
  const pick = (f: File | undefined) => {
    setPreview(null);
    setDone(null);
    if (!f) return;
    void act.run(async () => {
      const z = toBase64(new Uint8Array(await f.arrayBuffer()));
      setZip(z);
      await look(z);
    });
  };
  // A new name is checked again before Import is offered, so a clash is caught here, not by the server.
  const nameChanged = !!preview && name.trim() !== preview.company.name;
  const scripts = preview?.skills.filter((s) => s.scripts.length) ?? [];
  const stackTools = preview?.toolServers.filter((t) => t.stackService) ?? [];
  const stackGit = preview?.gitHosts.filter((g) => g.stackService) ?? [];
  return (
    <Section id="import-h" title="Import a company">
      <p className="muted" style={{ fontSize: 14 }}>
        Pick a zip of either a Boss Man export (<code>.bossman.zip</code>) or a <strong>Paperclip company export</strong>. For Paperclip, put <code>paperclip-issues.json</code> next to <code>COMPANY.md</code> first to bring its tickets, comments and documents too (see docs/14-paperclip-migration.md). Nothing is created until you press Import. It becomes a new company with every agent paused and no secrets: you add those yourself.
      </p>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <label htmlFor="import-file">Package</label>
        <input id="import-file" type="file" accept=".zip,application/zip" onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      {preview && !done && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 12 }}>
          <p style={{ fontSize: 14 }}>
            {preview.counts.agents} agents, {preview.counts.skills} skills, {preview.counts.projects} projects, {preview.counts.objectives} objectives, {preview.counts.features} features, {preview.counts.toolServers} tool servers, {preview.counts.wikiPages} wiki pages and {preview.counts.tickets} tickets.
          </p>
          {preview.warnings.map((w) => (
            <p key={w} className="error" style={{ fontSize: 14 }}>
              {w}
            </p>
          ))}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label htmlFor="import-name">Company name</label>
            <input id="import-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
            {nameChanged && (
              <button type="button" className="btn" disabled={act.busy || !zip || !name.trim()} onClick={() => zip && void act.run(() => look(zip, name.trim()))}>
                Check name
              </button>
            )}
          </div>
          {preview.company.nameTaken && !nameChanged && (
            <p className="error" style={{ fontSize: 14 }}>
              There's already a company called {preview.company.name}. Give this one another name.
            </p>
          )}
          <details>
            <summary>Agents ({preview.agents.length}) and their instructions</summary>
            <ul>
              {preview.agents.map((a) => (
                <li key={a.name}>
                  <strong>{a.name}</strong>: {a.title ?? a.role}, {a.agentKind}
                  {a.model ? `, ${a.model}` : ""}
                  {a.instructions && <ReadOnlyText text={a.instructions} label={`${a.name}'s instructions`} />}
                </li>
              ))}
            </ul>
          </details>
          {scripts.length > 0 && (
            <div style={{ fontSize: 14 }}>
              <strong>Skills that ship scripts.</strong> Read these before an agent uses them:
              <ul>
                {scripts.map((s) => (
                  <li key={s.name}>
                    {s.name}: {s.scripts.join(", ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(preview.settings ?? []).length > 0 && (
            <div style={{ fontSize: 14 }}>
              <strong>The company's own settings.</strong> These come in with it:
              <ul>
                {(preview.settings ?? []).map((s) => (
                  <li key={s} style={{ whiteSpace: "pre-wrap" }}>
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.projects.length > 0 && (
            <div style={{ fontSize: 14 }}>
              <strong>Checks each project runs.</strong> These commands run on the runner before work is merged. Read them before you import:
              <ul>
                {preview.projects.map((p, i) => (
                  <li key={i}>
                    {p.name}: {p.verifyCommand ? <code style={{ whiteSpace: "pre-wrap" }}>{p.verifyCommand}</code> : "none"}
                    {p.deepVerifyCommand && (
                      <>
                        {" "}
                        (full check: <code style={{ whiteSpace: "pre-wrap" }}>{p.deepVerifyCommand}</code>)
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.toolServers.length > 0 && (
            <div style={{ fontSize: 14 }}>
              <strong>Tool servers.</strong> Each address below is opened past the runner's network guard for this company:
              <ul>
                {preview.toolServers.map((t) => (
                  <li key={t.name}>
                    {t.name}: <code>{t.opens ?? "nothing (no address the guard can allow)"}</code> ({t.url})
                    {t.stackService && <span className="error"> This is one of Boss Man's own services or a private-network address.</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview.gitHosts.length > 0 && (
            <div style={{ fontSize: 14 }}>
              <strong>Project git addresses.</strong> Each is opened past the runner's network guard for this company so its agents can clone:
              <ul>
                {preview.gitHosts.map((g) => (
                  <li key={g.project}>
                    {g.project}: <code>{g.opens ?? "nothing (no address the guard can allow)"}</code> ({g.url})
                    {g.stackService && <span className="error"> This is one of Boss Man's own services or a private-network address.</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(stackTools.length > 0 || stackGit.length > 0) && (
            <label>
              <input type="checkbox" checked={allowStack} onChange={(e) => setAllowStack(e.target.checked)} /> I understand this gives the runner a direct path to Boss Man's own services or your private network, and I want it anyway.
            </label>
          )}
          {preview.secrets.length > 0 && (
            <div style={{ fontSize: 14 }}>
              <strong>Secrets to add afterwards</strong>
              <ul>
                {preview.secrets.map((s) => (
                  <li key={s.envName}>
                    {s.name} as {s.envName}
                    {s.agents.length ? ` for ${s.agents.join(", ")}` : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <label htmlFor="import-funding">Funding for every agent</label>
            <select id="import-funding" value={funding} onChange={(e) => setFunding(e.target.value)}>
              <option value="">Set later</option>
              {(sources.data ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <button
              type="button"
              className="btn primary"
              disabled={act.busy || !zip || !name.trim() || nameChanged || preview.company.nameTaken || (stackTools.length > 0 && !allowStack)}
              onClick={() =>
                void act.run(async () => {
                  const r = await api<{ companyId: string; name: string; checklist: string[] }>("/api/companies/import", { method: "POST", body: { zip, name: name.trim(), fundingSourceId: funding || null, allowStackServices: allowStack } });
                  setDone(r);
                  onChanged();
                })
              }
            >
              Import as a new company
            </button>
          </div>
        </div>
      )}
      {done && (
        <div role="status" style={{ marginTop: 12 }}>
          <p>{done.name} was imported. What's left (also on the Decisions page):</p>
          <ul>
            {done.checklist.map((x) => (
              <li key={x} style={{ whiteSpace: "pre-wrap" }}>
                {x}
              </li>
            ))}
          </ul>
          <button type="button" className="btn" onClick={() => go(`settings/${done.companyId}/runner`)}>
            Open {done.name}'s settings
          </button>
        </div>
      )}
      {act.view}
    </Section>
  );
}
