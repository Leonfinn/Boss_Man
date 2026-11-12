// R18 of the owner-card lint (DR-057, BOS-1285): a step that sends the owner to add, fill in or edit an entry on one
// of Boss Man's own forms must give a value for every field that form needs. Four cards in a row had the right shape
// and no values; the last said "add the target if it isn't there yet, or press Edit on it" with no name, kind or
// address, and passed every rule because R17 exempts a "Settings → …" path by design.
//
// The forms and their fields come from OWNER_FORMS (packages/shared/src/owner-forms.ts), which a test keeps in step
// with the web forms. Like R17 this is a small table and fixed patterns, not a prose judge: each case is a test row,
// and a false refusal costs the author one rewrite (or a CEO override).

import { OWNER_FORMS, type OwnerForm, type OwnerFormField } from "@boss-man/shared";
import type { LintFinding } from "./steps.js";

/** A company fact filled from the server's own record at raise time (company-facts.ts). */
export const COMPANY_TOKEN = /\{\{\s*company\.([a-z0-9-]{1,40})\.deployTarget\.([A-Za-z]{1,20})\s*\}\}/g;
/** The start of a branch step Boss Man settles from its record (company-facts.ts): `[if company.<slug>.deployTarget exists]`. */
export const BRANCH_MARKER = /^\s*\[if\s+company\.([a-z0-9-]{1,40})\.deployTarget\s+(exists|is\s+missing)\]\s*/i;

/** Making a new entry. */
const ADD = /\b(?:add|create|register|set\s+up)\b/i;
/** Changing an entry that is there. */
const EDIT = /\b(?:edit|change|update)\b/i;
/** Putting values in fields: on its own it continues whatever the run before it opened. */
const FILL = /\b(?:fill(?:\s+in|\s+out)?|enter|type|tick|set|choose|pick|select|paste|put)\b/i;
/** An "if it isn't there" branch: the owner is asked to settle a question the card should have settled. */
export const IF_MISSING =
  /\bif\s+(?:it|they|there|one|that|this|the\s+[\w -]{1,40}?)\s+(?:isn't|is\s+not|aren't|are\s+not|doesn't|does\s+not|don't|do\s+not)\s+(?:there|listed|exist|shown|show|appear|have)\b|\bif\s+(?:it's|it\s+is|they're|they\s+are)\s+(?:missing|not\s+(?:there|listed|yet))\b|\bif\s+there\s+(?:is|are)\s+no\b|\bif\s+(?:it|one)\s+(?:is\s+)?missing\b/i;
/** A "Settings → …" path. */
const SETTINGS_PATH = /\bSettings\s*(?:→|->)\s*\S/;

/** Literal text in a step: inline code, quotes, bold. A `{{…}}` token inside one is still a token. */
const LITERAL = /`[^`\n]+`|"[^"\n]+"|“[^”\n]+”|\*\*[^*\n]+\*\*/g;
const TOKEN = /\{\{\s*[^}\n]+?\s*\}\}/g;

export type ValueKind = "literal" | "token";
type Span = { start: number; end: number; kind: ValueKind };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const words = (s: string) => String.raw`(?<![\p{L}\p{N}-])${s.split(/\s+/).map(esc).join(String.raw`\s+`)}(?![\p{L}\p{N}-])`;

/** The literal and token spans in a step, each once (a token in backticks is one token span). */
function valueSpans(prose: string): Span[] {
  const out: Span[] = [];
  for (const m of prose.matchAll(LITERAL)) out.push({ start: m.index, end: m.index + m[0].length, kind: /\{\{/.test(m[0]) ? "token" : "literal" });
  for (const m of prose.matchAll(TOKEN)) if (!out.some((s) => m.index >= s.start && m.index < s.end)) out.push({ start: m.index, end: m.index + m[0].length, kind: "token" });
  return out.sort((a, b) => a.start - b.start);
}

/** Which registered forms a step names, by their words. */
export function formsIn(prose: string): OwnerForm[] {
  return OWNER_FORMS.filter((f) => f.names.some((n) => new RegExp(words(n), "iu").test(prose)));
}

/** Every label a form has, longest first, so "Tag name" is found before "Name". */
function labelsOf(form: OwnerForm): Array<{ field: OwnerFormField; text: string }> {
  const all = [...form.required, ...(form.groups ?? []).flatMap((g) => g.fields)];
  return all.flatMap((field) => [field.label, ...(field.aliases ?? [])].map((text) => ({ field, text }))).sort((a, b) => b.text.length - a.text.length);
}

/**
 * The value each field of `form` has in `prose`: a literal or a token right after its label ("Name `x`", "set Kind
 * to SSH host", "Address: `{{company.acme.deployTarget.address}}`"), or right before it ("type `x` into Name"). For a
 * select, one of its choices counts unquoted. A secret field counts once it is named (the owner holds the value).
 */
export function fieldValues(form: OwnerForm, prose: string): Map<string, ValueKind> {
  const spans = valueSpans(prose);
  const out = new Map<string, ValueKind>(); // not state: one step's reading
  const taken: Array<[number, number]> = [];
  const spanAt = (i: number) => spans.find((s) => i >= s.start && i < s.end);
  for (const { field, text } of labelsOf(form)) {
    for (const m of prose.matchAll(new RegExp(words(text), "giu"))) {
      const start = m.index;
      let end = start + m[0].length;
      if (taken.some(([a, b]) => start < b && end > a)) continue;
      // A label inside a literal counts only when the literal is the label itself ("Tag name" in quotes).
      const inside = spanAt(start);
      if (inside && prose.slice(inside.start + 1, inside.end - 1).replace(/^\*|\*$/g, "").trim().toLowerCase() !== text.toLowerCase()) continue;
      if (inside) end = inside.end;
      taken.push([start, end]);
      if (out.has(field.label)) continue;
      if (field.secret) { out.set(field.label, "literal"); continue; }
      const after = prose.slice(end);
      // A quoted label already ends after its closing quote (`end` above), so only words and punctuation lead to the value.
      const lead = /^\s*(?:(?:field|box|drop-?down)\b)?\s*(?:(?:to|as|is|of|with)\b|[:=→])?\s*(?:the\s+value\s+)?/i.exec(after)![0];
      const at = end + lead.length;
      const next = spans.find((s) => s.start === at);
      if (next) { out.set(field.label, next.kind); continue; }
      if (field.options?.some((o) => new RegExp(`^${words(o)}`, "iu").test(prose.slice(at)))) { out.set(field.label, "literal"); continue; }
      const before = /((?:`[^`\n]+`|"[^"\n]+"|“[^”\n]+”|\*\*[^*\n]+\*\*|\{\{[^}\n]+\}\}))\s+(?:as|in|into|for|under)\s+(?:the\s+)?["“*`]*$/i.exec(prose.slice(0, start));
      if (before) out.set(field.label, /\{\{/.test(before[1]!) ? "token" : "literal");
    }
  }
  return out;
}

/** "press Edit on `x`" / "Edit on {{…}}": which entry to edit, named. */
const EDIT_ON = /\bedit\b[^.;\n]{0,20}?\bon\s+(?:the\s+)?(?:target\s+|entry\s+)?(`[^`\n]+`|"[^"\n]+"|“[^”\n]+”|\*\*[^*\n]+\*\*|\{\{[^}\n]+\}\})/i;

type Run = { form: OwnerForm; first: number; prose: string[]; add: boolean; edit: boolean; ifMissing: boolean };

/**
 * R18 over a card: consecutive steps that name the same registered form are one visit to it (step 1 opens the form,
 * step 2 ticks a box on it). A visit that adds an entry, or offers an "if it isn't there" branch, needs every
 * required field; one that only edits needs which entry, plus the fields of any group it touches (the deploy tag's
 * fields when it mentions the tag). A look-only visit ("check the target shows") needs nothing. A step that sends
 * the owner to a "Settings → … form" no registered form matches is refused too, so an unlisted form can't pass.
 */
export function formStepFindings(steps: readonly string[]): LintFinding[] {
  const out: LintFinding[] = [];
  let run: Run | null = null;
  const close = () => {
    if (!run) return;
    const r = run;
    run = null;
    if (!r.add && !r.edit && !r.ifMissing) return;
    const prose = r.prose.join("\n");
    const given = fieldValues(r.form, prose);
    const groups = (r.form.groups ?? []).filter((g) => new RegExp(g.when, "i").test(prose)).flatMap((g) => g.fields);
    const adding = r.add || r.ifMissing;
    const needed = [...(adding ? r.form.required : []), ...groups];
    const missing = needed.filter((f) => !given.has(f.label)).map((f) => f.label);
    if (!adding && !given.has(r.form.required[0]!.label) && !EDIT_ON.test(prose)) missing.unshift(`which entry to edit (its ${r.form.required[0]!.label})`);
    if (!missing.length) return;
    const branch = r.ifMissing
      ? ` An "if it isn't there" branch needs every value as well, or write two steps starting [if company.<slug>.deployTarget exists] and [if company.<slug>.deployTarget is missing], and Boss Man keeps the one that applies`
      : "";
    out.push({
      step: r.first,
      rule: "R18",
      problem: `sends the owner to ${r.form.name} (${r.form.path}) without ${missing.map((m) => (m.startsWith("which") ? m : `"${m}"`)).join(", ")}, so they can't fill in the form. Write each value in the step (Name \`…\`, Kind …), or a {{company.<slug>.deployTarget.<field>}} token Boss Man fills from its own record.${branch}`,
    });
  };
  steps.forEach((text, i) => {
    const prose = text.replace(BRANCH_MARKER, "");
    const forms = formsIn(prose);
    const form = forms[0];
    if (!form) {
      close();
      if (SETTINGS_PATH.test(prose) && /\bform\b/i.test(prose) && (ADD.test(prose) || FILL.test(prose))) {
        out.push({ step: i + 1, rule: "R18", problem: `sends the owner to a form Boss Man doesn't list, so it can't check the step gives every value. The forms it knows are: ${OWNER_FORMS.map((f) => `${f.name} (${f.path})`).join("; ")}. Name one of those, or ask for the form to be added to OWNER_FORMS` });
      }
      return;
    }
    if (run && (run as Run).form.id !== form.id) close();
    run ??= { form, first: i + 1, prose: [], add: false, edit: false, ifMissing: false };
    run.prose.push(prose);
    // "Add" is also the Secrets screen's kind picker and a Save-type word on some screens; it counts only as a verb.
    if (ADD.test(prose)) run.add = true;
    if (EDIT.test(prose)) run.edit = true;
    if (IF_MISSING.test(prose)) run.ifMissing = true;
    if (!run.add && !run.edit && FILL.test(prose)) run.edit = true;
  });
  close();
  return out;
}
