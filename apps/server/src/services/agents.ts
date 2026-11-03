// The Agents tab (R62): who works for each company, what they cost this month, and every change
// to them, with what it was before so it can be undone.
import { and, desc, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { AGENT_TEMPLATES, CEO_TEMPLATE, FUNDING_PROVIDERS, HARNESSES, harnessLabel, providerLabel, speakerNameProblem } from "@boss-man/shared";
import type { Db } from "../db/client.js";
import { agentAvatars, agentChanges, agents, ceoChapters, costEvents, decisions, fundingSources, paAnswers, projects, runs, settings, skills, ticketImages, tickets, wakes } from "../db/schema.js";
import { record as logActivity } from "./activity.js";
import { pictureType } from "./company-import.js";
import { MODEL_APPROVE, MODEL_EDIT, MODEL_REJECT, TEAM_HIRE, TEAM_NOT_NOW, type AgentModelConfig, type HireProposal, type TeamHire } from "./decisions.js";
import type { ModelChoice } from "./models.js";
import { getStandingRules, normalizeStandingRules, setStandingRules, standingRulesError, StandingRulesError } from "./standing-rules.js";

export class AgentError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type AgentRow = typeof agents.$inferSelect;
export type AgentPatch = Partial<Pick<AgentRow, "name" | "title" | "instructions" | "model" | "thinking" | "fundingSourceId" | "agentKind" | "paused" | "starred">>;
/** Fields whose changes are kept, and can be undone, under the name the history shows. */
const TRACKED: Array<[keyof AgentPatch, string]> = [
  ["name", "name"],
  ["title", "title"],
  ["instructions", "instructions"],
  ["model", "model"],
  ["thinking", "thinking"],
  ["fundingSourceId", "funding"],
  ["agentKind", "kind"],
  ["paused", "paused"],
];
const FIELD_COLUMN = Object.fromEntries(TRACKED.map(([col, field]) => [field, col])) as Record<string, keyof AgentPatch>;
const OPEN = ["backlog", "ready", "in_progress", "blocked", "review"] as const;

/** What the CEO may do to the team without asking the owner (R62). */
export const AGENT_APPROVALS = ["hires", "hires_and_edits", "nothing"] as const;
export type AgentApprovals = (typeof AGENT_APPROVALS)[number];
export const HIRE = "Hire";
export const DONT_HIRE = "Don't hire";
export const APPLY = "Apply the change";
export const KEEP = "Keep them as they are";

/** The name limits the Agents page has always used (BOS-265). */
export const NAME_MAX = 80;
/** A picture copied from a ticket image is capped as an owner's upload is; it is inlined into every run start. */
const AVATAR_MAX_BYTES = 256 * 1024;
const REASON_MAX = 240;

type Notify = (n: { companyId: string; agentId: string | null; level: "note" | "flag"; title: string; body: string | null; link: string }) => Promise<unknown>;
type ModelCatalog = { runner: Record<string, { models: ModelChoice[]; observedAt?: string }>; api: Array<{ fundingSourceId: string; name: string; provider: string; models: ModelChoice[]; error: string | null }> };
type Catalog = (companyId: string) => Promise<ModelCatalog>;

/** Which funding providers can run on each harness; a mismatch would launch an agent that can't work. */
const HARNESS_PROVIDERS: Record<string, readonly string[]> = {
  claude: ["anthropic", "bedrock", "foundry", "gateway", "openrouter"],
  codex: ["openai", "bedrock", "foundry", "gateway"],
  opencode: FUNDING_PROVIDERS,
};
const CLAUDE_ALIASES = new Set(["default", "opus", "sonnet", "haiku", "fable"]);
const labelConfig = (c: AgentModelConfig) => `Harness: ${harnessLabel(c.harness)} · Provider: ${c.provider ? providerLabel(c.provider) : "not set"} · Model: ${c.model || "default"} · Paid from: ${c.fundingSourceName || (c.fundingSourceId ? c.fundingSourceId : "not set")}`;

export function agentsService(db: Db, opts: { now?: () => Date; notify?: Notify; assignPlanned?: (companyId: string, hired: AgentRow, ticketIds: string[]) => Promise<unknown>; catalog?: Catalog } = {}) {
  const now = opts.now ?? (() => new Date());
  const notify: Notify = opts.notify ?? (async () => undefined);

  async function agent(id: string) {
    const [a] = await db.select().from(agents).where(eq(agents.id, id));
    if (!a) throw new AgentError(404, "No such agent.");
    return a;
  }

  async function record(a: AgentRow, field: string, before: unknown, after: unknown, byAgentId: string | null) {
    await db.insert(agentChanges).values({ companyId: a.companyId, agentId: a.id, byAgentId, field, before: before ?? null, after: after ?? null });
  }

  async function approvals(companyId: string): Promise<AgentApprovals> {
    const [row] = await db.select().from(settings).where(eq(settings.key, `agent_approvals:${companyId}`));
    return AGENT_APPROVALS.includes(row?.value as AgentApprovals) ? (row!.value as AgentApprovals) : "hires";
  }

  /** The funding source a provider change should use, when the owner gave a provider but no source. */
  async function sourceFor(provider: string, currentId: string | null, currentProvider: string | null): Promise<string> {
    if (currentId && currentProvider === provider) return currentId;
    const matches = await db.select({ id: fundingSources.id }).from(fundingSources).where(eq(fundingSources.provider, provider as (typeof fundingSources.$inferSelect)["provider"]));
    if (matches.length === 1) return matches[0]!.id;
    throw new AgentError(422, `Choose the funding source to pay from as well: ${matches.length ? `there are ${matches.length} for ${providerLabel(provider)}` : `there is none for ${providerLabel(provider)}`}. Call model_options to see them.`);
  }

  /**
   * Checks a harness/provider/model/paid-from setup the way the runner would use it. Every field is
   * required, the provider must match its funding source, the harness must support that provider,
   * and a model must be one the harness or the source's key offers (when a list is known).
   */
  async function validateModelConfig(companyId: string, input: { harness?: string; provider?: string; model?: string | null; fundingSourceId?: string | null }): Promise<AgentModelConfig> {
    const harness = input.harness?.trim() ?? "";
    const provider = input.provider?.trim() ?? "";
    const model = input.model?.trim() ?? "";
    const fundingSourceId = input.fundingSourceId?.trim() ?? "";
    if (!harness) throw new AgentError(422, `Choose a harness: ${HARNESSES.map((h) => `${h.label} (${h.value})`).join(", ")}. Call model_options to see the choices.`);
    if (!HARNESSES.some((h) => h.value === harness)) throw new AgentError(422, `There's no harness called ${harness}. Choose one of: ${HARNESSES.map((h) => `${h.label} (${h.value})`).join(", ")}.`);
    if (!provider) throw new AgentError(422, `Choose a provider: ${FUNDING_PROVIDERS.map(providerLabel).join(", ")}. Call model_options to see the choices.`);
    if (!FUNDING_PROVIDERS.includes(provider as (typeof FUNDING_PROVIDERS)[number])) throw new AgentError(422, `There's no provider called ${provider}. Choose one of: ${FUNDING_PROVIDERS.map(providerLabel).join(", ")}.`);
    if (!fundingSourceId) throw new AgentError(422, "Choose what the agent is paid from (a funding source). Call model_options to see them.");
    const [source] = await db.select().from(fundingSources).where(eq(fundingSources.id, fundingSourceId));
    if (!source) throw new AgentError(422, "No funding source with that ID. Call model_options to see them.");
    if (source.provider !== provider) throw new AgentError(422, `${source.name} pays with ${providerLabel(source.provider)}, not ${providerLabel(provider)}. Pick a funding source whose provider matches.`);
    const allowed = HARNESS_PROVIDERS[harness] ?? [];
    if (!allowed.includes(provider)) throw new AgentError(422, `${harnessLabel(harness)} can't run on ${providerLabel(provider)}. Use ${allowed.map(providerLabel).join(", ")}, or choose OpenCode for this provider.`);
    if (!model) throw new AgentError(422, "Choose a model. Call model_options to see the models the harness and funding source offer.");
    if (opts.catalog) {
      const catalog = await opts.catalog(companyId);
      const offered = [...(catalog.runner[harness]?.models ?? []), ...(catalog.api.find((a) => a.fundingSourceId === fundingSourceId)?.models ?? [])].filter((m) => m.value !== "default");
      const known = offered.some((m) => m.value === model) || (harness === "claude" && (CLAUDE_ALIASES.has(model) || /^claude[-.]/i.test(model)));
      if (offered.length && !known) throw new AgentError(422, `That model (${model}) isn't in the list for ${harnessLabel(harness)} on ${source.name}. Call model_options to see the valid models.`);
    }
    return { harness, provider, model, fundingSourceId, fundingSourceName: source.name };
  }

  /** Valid choices for the CEO, with the same names the Agents page shows. */
  async function modelOptions(companyId: string) {
    const sources = await db.select().from(fundingSources).orderBy(fundingSources.name);
    const catalog: ModelCatalog = opts.catalog ? await opts.catalog(companyId) : { runner: {}, api: [] };
    return {
      harnesses: HARNESSES.map((h) => ({ value: h.value, label: h.label })),
      providers: FUNDING_PROVIDERS.map((value) => ({ value, label: providerLabel(value) })),
      fundingSources: sources.map((s) => ({ id: s.id, name: s.name, kind: s.kind, provider: s.provider, providerLabel: providerLabel(s.provider) })),
      models: {
        runner: Object.fromEntries(Object.entries(catalog.runner).map(([kind, list]) => [kind, list.models.filter((m) => m.value !== "default")])),
        byFundingSource: catalog.api.map((a) => ({ fundingSourceId: a.fundingSourceId, name: a.name, provider: a.provider, providerLabel: providerLabel(a.provider), models: a.models, error: a.error })),
      },
      note: "Pick a harness, a provider, a model and a funding source whose provider is the same. If a model list is empty, the runner or provider hasn't reported one; a valid model ID can still be used. Every hire and model change waits for the owner's approval.",
    };
  }

  /** Clears stored sessions that would resume an old harness/provider on the next launch. */
  async function clearResumeSessions(agentId: string) {
    await db.update(ceoChapters).set({ acpSessionId: null }).where(and(eq(ceoChapters.agentId, agentId), isNull(ceoChapters.endedAt)));
    await db.update(wakes).set({ resumeRunId: null }).where(and(eq(wakes.agentId, agentId), inArray(wakes.status, ["queued", "deferred"])));
  }

  return {
    templates: () => ({ templates: AGENT_TEMPLATES, ceo: CEO_TEMPLATE }),

    modelOptions,

    approvals,
    async setApprovals(companyId: string, value: AgentApprovals) {
      await db.insert(settings).values({ key: `agent_approvals:${companyId}`, value }).onConflictDoUpdate({ target: settings.key, set: { value } });
      return value;
    },

    /**
     * The CEO proposes a hire (BOS-128). Every hire waits for the owner, whatever the "needs
     * approval" setting says, so no model setup ever changes without them. The card carries all
     * four fields; they are validated before it is raised.
     */
    async proposeHire(companyId: string, ceoId: string, p: HireProposal): Promise<{ decisionId: string }> {
      const tpl = p.template ? AGENT_TEMPLATES.find((x) => x.id === p.template) : undefined;
      if (p.template && !tpl) throw new AgentError(422, `There's no template called ${p.template}. Templates: ${AGENT_TEMPLATES.map((x) => x.id).join(", ")}.`);
      const config = await validateModelConfig(companyId, p);
      const job = p.title ?? tpl?.title ?? "agent";
      const instructions = p.instructions !== undefined ? p.instructions : (tpl?.instructions ?? null);
      const [d] = await db
        .insert(decisions)
        .values({
          companyId,
          raisedByAgentId: ceoId,
          kind: "approval",
          tier: "owner",
          question: [`The CEO wants to hire ${p.name} as ${job}.`, labelConfig(config), p.reason ? `Why: ${p.reason}` : null, instructions ? `Their instructions:\n${instructions.slice(0, 3000)}` : null, "If you want different values, choose Don't hire and ask the CEO to propose it again; you can also change them on the Agents page after hiring."].filter(Boolean).join("\n\n"),
          options: [HIRE, DONT_HIRE],
          recommendedOption: HIRE,
          context: { type: "hire", proposal: { ...p, ...config, model: config.model, fundingSourceId: config.fundingSourceId, harness: config.harness, provider: config.provider, instructions }, byAgentId: ceoId },
        })
        .returning({ id: decisions.id });
      return { decisionId: d!.id };
    },

    /**
     * The CEO proposes a model-setup change for an existing agent (BOS-128). It never applies
     * directly: the owner gets a card with the current and proposed values and can approve, edit
     * or reject it. The change lands between runs, never mid-run.
     */
    async proposeModelChange(agentId: string, ceoId: string, p: { harness?: string; provider?: string; model?: string | null; fundingSourceId?: string | null; reason?: string }): Promise<{ decisionId: string }> {
      const a = await agent(agentId);
      if (a.retiredAt) throw new AgentError(409, `${a.name} is retired.`);
      const [currentSource] = a.fundingSourceId ? await db.select().from(fundingSources).where(eq(fundingSources.id, a.fundingSourceId)) : [];
      const currentProvider = currentSource?.provider ?? "";
      let fundingSourceId = p.fundingSourceId ?? "";
      let provider = p.provider?.trim() ?? "";
      // A provider-only change picks the matching source, unless the current source already
      // pays with that provider; a source the CEO named is checked against it below.
      const providerChanged = provider !== "" && provider !== currentProvider;
      if (!fundingSourceId && providerChanged) fundingSourceId = await sourceFor(provider, a.fundingSourceId, currentProvider || null);
      if (!fundingSourceId) fundingSourceId = a.fundingSourceId ?? "";
      if (fundingSourceId && !provider) {
        const [source] = await db.select().from(fundingSources).where(eq(fundingSources.id, fundingSourceId));
        provider = source?.provider ?? "";
      }
      const config = await validateModelConfig(a.companyId, { harness: p.harness ?? a.agentKind, provider: provider || currentProvider, model: p.model ?? a.model, fundingSourceId });
      const before: AgentModelConfig = { harness: a.agentKind, provider: currentProvider, model: a.model ?? "", fundingSourceId: a.fundingSourceId ?? "", fundingSourceName: currentSource?.name };
      if (before.harness === config.harness && before.provider === config.provider && before.model === config.model && before.fundingSourceId === config.fundingSourceId) throw new AgentError(422, `${a.name} is already set up that way.`);
      const open = await db.select({ context: decisions.context }).from(decisions).where(and(eq(decisions.companyId, a.companyId), eq(decisions.status, "open")));
      if (open.some((d) => {
        const ctx = d.context as { type?: string; agentId?: string } | null;
        return ctx?.type === "model_change" && ctx.agentId === a.id;
      })) throw new AgentError(409, `A model change for ${a.name} is already waiting for the owner.`);
      const [running] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.agentId, a.id), isNull(runs.endedAt))).limit(1);
      const when = running ? `It takes effect after their current run ends, never during it.` : `It takes effect before their next run.`;
      const [d] = await db
        .insert(decisions)
        .values({
          companyId: a.companyId,
          raisedByAgentId: ceoId,
          kind: "approval",
          tier: "owner",
          question: [`The CEO wants to change ${a.name}'s model setup.`, `Current: ${labelConfig(before)}`, `Proposed: ${labelConfig(config)}`, p.reason ? `Why: ${p.reason}` : null, when].filter(Boolean).join("\n\n"),
          options: [MODEL_APPROVE, MODEL_EDIT, MODEL_REJECT],
          recommendedOption: MODEL_APPROVE,
          context: { type: "model_change", agentId, before, proposed: config, runningRunId: running?.id ?? null, byAgentId: ceoId },
        })
        .returning({ id: decisions.id });
      return { decisionId: d!.id };
    },

    /** Applies an approved (or owner-edited) model change, checked again just before it is saved. */
    async applyModelChange(ctx: { agentId: string; byAgentId: string }, companyId: string, config: AgentModelConfig): Promise<{ afterRunId: string | null }> {
      const a = await agent(ctx.agentId);
      if (a.companyId !== companyId) throw new AgentError(404, "No such agent.");
      if (a.retiredAt) throw new AgentError(409, `${a.name} is retired, so their model setup can't change.`);
      const checked = await validateModelConfig(companyId, config);
      const [running] = await db.select({ id: runs.id }).from(runs).where(and(eq(runs.agentId, a.id), isNull(runs.endedAt))).limit(1);
      // The row is updated at once, but "after the run" still holds: scheduler.launch reads the agent's
      // config when a run starts, so a run already in flight keeps the setup it launched with.
      await this.update(a.id, { agentKind: checked.harness, model: checked.model, fundingSourceId: checked.fundingSourceId }, ctx.byAgentId);
      return { afterRunId: running?.id ?? null };
    },

    /**
     * The CEO changes an agent's instructions. Applied at once with a notification and Undo in
     * its history, unless the owner wants to approve edits too.
     */
    async proposeInstructions(agentId: string, ceoId: string, instructions: string, reason?: string): Promise<{ applied: AgentRow } | { decisionId: string }> {
      const a = await agent(agentId);
      if (a.retiredAt) throw new AgentError(409, `${a.name} is retired.`);
      if ((await approvals(a.companyId)) === "hires_and_edits") {
        const [d] = await db
          .insert(decisions)
          .values({
            companyId: a.companyId,
            raisedByAgentId: ceoId,
            kind: "approval",
            tier: "owner",
            question: [`The CEO wants to change ${a.name}'s instructions.`, reason ? `Why: ${reason}` : null, `New instructions:\n${instructions.slice(0, 3000)}`].filter(Boolean).join("\n\n"),
            options: [APPLY, KEEP],
            recommendedOption: APPLY,
            context: { type: "instructions", agentId, instructions, byAgentId: ceoId },
          })
          .returning({ id: decisions.id });
        return { decisionId: d!.id };
      }
      const applied = await this.update(agentId, { instructions }, ceoId);
      await notify({ companyId: a.companyId, agentId: ceoId, level: "note", title: `The CEO changed ${a.name}'s instructions`, body: `${reason ? `${reason}\n` : ""}See the change, or undo it, in Agents › ${a.name} › History.`, link: "#/agents" });
      return { applied };
    },

    /**
     * The CEO changes the company's standing rules (BOS-353). Like an instruction change it is
     * applied at once with a notification and Undo in the history, unless the owner wants to
     * approve edits too, in which case it waits in Decisions. Nobody else can change them.
     */
    async proposeStandingRules(companyId: string, ceoId: string, text: string, reason?: string): Promise<{ saved: Awaited<ReturnType<typeof getStandingRules>> } | { decisionId: string }> {
      // Normalise and check once, before anything is shown or saved: the text the owner reads on the
      // card is exactly the text that gets saved, so blank space can't hide the real rules (security review).
      const rules = normalizeStandingRules(text);
      const problem = standingRulesError(rules);
      if (problem) throw new AgentError(422, problem);
      if ((await approvals(companyId)) === "hires_and_edits") {
        const [d] = await db
          .insert(decisions)
          .values({
            companyId,
            raisedByAgentId: ceoId,
            kind: "approval",
            tier: "owner",
            question: [rules ? "The CEO wants to change the company's standing rules." : "The CEO wants to clear the company's standing rules.", reason ? `Why: ${reason}` : null].filter(Boolean).join("\n\n"),
            options: [APPLY, KEEP],
            recommendedOption: APPLY,
            context: { type: "standing_rules", text: rules, byAgentId: ceoId },
          })
          .returning({ id: decisions.id });
        return { decisionId: d!.id };
      }
      const saved = await this.applyStandingRules(companyId, ceoId, rules);
      await notify({ companyId, agentId: ceoId, level: "note", title: saved.text ? "The CEO changed the standing rules" : "The CEO cleared the standing rules", body: `${reason ? `${reason}\n` : ""}Every run from now on reads them. See them, or undo the change, on the Settings page.`, link: "#/settings" });
      return { saved };
    },

    /** Saves the standing rules as the CEO (or the owner's approval of the CEO's proposal). */
    async applyStandingRules(companyId: string, ceoId: string, text: string) {
      const [ceo] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, ceoId));
      try {
        const saved = await setStandingRules(db, companyId, { text, by: ceo?.name ?? "the CEO", byAgentId: ceoId });
        await logActivity(db, { companyId, agentId: ceoId, kind: "settings", summary: saved.text ? `${ceo?.name ?? "The CEO"} updated the standing rules` : `${ceo?.name ?? "The CEO"} cleared the standing rules` });
        return saved;
      } catch (err) {
        if (err instanceof StandingRulesError) throw new AgentError(422, err.message);
        throw err;
      }
    },

    /**
     * The CEO renames an agent (BOS-265). The name is display only: the id ties tickets, runs,
     * notes and history to the agent, so nothing else moves. The CEO can't be renamed this way,
     * and the name must be new to the company. Like an instruction change it is applied with a
     * notification and Undo in the history, unless the owner wants to approve edits too.
     */
    async rename(companyId: string, ceoId: string, agentId: string, newName: string, reason?: string): Promise<{ applied: AgentRow; before: string } | { decisionId: string }> {
      const a = await agent(agentId);
      if (a.companyId !== companyId) throw new AgentError(404, "No such agent.");
      if (a.role === "ceo") throw new AgentError(409, "The CEO can't be renamed this way; the owner can rename it on the Agents page.");
      if (a.retiredAt) throw new AgentError(409, `${a.name} is retired, so they can't be renamed.`);
      const problem = speakerNameProblem(newName);
      if (problem) throw new AgentError(422, problem);
      const name = newName.trim();
      if (name.length > NAME_MAX) throw new AgentError(422, `That name is ${name.length} characters; names are at most ${NAME_MAX}.`);
      const [same] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), sql`lower(${agents.name}) = lower(${name})`, isNull(agents.retiredAt), ne(agents.id, a.id)));
      if (same) throw new AgentError(409, `Another agent in this company is already called ${name}. Pick a name no one else has.`);
      if (name === a.name) throw new AgentError(422, `${a.name} is already called that.`);
      if ((await approvals(companyId)) === "hires_and_edits") {
        const open = await db.select({ context: decisions.context }).from(decisions).where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open")));
        if (open.some((d) => (d.context as { type?: string; agentId?: string } | null)?.type === "rename" && (d.context as { agentId?: string }).agentId === agentId)) throw new AgentError(409, `A rename of ${a.name} is already waiting for the owner.`);
        const [d] = await db
          .insert(decisions)
          .values({
            companyId,
            raisedByAgentId: ceoId,
            kind: "approval",
            tier: "owner",
            question: [`The CEO wants to rename ${a.name} to ${name}.`, reason ? `Why: ${reason}` : null, `Only the display name changes: their id, tickets, runs, notes and history stay with them.`].filter(Boolean).join("\n\n"),
            options: [APPLY, KEEP],
            recommendedOption: APPLY,
            context: { type: "rename", agentId, newName: name, before: a.name, byAgentId: ceoId },
          })
          .returning({ id: decisions.id });
        return { decisionId: d!.id };
      }
      const applied = await this.applyRename(agentId, name, ceoId, reason);
      return { applied, before: a.name };
    },

    /** Applies a rename (or the owner's approval of one), re-checked here because the team may have changed since. */
    async applyRename(agentId: string, name: string, byAgentId: string | null, reason?: string): Promise<AgentRow> {
      const a = await agent(agentId);
      if (a.role === "ceo") throw new AgentError(409, "The CEO can't be renamed this way; the owner can rename it on the Agents page.");
      // Re-checked here, not only in rename(): the owner's approval comes through this path too, and a name
      // that reads as "Owner" or carries a line break would let this agent's words pass for the owner's (BOS-265 review).
      const problem = speakerNameProblem(name);
      if (problem) throw new AgentError(422, problem);
      const clean = name.trim();
      if (clean.length > NAME_MAX) throw new AgentError(422, `That name is ${clean.length} characters; names are at most ${NAME_MAX}.`);
      const [same] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.companyId, a.companyId), sql`lower(${agents.name}) = lower(${clean})`, isNull(agents.retiredAt), ne(agents.id, a.id)));
      if (same) throw new AgentError(409, `Another agent in this company is already called ${clean}. Pick a name no one else has.`);
      const applied = await this.update(agentId, { name: clean }, byAgentId);
      await logActivity(db, { companyId: a.companyId, agentId: byAgentId, kind: "agent_renamed", summary: `${a.name} was renamed to ${clean}${reason?.trim() ? `: ${reason.trim()}` : ""}` });
      await notify({
        companyId: a.companyId,
        agentId: byAgentId,
        level: "note",
        title: `The CEO renamed ${a.name} to ${clean}`,
        body: `${reason?.trim() ? `${reason.trim()}\n` : ""}Only the display name changed; their tickets, runs and history stay with them. See the change, or undo it, in Agents › ${clean} › History.`,
        link: "#/agents",
      });
      return applied;
    },

    /**
     * Every other agent whose standing instructions or title still say the old name, so the CEO can
     * update them (BOS-265). Settings and review policy store agent ids, never names, so a rename
     * can't break them; this only reports the places the old name is quoted.
     */
    async colleaguesMentioning(companyId: string, agentId: string, oldName: string): Promise<Array<{ id: string; name: string; where: string }>> {
      const rows = await db.select({ id: agents.id, name: agents.name, title: agents.title, instructions: agents.instructions }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.retiredAt), ne(agents.id, agentId)));
      // Word-ish match on the whole old name, so "Sam" doesn't catch "Samsung"; names ending in a
      // letter need a boundary after them, and dots in the name are literal.
      const escaped = oldName.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const mentions = (text: string | null) => !!text && new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i").test(text);
      const found: Array<{ id: string; name: string; where: string }> = [];
      for (const r of rows) {
        const places = [mentions(r.instructions) ? "instructions" : null, mentions(r.title) ? "title" : null].filter((p): p is string => !!p);
        if (places.length) found.push({ id: r.id, name: r.name, where: places.join(" and ") });
      }
      return found;
    },

    /**
     * Sets an agent's picture from an image already on one of the company's tickets (BOS-265), or
     * clears it back to the template's portrait. Only PNG, JPEG or WebP bytes are taken, sized as an
     * owner's upload; the bytes are kept once per image and shared by every agent that uses it.
     */
    async setPicture(companyId: string, ceoId: string, agentId: string, choice: { imageId?: string | null; clear?: boolean }, reason?: string): Promise<{ agent: AgentRow; cleared: boolean }> {
      const a = await agent(agentId);
      if (a.companyId !== companyId) throw new AgentError(404, "No such agent.");
      const why = reason?.trim().slice(0, REASON_MAX) || null;
      if (choice.clear) {
        if (!a.avatarAt) return { agent: a, cleared: true };
        await db.delete(agentAvatars).where(eq(agentAvatars.agentId, agentId));
        const [after] = await db.update(agents).set({ avatarAt: null }).where(eq(agents.id, agentId)).returning();
        await logActivity(db, { companyId, agentId: ceoId, kind: "agent_picture", summary: `${a.name}'s picture went back to the default${why ? `: ${why}` : ""}` });
        await notify({ companyId, agentId: ceoId, level: "note", title: `The CEO set ${a.name}'s picture back to the default`, body: `${why ? `${why}\n` : ""}See it, or undo it, on the Agents page.`, link: "#/agents" });
        return { agent: after!, cleared: true };
      }
      const imageId = choice.imageId?.trim();
      if (!imageId) throw new AgentError(422, "Give an image id (one attached to a ticket in this company) or set clear to go back to the default.");
      const [img] = await db.select({ id: ticketImages.id, type: ticketImages.type, size: ticketImages.size, bytes: ticketImages.bytes }).from(ticketImages).where(and(eq(ticketImages.id, imageId), eq(ticketImages.companyId, companyId)));
      if (!img) throw new AgentError(404, "No image with that id on a ticket in this company. tickets read lists a ticket's images; attach_image adds one.");
      // The bytes decide, never the stored type or a name.
      const type = pictureType(img.bytes);
      if (!type) throw new AgentError(422, `${img.size} bytes that aren't a PNG, JPEG or WebP image. Pick a picture, not a document.`);
      if (img.bytes.length > AVATAR_MAX_BYTES) throw new AgentError(413, `That picture is ${Math.round(img.bytes.length / 1024)} KB; a picture can be at most ${AVATAR_MAX_BYTES / 1024} KB. Pick a smaller one.`);
      await db
        .insert(agentAvatars)
        .values({ agentId, bytes: img.bytes, type, imageId: img.id })
        .onConflictDoUpdate({ target: agentAvatars.agentId, set: { bytes: img.bytes, type, imageId: img.id } });
      const [after] = await db.update(agents).set({ avatarAt: now() }).where(eq(agents.id, agentId)).returning();
      await logActivity(db, { companyId, agentId: ceoId, kind: "agent_picture", summary: `${a.name}'s picture was set from a ticket image${why ? `: ${why}` : ""}` });
      await notify({ companyId, agentId: ceoId, level: "note", title: `The CEO set ${a.name}'s picture`, body: `${why ? `${why}\n` : ""}It shows on the Agents page, the board and the runs list. You can undo it there.`, link: "#/agents" });
      return { agent: after!, cleared: false };
    },

    /**
     * The CEO's team plan for a project or the company (docs/13): every proposed hire in one
     * decision, so the owner ticks the ones they want. Always asked, whatever the hire approvals.
     */
    async proposeTeam(companyId: string, ceoId: string, plan: { projectId?: string | null; covered: string; hires: TeamHire[] }) {
      const hires: TeamHire[] = [];
      for (const h of plan.hires) {
        if (h.template && !AGENT_TEMPLATES.some((x) => x.id === h.template)) throw new AgentError(422, `There's no template called ${h.template}. Templates: ${AGENT_TEMPLATES.map((x) => x.id).join(", ")}.`);
        for (const name of h.skills ?? []) {
          const [hit] = await db.select({ id: skills.id }).from(skills).where(and(eq(skills.companyId, companyId), or(eq(skills.name, name), eq(skills.pack, name)))).limit(1);
          if (!hit) throw new AgentError(422, `There's no skill or pack called ${name} in the library.`);
        }
        const config = await validateModelConfig(companyId, h);
        hires.push({ ...h, ...config, harness: config.harness, provider: config.provider, model: config.model, fundingSourceId: config.fundingSourceId, fundingSourceName: config.fundingSourceName });
      }
      const [project] = plan.projectId ? await db.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.id, plan.projectId), eq(projects.companyId, companyId))) : [];
      if (plan.projectId && !project) throw new AgentError(422, "No project with that ID in this company.");
      const open = await db.select({ context: decisions.context }).from(decisions).where(and(eq(decisions.companyId, companyId), eq(decisions.status, "open")));
      if (open.some((d) => (d.context as { type?: string; projectId?: string | null } | null)?.type === "team_plan" && ((d.context as { projectId?: string | null }).projectId ?? null) === (project?.id ?? null))) throw new AgentError(409, "A team plan for this is already waiting for the owner.");
      const lines = hires.map((h, i) => `${i + 1}. ${h.name}${h.title ? `, ${h.title}` : ""}${h.template ? ` (${h.template})` : ""} ${labelConfig({ harness: h.harness!, provider: h.provider!, model: h.model!, fundingSourceId: h.fundingSourceId!, fundingSourceName: h.fundingSourceName })}: ${h.reason}${h.skills?.length ? ` Skills: ${h.skills.join(", ")}.` : ""}`);
      const [d] = await db
        .insert(decisions)
        .values({
          companyId,
          raisedByAgentId: ceoId,
          kind: "approval",
          tier: "owner",
          question: [`Team plan for ${project ? project.name : "the company"}: the CEO proposes ${hires.length === 1 ? "1 hire" : `${hires.length} hires`}.`, `Already covered: ${plan.covered}`, ...lines].join("\n\n"),
          options: [TEAM_HIRE, TEAM_NOT_NOW],
          recommendedOption: TEAM_HIRE,
          context: { type: "team_plan", projectId: project?.id ?? null, covered: plan.covered, hires, byAgentId: ceoId },
        })
        .returning({ id: decisions.id });
      return { decisionId: d!.id };
    },

    /** Hires the ticked members of a team plan and gives each its skills; one that fails doesn't stop the rest. */
    async hireTeam(companyId: string, hires: TeamHire[], ceoId: string, give: (agentId: string, skill: string) => Promise<unknown>) {
      const hired: string[] = [];
      const failed: string[] = [];
      for (const h of hires) {
        try {
          const config = await validateModelConfig(companyId, h);
          const a = await this.hire(companyId, { name: h.name, template: h.template, title: h.title ?? undefined, agentKind: config.harness, model: config.model, fundingSourceId: config.fundingSourceId }, ceoId);
          for (const sk of h.skills ?? []) await give(a.id, sk).catch((err: Error) => failed.push(`${h.name} didn't get ${sk}: ${err.message}`));
          hired.push(h.name);
        } catch (err) {
          failed.push(`${h.name}: ${(err as Error).message}`);
        }
      }
      await notify({ companyId, agentId: ceoId, level: failed.length ? "flag" : "note", title: hired.length ? `Hired from the team plan: ${hired.join(", ")}` : "Nobody was hired from the team plan", body: failed.length ? failed.join("\n") : null, link: "#/agents" });
      return { hired, failed };
    },

    /** The owner's answer to a hire, instructions, rename or standing-rules decision. */
    async onDecision(ctx: { type: "hire"; proposal: HireProposal; byAgentId: string } | { type: "instructions"; agentId: string; instructions: string; byAgentId: string } | { type: "rename"; agentId: string; newName: string; before: string; byAgentId: string } | { type: "standing_rules"; text: string; byAgentId: string }, companyId: string, approved: boolean) {
      if (!approved) return null;
      if (ctx.type === "rename") return this.applyRename(ctx.agentId, ctx.newName, ctx.byAgentId, "The owner approved it.");
      if (ctx.type === "standing_rules") return this.applyStandingRules(companyId, ctx.byAgentId, ctx.text);
      if (ctx.type === "hire") {
        const config = await validateModelConfig(companyId, ctx.proposal);
        const hired = await this.hire(companyId, { ...ctx.proposal, agentKind: config.harness, model: config.model, fundingSourceId: config.fundingSourceId }, ctx.byAgentId);
        await opts.assignPlanned?.(companyId, hired, ctx.proposal.forTickets ?? []);
        return hired;
      }
      return this.update(ctx.agentId, { instructions: ctx.instructions }, ctx.byAgentId);
    },

    /** Each agent with what it's doing and what it has used this month. Retired agents come last. */
    async list(companyId: string) {
      const t = now();
      const monthStart = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1));
      const rows = await db.select({ a: agents, funding: fundingSources.name, fundingKind: fundingSources.kind }).from(agents).leftJoin(fundingSources, eq(fundingSources.id, agents.fundingSourceId)).where(eq(agents.companyId, companyId));
      const live = await db
        .select({ agentId: runs.agentId, ticketId: runs.ticketId, ticket: tickets.title, purpose: runs.purpose })
        .from(runs)
        .leftJoin(tickets, eq(tickets.id, runs.ticketId))
        .where(and(eq(runs.companyId, companyId), isNull(runs.endedAt)));
      const money = await db
        .select({ agentId: costEvents.agentId, micros: sql<string>`coalesce(sum(${costEvents.costMicros}), 0)` })
        .from(costEvents)
        .innerJoin(fundingSources, eq(fundingSources.id, costEvents.fundingSourceId))
        .where(and(eq(costEvents.companyId, companyId), gte(costEvents.occurredAt, monthStart), ne(fundingSources.kind, "subscription")))
        .groupBy(costEvents.agentId);
      const used = await db
        .select({ agentId: runs.agentId, runs: sql<number>`count(*)::int`, tokens: sql<string>`coalesce(sum(coalesce(${runs.inputTokens}, 0) + coalesce(${runs.outputTokens}, 0)), 0)` })
        .from(runs)
        .where(and(eq(runs.companyId, companyId), gte(runs.startedAt, monthStart)))
        .groupBy(runs.agentId);
      const assigned = await db
        .select({ agentId: tickets.assigneeAgentId, n: sql<number>`count(*)::int` })
        .from(tickets)
        .where(and(eq(tickets.companyId, companyId), inArray(tickets.systemState, [...OPEN])))
        .groupBy(tickets.assigneeAgentId);
      const [pa] = await db
        .select({ total: sql<number>`count(*)::int`, posted: sql<number>`(count(*) filter (where ${paAnswers.outcome} = 'posted'))::int`, wrong: sql<number>`(count(*) filter (where ${paAnswers.verdict} = 'wrong'))::int` })
        .from(paAnswers)
        .where(eq(paAnswers.companyId, companyId));
      return rows
        .map(({ a, funding, fundingKind }) => {
          const working = live.find((r) => r.agentId === a.id && r.purpose !== "chat");
          return {
            ...a,
            funding,
            fundingKind,
            status: a.retiredAt ? "retired" : working ? "working" : a.paused ? "paused" : "idle",
            current: working?.ticketId ? { ticketId: working.ticketId, title: working.ticket } : null,
            pa: a.duty === "assistant" ? { posted: pa!.posted, escalated: pa!.total - pa!.posted, wrong: pa!.wrong } : null,
            openTickets: assigned.find((r) => r.agentId === a.id)?.n ?? 0,
            month: {
              costMicros: Number(money.find((m) => m.agentId === a.id)?.micros ?? 0),
              runs: used.find((u) => u.agentId === a.id)?.runs ?? 0,
              tokens: Number(used.find((u) => u.agentId === a.id)?.tokens ?? 0),
            },
          };
        })
        .sort((x, y) => Number(!!x.retiredAt) - Number(!!y.retiredAt) || (x.role === "ceo" ? -1 : y.role === "ceo" ? 1 : x.name.localeCompare(y.name)));
    },

    /** Hires an agent, optionally from a template; the template fills in what isn't given. */
    async hire(companyId: string, input: { name: string; template?: string; title?: string | null; instructions?: string | null; role?: "manager" | "worker"; agentKind?: string; model?: string | null; thinking?: string | null; fundingSourceId?: string | null; reportsTo?: string | null }, byAgentId: string | null = null) {
      const tpl = input.template ? AGENT_TEMPLATES.find((x) => x.id === input.template) : undefined;
      if (input.template && !tpl) throw new AgentError(422, `There's no template called ${input.template}.`);
      // A new agent's name is a speaker label in agent conversations too, so the rename rules apply (BOS-265 review).
      const problem = speakerNameProblem(input.name);
      if (problem) throw new AgentError(422, problem);
      // One assistant per company (R87); it starts paused so the owner picks its (cheap) model first.
      if (tpl?.duty && (await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.duty, tpl.duty), isNull(agents.retiredAt)))).length) throw new AgentError(409, `This company already has an active ${tpl.title}; retire it first.`);
      const [a] = await db
        .insert(agents)
        .values({
          companyId,
          duty: tpl?.duty ?? null,
          paused: !!tpl?.duty,
          name: input.name,
          role: input.role ?? tpl?.role ?? "worker",
          agentKind: input.agentKind ?? "claude",
          model: input.model ?? null,
          thinking: input.thinking ?? null,
          fundingSourceId: input.fundingSourceId ?? null,
          reportsTo: input.reportsTo ?? null,
          template: tpl?.id ?? null,
          title: input.title !== undefined ? input.title : (tpl?.title ?? null),
          instructions: input.instructions !== undefined ? input.instructions : (tpl?.instructions ?? null),
        })
        .returning();
      await record(a!, "hired", null, { name: a!.name, title: a!.title, template: a!.template }, byAgentId);
      return a!;
    },

    /** Changes an agent, keeping each changed field with its old value. */
    async update(agentId: string, patch: AgentPatch, byAgentId: string | null = null) {
      const before = await agent(agentId);
      if (before.retiredAt && patch.paused === false) throw new AgentError(409, `${before.name} is retired. Rehire them first.`);
      const changed = TRACKED.filter(([col]) => patch[col] !== undefined && patch[col] !== before[col]);
      // Starring is the owner's own tidy-up, so it isn't kept in the history.
      if (!changed.length && (patch.starred === undefined || patch.starred === before.starred)) return before;
      const harnessOrProvider = changed.some(([col]) => col === "agentKind" || col === "fundingSourceId");
      const [after] = await db.update(agents).set(patch).where(eq(agents.id, agentId)).returning();
      // A Claude Code session must never be reopened on OpenCode, or under another provider.
      if (harnessOrProvider) await clearResumeSessions(agentId);
      for (const [col, field] of changed) await record(before, field, before[col], after![col], byAgentId);
      return after!;
    },

    /**
     * Retires an agent: it stops working, its open tickets go back to unassigned, and it stops
     * watching tickets. Its runs and history stay. The CEO can't be retired.
     */
    async retire(agentId: string, byAgentId: string | null = null) {
      const a = await agent(agentId);
      if (a.role === "ceo") throw new AgentError(409, "The CEO can't be retired; change its instructions or model instead.");
      if (a.retiredAt) return { agent: a, unassigned: 0 };
      const freed = await db
        .update(tickets)
        .set({ assigneeAgentId: null, lastActivityAt: now() })
        .where(and(eq(tickets.assigneeAgentId, agentId), inArray(tickets.systemState, [...OPEN])))
        .returning({ id: tickets.id });
      const watching = await db.update(tickets).set({ watcherAgentId: null, watchedAt: null }).where(eq(tickets.watcherAgentId, agentId)).returning({ id: tickets.id });
      const [after] = await db.update(agents).set({ retiredAt: now(), paused: true }).where(eq(agents.id, agentId)).returning();
      await record(a, "retired", { paused: a.paused, tickets: freed.map((t) => t.id), watching: watching.map((t) => t.id) }, null, byAgentId);
      return { agent: after!, unassigned: freed.length };
    },

    async history(agentId: string) {
      await agent(agentId);
      return db.select({ c: agentChanges, by: agents.name }).from(agentChanges).leftJoin(agents, eq(agents.id, agentChanges.byAgentId)).where(eq(agentChanges.agentId, agentId)).orderBy(desc(agentChanges.createdAt)).limit(200);
    },

    /**
     * Puts a change back. A field goes back to its old value (if nobody has changed it again
     * since); a retirement is undone by rehiring, with the tickets it had and what it watched.
     */
    async undo(changeId: string) {
      const [c] = await db.select().from(agentChanges).where(eq(agentChanges.id, changeId));
      if (!c) throw new AgentError(404, "No such change.");
      if (c.undoneAt) throw new AgentError(409, "That change was already undone.");
      const a = await agent(c.agentId);
      if (c.field === "retired") {
        if (a.duty && (await db.select({ id: agents.id }).from(agents).where(and(eq(agents.companyId, a.companyId), eq(agents.duty, a.duty), isNull(agents.retiredAt)))).length) throw new AgentError(409, `This company already has an active ${a.title ?? a.duty}; retire it before rehiring ${a.name}.`);
        const was = (c.before ?? {}) as { paused?: boolean; tickets?: string[]; watching?: string[] };
        await db.update(agents).set({ retiredAt: null, paused: was.paused ?? true }).where(eq(agents.id, a.id));
        if (was.tickets?.length) await db.update(tickets).set({ assigneeAgentId: a.id }).where(and(inArray(tickets.id, was.tickets), isNull(tickets.assigneeAgentId)));
        if (was.watching?.length) await db.update(tickets).set({ watcherAgentId: a.id }).where(and(inArray(tickets.id, was.watching), isNull(tickets.watcherAgentId)));
        await record(a, "rehired", null, null, null);
      } else {
        const col = FIELD_COLUMN[c.field];
        if (!col) throw new AgentError(409, `A "${c.field}" change can't be undone.`);
        if (JSON.stringify(a[col] ?? null) !== JSON.stringify(c.after ?? null)) throw new AgentError(409, `${a.name}'s ${c.field} has changed again since; edit it instead.`);
        await this.update(a.id, { [col]: c.before ?? null } as AgentPatch);
      }
      await db.update(agentChanges).set({ undoneAt: now() }).where(eq(agentChanges.id, c.id));
      return agent(a.id);
    },
  };
}
