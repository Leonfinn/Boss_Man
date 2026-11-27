// R8 and R13 of the owner-card lint (BOS-442, from the BOS-421 addendum): a card must send the owner to the
// screen that really has what it names, and must say what to put in each field it tells them to fill in.
// 3 Nov: one card sent the owner to Settings for the merge-check setting (it's on the project's Config tab), and
// another named the wrong page for adding a funding source and left the Secrets "Variable name" field unsaid.
//
// Everything here reads the owner-control list (OWNER_CONTROLS, OWNER_FIELDS, OWNER_MENU, OWNER_TABS), which a
// test keeps in step with the web app, so a rule can't drift from the screens it checks.
//
// The rules refuse only on proof: a path part that is a known screen in the wrong place, or a button or field the
// list puts only on other screens. Words the list doesn't know (a section heading such as "Updates") are passed
// over, and a button that is on every screen (Save) is never refused for its place.

import { OWNER_CONTROLS, OWNER_FIELDS, OWNER_MENU, OWNER_SECTIONS, OWNER_TABS, type OwnerScreen } from "@boss-man/shared";

/** A label as compared: lower case, words only ("Saved ✓" is "saved", "Done: mark processed" is "done mark processed"). */
export const norm = (s: string) => s.toLowerCase().replace(/’/g, "'").replace(/[^\p{L}\p{N}']+/gu, " ").trim();

/** A place in the app a step can send the owner to. `tabs` are the places under it; `projects` means any project name follows. */
type Place = { route: string; screen: OwnerScreen | null; tabs: readonly string[]; projects?: boolean; sections?: readonly string[] };

const isScreen = (s: string): s is OwnerScreen => Object.hasOwn(OWNER_CONTROLS, s);
const sectionsOf = (tabs: readonly string[]): string[] => tabs.flatMap((t) => (OWNER_SECTIONS as Record<string, readonly string[]>)[t] ?? []);
/** Every part after a place that lists its pages must be one of them (BOS-1649); places with `sections` list them, tabs, headings, buttons and fields. */
const pagesOf = (p: Place) => [...p.tabs, ...(p.sections ?? [])];
/** Menu entries whose label is longer than their screen's name (BOS-1494: plain words on the menu). */
const MENU_SCREEN: Record<string, OwnerScreen> = { "Scrum Master log": "Scrum Master", "Workflow report": "Workflow" };
const top = (name: string): Place => ({
  route: name,
  screen: MENU_SCREEN[name] ?? (isScreen(name) ? name : null),
  tabs: name === "Settings" ? OWNER_TABS.Settings : [],
  ...(name === "Settings" ? { sections: sectionsOf(OWNER_TABS.Settings) } : {}),
  ...(name === "Projects" ? { projects: true } : {}),
});
/** A project's page: the project's name is a path part of its own ("Projects → Development → Config"). */
const PROJECT: Place = { route: "Projects → (the project)", screen: "Board", tabs: OWNER_TABS.Board, sections: [] };
const BOARD_TAB_SCREEN: Record<string, OwnerScreen> = { Kanban: "Board", Config: "Config" };
function tab(parent: Place, name: string): Place {
  const screen = parent === PROJECT ? BOARD_TAB_SCREEN[name] ?? null : isScreen(name) ? name : null;
  return { route: `${parent.route} → ${name}`, screen, tabs: [], sections: sectionsOf([name]) };
}

/**
 * "Server and runner" is the name of a group of Settings pages, not a page (BOS-1492). Cards and notices still write
 * "Settings → Server and runner → Updates", and they stay true: the group is a place of its own whose pages are the last
 * Settings pages before "Import and export", and its buttons and fields are the ones on those pages.
 */
const SERVER_GROUP = "Server and runner";
const SERVER_AND_RUNNER: Place = {
  route: `Settings → ${SERVER_GROUP}`,
  screen: "Server and runner",
  tabs: OWNER_TABS.Settings.filter((t) => ["Updates", "Limits and checks", "Runner", "Email", "This server", "Devices and privacy"].includes(t)),
  sections: sectionsOf(["Updates", "Limits and checks", "Runner", "Email", "This server", "Devices and privacy"]),
};

/** Every place a step can name, by its normalised name: the side menu, Setup, and the tabs of Settings and a project. */
const PLACES = (() => {
  const out = new Map<string, Place>(); // not state: local to the PLACES lookup-table builder
  for (const m of OWNER_MENU) out.set(norm(m), top(m));
  // The menu's names before BOS-1494, so a step that still says "Scrum Master" or "Workflow" finds its page.
  for (const [label, screen] of Object.entries(MENU_SCREEN)) out.set(norm(screen), top(label));
  out.set("project", top("Projects"));
  const setup: Place = { route: "Setup (Settings → Run the setup wizard)", screen: "Setup", tabs: [] };
  out.set("setup", setup);
  out.set("setup wizard", setup);
  for (const t of OWNER_TABS.Settings) out.set(norm(t), tab(top("Settings"), t));
  for (const t of OWNER_TABS.Board) out.set(norm(t), tab(PROJECT, t));
  out.set(norm(SERVER_GROUP), SERVER_AND_RUNNER);
  return out;
})();

/** How a refusal names a screen: by the path to it. */
const SCREEN_ROUTE: Partial<Record<OwnerScreen, string>> = {
  Board: PROJECT.route, Ticket: "a ticket's page", Run: "a run's page", "Feedback portal": "the public feedback portal", "Log in": "the log-in page",
};
function whereIs(s: OwnerScreen): string {
  if (SCREEN_ROUTE[s]) return SCREEN_ROUTE[s];
  for (const p of PLACES.values()) if (p.screen === s) return p.route;
  return s;
}
const whereAll = (screens: Iterable<OwnerScreen>) => [...new Set([...screens].map(whereIs))].join(", or ");

/** The screens each listed button and field is on, by normalised label (a "(note)" may be left off, as cards do). */
function screensByLabel(lists: Partial<Record<OwnerScreen, readonly string[]>>) {
  const out = new Map<string, Set<OwnerScreen>>(); // not state: local to screensByLabel
  for (const [screen, labels] of Object.entries(lists) as Array<[OwnerScreen, readonly string[]]>) {
    for (const l of labels) {
      const base = l.replace(/\s*…$/, "");
      for (const k of new Set([norm(base), norm(base.replace(/\s*\([^)]*\)$/, ""))])) if (k) (out.get(k) ?? out.set(k, new Set()).get(k)!).add(screen);
    }
  }
  return out;
}
const CONTROL_SCREENS = screensByLabel(OWNER_CONTROLS);
const FIELD_SCREENS = screensByLabel(OWNER_FIELDS);
const screensOf = (n: string): Set<OwnerScreen> | undefined => {
  const c = CONTROL_SCREENS.get(n);
  const f = FIELD_SCREENS.get(n);
  return c && f ? new Set([...c, ...f]) : c ?? f;
};

/** Every section heading, normalised: a path part that starts with one ends there ("→ Checks lands tickets…"). */
const SECTION_NAMES = new Set(sectionsOf(Object.keys(OWNER_SECTIONS)).map(norm));

/** Where a step sends the owner: the place, and where in the step's text it is named. */
type PlaceHit = { at: number; place: Place | null };

const ARROW = /\s*(?:→|->|⟶|»|\s>\s)\s*/;
/** A path part as written, without its quoting and the words around a name ("the Secrets tab"). */
const bare = (s: string) =>
  s.replace(/[*"“”`]/g, "").replace(/^\s*(?:the|a|your)\s+/i, "").replace(/\s+(?:tab|page|screen|section|menu|button)\s*$/i, "").trim();
/** The longest run of words at the start (or end) of `s` that names a place, button or field, up to 8 words. */
function knownRun(s: string, fromEnd: boolean): string | null {
  const words = bare(s).split(/\s+/).filter(Boolean);
  for (let k = Math.min(8, words.length); k > 0; k--) {
    const run = (fromEnd ? words.slice(-k) : words.slice(0, k)).join(" ");
    const n = norm(run);
    if (PLACES.has(n) || screensOf(n) || SECTION_NAMES.has(n)) return run;
  }
  return null;
}

/** Sentences of the step's text with where each starts; a full stop only ends one before a space (so "SKILL.md" stays whole). */
const sentences = (prose: string) => [...prose.matchAll(/(?:[^.;!?\n]|[.!?](?!\s|$))+/g)].map((m) => ({ text: m[0], at: m.index }));

/**
 * R8: follow each path a step gives ("Settings → Secrets", "Projects → Development → Config") from the place before
 * it, and refuse a part that isn't there. A part that is a button or field ends the path and must be on its screen.
 */
function walkPaths(prose: string, problems: string[]): PlaceHit[] {
  const hits: PlaceHit[] = [];
  for (const s of sentences(prose)) {
    for (const chain of chainsIn(s.text)) {
      const place = walk(chain.parts, problems);
      if (place !== undefined) hits.push({ at: s.at + chain.end, place });
    }
  }
  return hits;
}

/** What ends a path inside a part: "→ Updates: it should show…", "→ Server, and then…". */
const BREAK = /[,;:(]|\s(?:and|then)\s/;

/**
 * The paths in one sentence, each as its parts and where its last part starts. A sentence can hold several
 * ("Open Settings → Server and runner → Updates: it shows…, Settings → Reviews should…"): a part with a
 * comma, colon or "and" in it that isn't itself a name ends one path, and the name at its end starts the next.
 */
function chainsIn(text: string): Array<{ parts: string[]; end: number }> {
  const segs: Array<{ text: string; at: number }> = [];
  let from = 0;
  for (const m of text.matchAll(new RegExp(ARROW.source, "g"))) {
    segs.push({ text: text.slice(from, m.index), at: from });
    from = m.index + m[0].length;
  }
  segs.push({ text: text.slice(from), at: from });
  if (segs.length < 2) return [];
  const out: Array<{ parts: string[]; end: number }> = [];
  let cur: string[] | null = null;
  const startAt = (seg: string) => {
    const first = knownRun(seg, true);
    return first ? [first] : null;
  };
  cur = startAt(segs[0]!.text);
  for (let i = 1; i < segs.length; i++) {
    const seg = segs[i]!;
    const whole = bare(seg.text);
    const last = i === segs.length - 1;
    if (!last && (PLACES.has(norm(whole)) || screensOf(norm(whole)) || !BREAK.test(seg.text))) {
      cur?.push(whole);
      continue;
    }
    if (cur) out.push({ parts: [...cur, knownRun(seg.text, false) ?? bare(seg.text.split(BREAK)[0]!)], end: seg.at });
    cur = last ? null : startAt(seg.text);
  }
  return out;
}

/** A review kind as the Reviews page names it, normalised: "security", "security review(er)", "reviews for security". Group 1 is set by "reviews for". */
const REVIEW_KIND = /^(reviews for )?(?:security|infra|infrastructure|adversarial|code)(?: review(?:er)?)?$/;

/** Follow one path from its first part; the place it reaches, null after a refusal, or undefined if it starts nowhere known. */
function walk(parts: string[], problems: string[]): Place | null | undefined {
  const start = PLACES.get(norm(parts[0]!));
  if (!start) return undefined;
  let at: Place = start;
  for (const raw of parts.slice(1)) {
    const n = norm(raw);
    if (!n) break;
    // The Reviews page names its reviewers by kind (Security review, Infrastructure review, Adversarial review, code
    // reviewed by). "Security" is also an Outgoing email field, so without this a path to the Security reviewer was
    // refused as sitting on Server and runner (BOS-2716). "Reviews for Security" is the same page.
    const kind = REVIEW_KIND.exec(n);
    if (kind && (at.screen === "Reviews" || (at.route === "Settings" && kind[1]))) {
      if (at.route === "Settings") at = tab(at, "Reviews");
      break;
    }
    // A tab may be named by its first words ("Settings → Reviews" is Reviews and CEO), as cards shorten them.
    const child = at.tabs.find((t) => norm(t) === n) ?? at.tabs.find((t) => norm(t).startsWith(`${n} `));
    if (child) { at = tab(at, child); continue; }
    if (at.route === "Settings" && (n === norm(SERVER_GROUP) || norm(SERVER_GROUP).startsWith(`${n} `))) { at = SERVER_AND_RUNNER; continue; }
    if (at.projects) {
      const boardTab = OWNER_TABS.Board.find((t) => norm(t) === n);
      at = boardTab ? tab(PROJECT, boardTab) : PROJECT;
      continue;
    }
    const elsewhere = PLACES.get(n);
    if (elsewhere) {
      problems.push(`sends the owner to ${at.route} → ${raw}, but ${raw} isn't under ${at.route}: it is ${elsewhere.route}. Give the path as the app shows it`);
      return null;
    }
    const screens = screensOf(n);
    if (!screens) {
      // A listed section heading: the path goes on from the same place. Where the place lists its pages, any other
      // word is not a page there (BOS-1649). Other places have no list, so their unknown words pass.
      if (!at.sections?.length || at.sections.some((s) => norm(s) === n || norm(s).startsWith(`${n} `) || n.startsWith(`${norm(s)} `))) continue;
      problems.push(`sends the owner to ${at.route} → ${raw}, but there is no "${raw}" under ${at.route}. What is there: ${pagesOf(at).join(", ")}. Give a path the app shows`);
      return null;
    }
    if (at.screen && !screens.has("Any screen") && !screens.has(at.screen)) {
      problems.push(`sends the owner to ${at.route} for "${raw}", which isn't there: it is on ${whereAll(screens)}. Give the path to that screen`);
      return null;
    }
    break; // A button or field ends the path.
  }
  return at;
}

/** Whether the text has a "Settings → …" path that walks to a real page, tab or heading (R17 counts only such a path as a how-to, BOS-1649). */
export function hasWalkingSettingsPath(prose: string): boolean {
  return walkingMenuRoot(prose, "settings") !== null;
}

/**
 * The owner-menu entry (as the menu writes it, e.g. "Wiki") that the first path in the text starts from, when that path
 * walks to a real page, tab, heading, button or field (R21, BOS-2117). `only` limits it to one entry (lower-case).
 * A path that doesn't start at the menu, or that the walker refuses, gives null.
 */
export function walkingMenuRoot(prose: string, only?: string): string | null {
  for (const s of sentences(prose)) {
    for (const chain of chainsIn(s.text)) {
      const root = norm(chain.parts[0]!);
      if (only && root !== only) continue;
      const entry = OWNER_MENU.find((m) => norm(m) === root);
      if (!entry) continue;
      const problems: string[] = [];
      if (walk(chain.parts, problems) !== undefined && !problems.length) return entry;
    }
  }
  return null;
}

/** A place named without an arrow: "Open Settings and…", "on the Secrets page", "under Config". */
function namedPlaces(prose: string, skip: Array<[number, number]>): PlaceHit[] {
  const hits: PlaceHit[] = [];
  const names = [...new Set([...OWNER_MENU, ...OWNER_TABS.Settings, ...OWNER_TABS.Board, "Setup"])].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const re = new RegExp(String.raw`\b(?:open|go to|in|on|under|from|at)\s+(?:the\s+)?[*"“]*${name}[*"”]*(?=[\s.,;:!?)]|$)`, "gi");
    for (const m of prose.matchAll(re)) {
      // The name itself must be written as the app writes it ("in settings" is not a screen).
      if (!m[0].includes(name) || skip.some(([a, b]) => m.index >= a && m.index < b)) continue;
      if (hits.some((h) => h.at === m.index)) continue;
      hits.push({ at: m.index, place: PLACES.get(norm(name))! });
    }
  }
  return hits;
}

/** The place a name at `pos` is read against: the last one named before it, or else the next one in its sentence. */
function placeFor(pos: number, hits: PlaceHit[], sents: ReturnType<typeof sentences>): PlaceHit | null {
  let best: PlaceHit | null = null;
  for (const h of hits) if (h.at <= pos && (!best || h.at > best.at)) best = h;
  if (best) return best;
  const end = sents.find((s) => pos >= s.at && pos < s.at + s.text.length);
  const after = hits.filter((h) => h.at > pos && (!end || h.at < end.at + end.text.length)).sort((a, b) => a.at - b.at);
  return after[0] ?? null;
}

/** A field the step names: its label as listed and where it is written. */
type FieldMention = { label: string; start: number; end: number };

/** The listed fields, longest first, each as a pattern over its words (so "Before merging, Boss Man will…" matches with or without the comma). */
const FIELD_PATTERNS = (() => {
  const seen = new Set<string>(); // not state: local to the FIELD_PATTERNS lookup-table builder
  const out: Array<{ label: string; words: number; first: string; re: RegExp; exact: RegExp }> = [];
  for (const labels of Object.values(OWNER_FIELDS) as ReadonlyArray<readonly string[]>) {
    for (const l of labels) {
      const base = l.replace(/\s*…$/, "");
      for (const form of new Set([base, base.replace(/\s*\([^)]*\)$/, "")])) {
        const words = form.split(/[^\p{L}\p{N}']+/u).filter(Boolean);
        const key = words.join(" ").toLowerCase();
        if (!words.length || seen.has(key)) continue;
        seen.add(key);
        const body = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(String.raw`[^\p{L}\p{N}']+`);
        const src = String.raw`(?<![\p{L}\p{N}])${body}(?![\p{L}\p{N}])`;
        out.push({ label: form, words: words.length, first: foldCase(words[0]!), re: new RegExp(src, "giu"), exact: new RegExp(`^${src}$`, "u") });
      }
    }
  }
  return out.sort((a, b) => b.label.length - a.label.length);
})();

const FILL = String.raw`fill(?:\s+in|\s+out)?|enter|type|put|paste|set|choose|pick|select|change|complete|write`;
const VERB = new RegExp(String.raw`\b(?:(${FILL})|(leave|tick|untick|turn on|turn off|switch on|switch off)|(press|click|tap|hit|open|go to))\b`, "gi");

// BOS-2124: the end-anchored tests on the text before a field, compiled once (they used to be built per match).
const QUOTE_BEFORE = /(?:\*\*|["“`'])$/;
const FILL_BEFORE_ONE = new RegExp(String.raw`\b(?:${FILL})\s+(?:the\s+)?$`, "i");
const FILL_BEFORE_MANY = new RegExp(String.raw`\b(?:${FILL})\s+(?:the\s+|a\s+|an\s+|your\s+)?$`, "i");
const PRESS_BEFORE = /\b(?:press|click|tap|hit)\s+(?:on\s+)?(?:the\s+)?[*"“`']*$/i;

/**
 * BOS-2124: the end of the text before `end` that the three tests above can reach, so each test reads a few dozen
 * characters, not everything before the field (that made the cost grow with the square of a long step). The result is
 * the same as on the whole text: a match of any of them has at most 12 characters that aren't spaces or quote marks
 * ("complete your", "click on the"), and their runs of spaces and quote marks have no limit. So the tail takes the last
 * TAIL_SOLID such characters with every space and quote mark between them, plus one character before, which `\b` reads.
 */
const TAIL_SOLID = 32;
const TAIL_FREE = /[\s*"“”`'…]/;
function tailBefore(prose: string, end: number): string {
  let i = end;
  for (let solid = 0; i > 0 && solid < TAIL_SOLID; ) if (!TAIL_FREE.test(prose[--i]!)) solid++;
  return prose.slice(Math.max(0, i - 1), end);
}

/**
 * Lower case as the "iu" flags compare letters, for the prefilter below. Under simple case folding only two letters
 * outside ASCII match an ASCII one: the Kelvin sign, which toLowerCase already makes "k", and the long s ("ſ"), which
 * it leaves alone.
 */
function foldCase(s: string): string {
  return s.toLowerCase().replace(/ſ/g, "s");
}

/**
 * The fields a step names. A field counts when its label is quoted or bold, followed by "field" or "box", written as
 * the app writes it with two words or more ("Variable name"), or right after a fill-in word ("set Kind"). A single
 * common word ("name", "value") in a sentence is not taken as a field, and a label after press/click is a button.
 */
export function fieldMentions(prose: string): FieldMention[] {
  const out: FieldMention[] = [];
  // A label whose first word isn't in the text can't match, so its regex isn't run (BOS-2124).
  const folded = foldCase(prose);
  for (const f of FIELD_PATTERNS) {
    if (!folded.includes(f.first)) continue;
    for (const m of prose.matchAll(f.re)) {
      const start = m.index;
      const end = start + m[0].length;
      if (out.some((o) => start < o.end && end > o.start)) continue;
      const before = tailBefore(prose, start);
      const after = prose.slice(end);
      const quoted = QUOTE_BEFORE.test(before) && /^…?(?:\*\*|["”`'])/.test(after);
      const fieldWord = /^[\s*"”`'…]*(?:field|box|drop-?down|menu|setting|check ?box|tick ?box)\b/i.test(after);
      const asWritten = f.exact.test(m[0]) && /^\p{Lu}/u.test(m[0]);
      const afterFill = (f.words > 1 ? FILL_BEFORE_MANY : FILL_BEFORE_ONE).test(before);
      if (PRESS_BEFORE.test(before)) continue;
      if (quoted || fieldWord || (asWritten && f.words > 1) || (afterFill && (asWritten || f.words > 1))) out.push({ label: f.label, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

const ANY_VALUE = /\bany (?:value|name|text|word|number|title)\b|\banything\b|\bwhatever you (?:like|want)\b|\b(?:doesn't|does not) matter\b|\bblank\b|\bempty\b|\bas (?:it )?is\b|\bthe default\b|\bany\b[^.;]*\bworks?\b/i;
const SOURCED = /\byou (?:copied|got|saved|made|noted|wrote down|chose)\b|\b(?:from|in) step \d+\b|\b(?:above|below)\b|\bshown (?:on|in|at)\b/i;
const LITERAL = /`[^`\n]+`|"[^"\n]+"|“[^”\n]+”|\*\*[^*\n]+\*\*/g;

/** Whether the words around a field mention give its value: "set F to X", "paste X into F", a literal, a number, "any value works". */
function valueGiven(prose: string, f: FieldMention, sentence: string): boolean {
  if (ANY_VALUE.test(sentence)) return true;
  // The clause: from the last ", " / " and " / " then " before the field to the first after it.
  const cut = /,\s|\s(?:and|then)\s|[.;!?\n]/g;
  let from = 0;
  for (const m of prose.slice(0, f.start).matchAll(cut)) from = m.index + m[0].length;
  const tail = prose.slice(f.end);
  const stop = tail.search(cut);
  const before = prose.slice(from, f.start);
  const after = stop < 0 ? tail : tail.slice(0, stop);
  if (/^[\s*"”`'…]*(?:field|box|drop-?down|menu|setting)?\s*(?:to|as|with|:|=)\s*\S/i.test(after)) return true;
  const rest = `${before} ${after}`;
  if (/\d/.test(rest) || SOURCED.test(rest)) return true;
  for (const m of rest.matchAll(LITERAL)) {
    const inner = norm(m[0]);
    if (inner && !screensOf(inner) && !PLACES.has(inner)) return true;
  }
  // "paste the token into F": what is pasted is the value, unless it is only "a name" or "a value".
  const object = new RegExp(String.raw`\b(?:${FILL})\s+(.+?)\s+(?:in|into|under|for)\s+(?:the\s+)?[*"“\`']*$`, "i").exec(before);
  if (object && !/^(?:a|an|some|any)\b/i.test(object[1]!.trim()) && norm(object[1]!) !== norm(f.label)) return true;
  return false;
}

/** The nearest action word before a field in its sentence (or, with none, the first after it): which is it? */
function actionFor(prose: string, f: FieldMention, sentence: { text: string; at: number }): "fill" | "done" | "other" | null {
  let kind: "fill" | "done" | "other" | null = null;
  for (const m of sentence.text.matchAll(VERB)) {
    const pos = sentence.at + m.index;
    if (pos >= f.start) {
      if (kind === null && pos >= f.end) return m[1] ? "fill" : m[2] ? "done" : "other";
      break;
    }
    kind = m[1] ? "fill" : m[2] ? "done" : "other";
  }
  return kind;
}

/** A button the step tells the owner to press (from R7's reading), as its normalised label and where it is named. */
export type Pressed = { label: string; at: number };

/**
 * R8 and R13 for one step's sentences. `pressed` are the listed buttons the step names (R7 found them; a card's own
 * options and keys are left out). Returns the problems for each rule, and the screen the step ends on, which R7
 * uses to list the right buttons.
 */
export function screenFindings(prose: string, pressed: Pressed[]): ScreenFindings {
  const key = `${JSON.stringify(pressed)}\u0000${prose}`;
  let found = findingsCache.get(key);
  if (!found) {
    found = readScreens(prose, pressed);
    if (findingsCache.size >= FINDINGS_CACHE_MAX) findingsCache.clear();
    findingsCache.set(key, found);
  }
  // Copies, so a caller that adds to its lists can't change what the next caller with the same step is given.
  return { r8: [...found.r8], r13: [...found.r13], screen: found.screen };
}

type ScreenFindings = { r8: string[]; r13: string[]; screen: OwnerScreen | null };

// lost on restart, harmless because it only remembers a pure function of the step's text and buttons. BOS-2124: while a
// CEO setup-fix card is open, the go-live retry (release-log.ts) re-lints the same unchanged steps on every deployer
// poll, about once a minute. Bounded: emptied whenever it reaches FINDINGS_CACHE_MAX steps.
const findingsCache = new Map<string, ScreenFindings>();
const FINDINGS_CACHE_MAX = 500;

function readScreens(prose: string, pressed: Pressed[]): ScreenFindings {
  const r8: string[] = [];
  const r13: string[] = [];
  const paths = walkPaths(prose, r8);
  // Split once: each field and place below used to split the whole text again (BOS-2124).
  const sents = sentences(prose);
  const pathSpans = sents.filter((s) => ARROW.test(s.text)).map((s): [number, number] => [s.at, s.at + s.text.length]);
  // Clicking a menu item or a tab ("click Config") goes there: it is a place, not a button to check.
  const clicked = pressed.filter((p) => PLACES.has(p.label)).map((p): PlaceHit => ({ at: p.at, place: PLACES.get(p.label)! }));
  const hits = [...paths, ...namedPlaces(prose, pathSpans), ...clicked];
  const fields = fieldMentions(prose);
  const named: Array<{ name: string; n: string; at: number }> = [
    ...pressed.filter((p) => !PLACES.has(p.label)).map((p) => ({ name: p.label, n: p.label, at: p.at })),
    ...fields.map((f) => ({ name: f.label, n: norm(f.label), at: f.start })),
  ];
  for (const x of named) {
    const hit = placeFor(x.at, hits, sents);
    const screen = hit?.place?.screen;
    const screens = screensOf(x.n);
    if (!hit?.place || !screen || !screens || screens.has("Any screen") || screens.has(screen)) continue;
    const problem = `sends the owner to ${hit.place.route} for "${x.name}", which isn't there: it is on ${whereAll(screens)}. Give the path to that screen`;
    if (!r8.includes(problem)) r8.push(problem);
  }
  for (const f of fields) {
    const sentence = sents.find((s) => f.start >= s.at && f.start < s.at + s.text.length) ?? { text: prose, at: 0 };
    if (actionFor(prose, f, sentence) !== "fill" || valueGiven(prose, f, sentence.text)) continue;
    const problem = `tells the owner to fill in "${f.label}" but doesn't say what to put there. Give the value (set ${f.label} to \`…\`), or say plainly that any value works`;
    if (!r13.includes(problem)) r13.push(problem);
  }
  const lastPlace = [...hits].sort((a, b) => b.at - a.at).find((h) => h.place?.screen);
  return { r8, r13, screen: lastPlace?.place?.screen ?? null };
}
