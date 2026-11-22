// The company's own choices that live in the server's settings table under a per-company key (BOS-2242), and how a
// company package carries them: settings.json in the export, screened and applied on import. Every per-company key
// Boss Man writes is named here, either carried or left out with its reason; a test reads the server's source and fails
// on a new key that is on neither list, so the next owner choice can't be dropped from the package without anyone deciding.
import { eq, inArray, like } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client.js";
import { secrets, settings, wikiSemanticSettings } from "../db/schema.js";
import type { AgentApprovals } from "./agents.js";
import { SecondOpinionSettings } from "./second-opinion.js";

/** Carried keys, by the prefix before ":<companyId>". */
export const CARRIED_SETTING_KEYS = {
  agentApprovals: "agent_approvals",
  gitTemplates: "git_templates",
  retro: "retro",
  secondOpinion: "second-opinion",
} as const;

/** Per-company keys a package leaves out on purpose, and why. */
export const LEFT_OUT_SETTING_KEYS: Record<string, string> = {
  weekly_summary: "the owner's email address is personal data, and the mail server is set up per server",
  models: "the model lists a runner observed belong to that server's runner",
  "team-scope": "notes queued for the CEO's next run on this server",
  "watchdog-trip": "an alert marker",
  account: "an alert marker per funding source",
  "quota-held": "an alert marker per funding source",
  "spare-capacity": "an alert marker",
  "fence-default": "a once-only card marker",
  "fence-unavailable": "an alert marker",
  "guard-unavailable": "an alert marker",
  "idle-slots": "an alert marker",
  "runner-hand": "how this server's runner is started",
  merge_brake_off: "an alert marker",
  merge_jam: "an alert marker",
  merge_slow_note: "an alert marker",
  live_unplaced: "a marker about this server's merges",
  "no-progress": "an alert marker",
  platform: "an alert marker",
  runner_need_unknown: "an alert marker",
  "spend-rate": "this server's daily spend figures",
  spend_rate_alerted: "an alert marker",
  "unblocked-catchup": "a card marker",
  // Not settings rows: rate counters and card keys that happen to be shaped like one.
  act: "a portal rate counter, not a setting",
  idea: "a portal rate counter, not a setting",
  mail: "a portal rate counter, not a setting",
  portal: "a portal rate counter, not a setting",
};

/**
 * Strictest first: a package can raise the default, never lower it. Its own copy of agents.ts's AGENT_APPROVALS, because
 * importing that one at load time is circular (agents.ts → … → company-import.ts); a test checks the two hold the same values.
 */
export const APPROVALS_STRICTNESS = ["hires_and_edits", "hires", "nothing"] as const satisfies readonly AgentApprovals[];
const DEFAULT_APPROVALS: AgentApprovals = "hires";
const APPROVALS_WORDS: Record<AgentApprovals, string> = {
  hires_and_edits: "hires, model and instruction changes wait for you",
  hires: "hires and model changes wait for you; instruction changes apply at once",
  nothing: "nothing waits for you",
};

/** The same limits as the owner's template form. */
const Template = z.string().min(1).max(5000);

export const PackageSettings = z
  .object({
    agentApprovals: z.enum(APPROVALS_STRICTNESS).optional().catch(undefined),
    gitTemplates: z.object({ commit: Template, pr: Template }).partial().optional().catch(undefined),
    /** The agent's folder name in the package, like reportsTo. */
    retroAgent: z.string().max(120).nullable().optional().catch(undefined),
    /** Address and model; the key by its secret's name only. Never on, whatever the package says. */
    secondOpinion: z
      .object({ baseUrl: SecondOpinionSettings.shape.baseUrl, model: SecondOpinionSettings.shape.model, secret: z.string().max(200).nullable().optional() })
      .optional()
      .catch(undefined),
  })
  .catch({});
export type PackageSettings = z.infer<typeof PackageSettings>;

const keyOf = (prefix: string, companyId: string) => `${prefix}:${companyId}`;

/** What settings.json holds for one company. Only what the owner set: an unset key stays out and takes the default on import. */
export async function exportSettings(db: Db, companyId: string, agentSlug: Map<string, string>): Promise<PackageSettings> {
  const keys = Object.values(CARRIED_SETTING_KEYS).map((p) => keyOf(p, companyId));
  const rows = await db.select().from(settings).where(inArray(settings.key, keys));
  const value = (prefix: string) => rows.find((r) => r.key === keyOf(prefix, companyId))?.value;
  const out: PackageSettings = {};

  const approvals = value(CARRIED_SETTING_KEYS.agentApprovals);
  if ((APPROVALS_STRICTNESS as readonly unknown[]).includes(approvals)) out.agentApprovals = approvals as AgentApprovals;

  const templates = value(CARRIED_SETTING_KEYS.gitTemplates) as { commit?: unknown; pr?: unknown } | undefined;
  if (templates && typeof templates === "object") {
    const t = { ...(typeof templates.commit === "string" ? { commit: templates.commit } : {}), ...(typeof templates.pr === "string" ? { pr: templates.pr } : {}) };
    if (Object.keys(t).length) out.gitTemplates = t;
  }

  const retroId = (value(CARRIED_SETTING_KEYS.retro) as { agentId?: unknown } | undefined)?.agentId;
  // A retired or unknown agent has no folder in the package, so the choice is dropped and the import uses the default.
  if (typeof retroId === "string" && agentSlug.has(retroId)) out.retroAgent = agentSlug.get(retroId)!;

  const so = SecondOpinionSettings.safeParse(value(CARRIED_SETTING_KEYS.secondOpinion));
  if (so.success && (so.data.baseUrl || so.data.model || so.data.secretId)) {
    const [s] = so.data.secretId ? await db.select({ name: secrets.name }).from(secrets).where(eq(secrets.id, so.data.secretId)) : [];
    out.secondOpinion = { baseUrl: so.data.baseUrl, model: so.data.model, secret: s?.name ?? null };
  }
  return out;
}

const host = (u: string) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** The hosts this server already sends a secret to: any company's second opinion or semantic wiki search set up with it. */
async function sentTo(db: Db, secretId: string): Promise<Set<string>> {
  const out = new Set<string>(); // not state: a local built and returned on each call
  const so = await db.select({ value: settings.value }).from(settings).where(like(settings.key, `${CARRIED_SETTING_KEYS.secondOpinion}:%`));
  for (const r of so) {
    const v = SecondOpinionSettings.safeParse(r.value);
    if (v.success && v.data.secretId === secretId && v.data.baseUrl) out.add(host(v.data.baseUrl));
  }
  for (const w of await db.select({ baseUrl: wikiSemanticSettings.baseUrl }).from(wikiSemanticSettings).where(eq(wikiSemanticSettings.secretId, secretId))) out.add(host(w.baseUrl));
  return out;
}

/**
 * What of the package's settings an import applies, and a plain line for each. Pure apart from looking up the
 * second opinion's secret by name on this server, so the preview and the apply agree.
 */
export async function screenSettings(db: Db, s: PackageSettings, agentSlugs: Array<{ slug: string; name: string }>) {
  const lines: string[] = [];
  const todo: string[] = [];

  let approvals: AgentApprovals | null = null;
  if (s.agentApprovals) {
    const stricter = APPROVALS_STRICTNESS.indexOf(s.agentApprovals) <= APPROVALS_STRICTNESS.indexOf(DEFAULT_APPROVALS) ? s.agentApprovals : DEFAULT_APPROVALS;
    approvals = stricter;
    lines.push(
      stricter === s.agentApprovals
        ? `Agent changes: ${APPROVALS_WORDS[stricter]}, as in the package.`
        : `Agent changes: ${APPROVALS_WORDS[stricter]}. The package had "${APPROVALS_WORDS[s.agentApprovals]}", which is looser than the default, so the default was kept. To change it, use the Agents page.`,
    );
  }

  const templates = s.gitTemplates && Object.keys(s.gitTemplates).length ? s.gitTemplates : null;
  // Agents get these as instructions on every commit and PR, so the owner reads them word for word, like standing rules (BOS-2246).
  if (templates?.commit) lines.push(`Commit message template from the package. Agents are given it as an instruction on every commit, so read it:\n${templates.commit}`);
  if (templates?.pr) lines.push(`PR message template from the package. Agents are given it as an instruction on every pull request, so read it:\n${templates.pr}`);

  let retroSlug: string | null = null;
  if (s.retroAgent) {
    const a = agentSlugs.find((x) => x.slug === s.retroAgent);
    if (a) {
      retroSlug = a.slug;
      lines.push(`Workflow retros: run by ${a.name}, as in the package.`);
    } else lines.push(`Workflow retros: the package names an agent ("${s.retroAgent}") that isn't in it, so the default runs them (the Product Manager, else the CEO).`);
  }

  let secondOpinion: { baseUrl: string; model: string; secretId: string | null } | null = null;
  if (s.secondOpinion) {
    const { baseUrl, model, secret } = s.secondOpinion;
    const [found] = secret ? await db.select({ id: secrets.id }).from(secrets).where(eq(secrets.name, secret)) : [];
    // Secrets are server-wide and the package picks both the name and the address, so a package from outside could pair a
    // common name with an address of its choosing (BOS-2246). The existing key is linked only when the owner already sends
    // it to that same host; otherwise it stays unlinked and the owner is told which secret and which host the package named.
    const to = baseUrl ? host(baseUrl) : "";
    const linked = !!found && !!to && (await sentTo(db, found.id)).has(to);
    secondOpinion = { baseUrl, model, secretId: linked ? found!.id : null };
    // It can allow permission cards, so it never comes in on: the owner looks at the address and model first.
    const what = [model ? `model ${model}` : null, to ? `at ${to}` : null].filter(Boolean).join(" ");
    lines.push(`Second opinion on permission cards: comes in switched off${what ? `, set to ${what}` : ""}. Check it, then switch it on in Settings → Permissions → Second opinion.`);
    if (linked) lines.push(`The second opinion's key is your existing secret "${secret}", which you already use with ${to}. Switching it on, or pressing Test, sends that key to ${to}.`);
    else if (found)
      todo.push(
        `The package names your existing secret "${secret}" as the second opinion's key${to ? ` for ${to}` : ""}. It was not linked, because you don't use that secret with ${to || "that address"} anywhere yet. Only if you trust ${to || "the address"}, pick it as the key in Settings → Permissions → Second opinion: switching it on sends that key there.`,
      );
    else if (secret) todo.push(`Add the secret "${secret}" and pick it as the second opinion's key in Settings → Permissions → Second opinion.`);
  }
  return { approvals, templates, retroSlug, secondOpinion, lines, todo };
}

/** Writes the screened settings for the new company, inside the import's transaction. */
export async function applySettings(tx: Db, companyId: string, screened: Awaited<ReturnType<typeof screenSettings>>, agentIdOf: (slug: string) => string | undefined) {
  const put = async (prefix: string, value: unknown) => {
    await tx.insert(settings).values({ key: keyOf(prefix, companyId), value }).onConflictDoUpdate({ target: settings.key, set: { value } });
  };
  if (screened.approvals) await put(CARRIED_SETTING_KEYS.agentApprovals, screened.approvals);
  if (screened.templates) await put(CARRIED_SETTING_KEYS.gitTemplates, screened.templates);
  const retroId = screened.retroSlug ? agentIdOf(screened.retroSlug) : undefined;
  if (retroId) await put(CARRIED_SETTING_KEYS.retro, { agentId: retroId });
  if (screened.secondOpinion) await put(CARRIED_SETTING_KEYS.secondOpinion, SecondOpinionSettings.parse({ enabled: false, ...screened.secondOpinion }));
}
