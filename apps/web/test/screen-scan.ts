// A cheap, deterministic reader of the web source (BOS-1054): no browser, no TypeScript compiler, just text.
// It answers two questions for the guards in orphan-pages.test.ts and screen-inventory.test.ts:
//   1. Which components does the app actually render? (App.tsx's routes, and what they render, and so on down.)
//   2. For one screen, what section headings and API reads does it show?
// It is a text scan, not a parser, so it is built to over-count renders rather than miss them: a name counts as used when
// a component's code mentions it as a JSX tag or a bare name (called, passed as a prop). An import nobody uses is not a use.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

export type Chunk = { file: string; name: string; body: string; exported: boolean };
export type Parsed = { file: string; text: string; chunks: Map<string, Chunk>; imports: Map<string, { file: string; name: string }>; reexports: Map<string, { file: string; name: string }> };

const cache = new Map<string, Parsed>();

const resolveFrom = (fromFile: string, spec: string): string | null => {
  const base = join(dirname(fromFile), spec);
  for (const cand of [`${base}.tsx`, `${base}.ts`, join(base, "index.tsx"), join(base, "index.ts"), base]) if (existsSync(cand) && statSync(cand).isFile()) return cand;
  return null;
};

/** Top-level declarations start at column 0; a chunk runs to the next one. */
const DECL = /^(export\s+)?(?:default\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*[=:])/;

export function parse(file: string): Parsed {
  const hit = cache.get(file);
  if (hit) return hit;
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  const chunks = new Map<string, Chunk>();
  let cur: { name: string; exported: boolean; start: number } | null = null;
  const close = (end: number) => {
    if (cur) chunks.set(cur.name, { file, name: cur.name, exported: cur.exported, body: lines.slice(cur.start, end).join("\n") });
  };
  lines.forEach((line, i) => {
    const m = DECL.exec(line);
    if (!m) return;
    close(i);
    cur = { name: (m[2] ?? m[3])!, exported: !!m[1], start: i };
  });
  close(lines.length);
  const imports = new Map<string, { file: string; name: string }>();
  const reexports = new Map<string, { file: string; name: string }>();
  const out: Parsed = { file, text, chunks, imports, reexports };
  for (const m of text.matchAll(/^import\s+(?:type\s+)?([^;]*?)\s+from\s+"(\.[^"]*)"/gm)) {
    const target = resolveFrom(file, m[2]!);
    if (!target) continue;
    const spec = m[1]!;
    const def = /^(\w+)\s*(?:,|$)/.exec(spec);
    if (def) imports.set(def[1]!, { file: target, name: "default" });
    const braces = /\{([^}]*)\}/.exec(spec);
    for (const part of (braces?.[1] ?? "").split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p) continue;
      const [orig, alias] = p.split(/\s+as\s+/);
      imports.set((alias ?? orig)!.trim(), { file: target, name: orig!.trim() });
    }
  }
  // A page loaded on demand (BOS-1843): `const Board = lazyPage(() => import("./pages/Board"), "Board");` counts as importing Board.
  for (const m of text.matchAll(/^const\s+(\w+)\s*=\s*lazyPage\(\s*\(\)\s*=>\s*import\("(\.[^"]*)"\)\s*,\s*"(\w+)"/gm)) {
    const target = resolveFrom(file, m[2]!);
    if (target) imports.set(m[1]!, { file: target, name: m[3]! });
  }
  for (const m of text.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"(\.[^"]*)"/gm)) {
    const target = resolveFrom(file, m[2]!);
    if (!target) continue;
    for (const part of m[1]!.split(",")) {
      const p = part.trim();
      if (!p) continue;
      const [orig, alias] = p.split(/\s+as\s+/);
      reexports.set((alias ?? orig)!.trim(), { file: target, name: orig!.trim() });
    }
  }
  cache.set(file, out);
  return out;
}

/** Finds the chunk a name stands for in `file`, following re-exports. */
export function findChunk(file: string, name: string, seen = new Set<string>()): Chunk | null {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const p = parse(file);
  const own = p.chunks.get(name);
  if (own) return own;
  const re = p.reexports.get(name);
  return re ? findChunk(re.file, re.name, seen) : null;
}

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

/** The chunks a piece of code uses: JSX tags and bare names that stand for a function or component here or in an import. */
export function usesIn(file: string, code: string): Chunk[] {
  const p = parse(file);
  const found = new Map<string, Chunk>();
  const src = strip(code);
  // Only a JSX tag (<Name), a call (Name(), or a name handed over whole (={Name}) is a use. A bare word in prose ("Agents"
  // in a sentence) is not, or every page would "use" every component whose name it spells.
  for (const m of src.matchAll(/(<|=\{)?([A-Za-z_$][\w$]*)(\(|\}|\b)/g)) {
    const id = m[2]!;
    if (found.has(`${file}#${id}`)) continue;
    const prior = m.index! > 0 ? src[m.index! - 1] : "";
    if (prior === ".") continue; // a property (x.Name), not the name itself
    const used = m[1] === "<" || (m[1] === "={" && m[3] === "}") || m[3] === "(";
    if (!used) continue;
    const local = p.chunks.get(id);
    if (local && !/=\s*lazyPage\(/.test(local.body.slice(0, 200))) {
      found.set(`${file}#${id}`, local);
      continue;
    }
    const imp = p.imports.get(id);
    if (imp) {
      const c = findChunk(imp.file, imp.name);
      if (c) found.set(`${c.file}#${c.name}`, c);
    }
  }
  return [...found.values()];
}

/** Everything a set of starting chunks reaches by being used, the starting chunks included. */
export function closure(start: Chunk[], skip?: (c: Chunk) => boolean): Chunk[] {
  const seen = new Map<string, Chunk>();
  const queue = [...start];
  while (queue.length) {
    const c = queue.pop()!;
    const key = `${c.file}#${c.name}`;
    if (seen.has(key) || (skip && skip(c))) continue;
    seen.set(key, c);
    for (const u of usesIn(c.file, c.body)) queue.push(u);
  }
  return [...seen.values()];
}

export function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]))
    .sort();
}

export const rel = (file: string) => relative(SRC, file).split("\\").join("/");

// ---- headings and API reads -------------------------------------------------------------------------------------

const squash = (s: string) => s.replace(/\s+/g, " ").trim();
const dropBraces = (s: string) => {
  let prev = "";
  while (prev !== s) {
    prev = s;
    s = s.replace(/\{[^{}]*\}/g, "…");
  }
  return s;
};
const plain = (s: string) => squash(dropBraces(s.replace(/<[^>]*>/g, " ")).replace(/&amp;/g, "&").replace(/&nbsp;/g, " ")).replace(/ ([,.:)])/g, "$1").replace(/\( /g, "(");

/** Section headings a chunk shows: <h1>–<h4> text, and the title of a <Section>. A heading that is only a variable has no text to record. */
export function headingsOf(code: string): string[] {
  const out = new Set<string>();
  const src = strip(code);
  for (const m of src.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/g)) {
    const t = plain(m[2]!);
    // Heading text built from several expressions is not stable text to list; leave it out.
    if (/[A-Za-z]/.test(t) && (t.match(/…/g) ?? []).length < 2 && !/[=<>{}]/.test(t)) out.add(t);
  }
  for (const m of src.matchAll(/<Section\b[^>]*?\btitle=(?:"([^"]*)"|\{"([^"]*)"\}|\{`([^`]*)`\})/g)) {
    const t = plain((m[1] ?? m[2] ?? m[3])!.replace(/\$\{[^}]*\}/g, "…"));
    if (/[A-Za-z]/.test(t)) out.add(t);
  }
  return [...out];
}

/** Scans a quoted or template literal starting at `i` (the opening quote); returns its text and the index after it. */
function literalAt(src: string, i: number): { text: string; end: number } | null {
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== "`") return null;
  let j = i + 1;
  let text = "";
  while (j < src.length) {
    const ch = src[j]!;
    if (ch === "\\") {
      text += src[j + 1] ?? "";
      j += 2;
    } else if (ch === q) return { text, end: j + 1 };
    else if (q === "`" && ch === "$" && src[j + 1] === "{") {
      let depth = 1;
      let k = j + 2;
      while (k < src.length && depth) {
        if (src[k] === "{") depth++;
        else if (src[k] === "}") depth--;
        k++;
      }
      text += "${}";
      j = k;
    } else {
      text += ch;
      j++;
    }
  }
  return null;
}

/** `/api/x/${id}/y?q=${z}` → `/api/x/:id/y`; a `${}` not after a slash (a query tail) is dropped. */
const normPath = (raw: string) => {
  const path = raw.split("?")[0]!;
  return path.replace(/(\/?)\$\{\}/g, (_m, slash: string) => (slash ? "/:id" : ""));
};

/** The API paths a chunk reads: api()/apiOnce()/fetch() calls with a path that start with /api and are not a write (POST, PUT, PATCH, DELETE). */
export function apiReadsOf(code: string): string[] {
  const out = new Set<string>();
  const src = strip(code);
  const call = /\b(?:api|apiOnce|fetch)(?:<[^()]*>)?\(\s*(?=["'`])/g;
  for (const m of src.matchAll(call)) {
    const lit = literalAt(src, m.index! + m[0].length);
    if (!lit || !lit.text.startsWith("/api")) continue;
    const next = src.slice(lit.end).search(/\b(?:api|apiOnce|fetch)(?:<[^()]*>)?\(/);
    const window = src.slice(lit.end, lit.end + Math.min(next < 0 ? 200 : next, 200));
    const method = /method:\s*["'](\w+)["']/.exec(window)?.[1];
    if (method && method.toUpperCase() !== "GET") continue;
    out.add(normPath(lit.text));
  }
  return [...out];
}

// ---- the screens ------------------------------------------------------------------------------------------------

/** `own` is JSX the screen writes inline (a Settings panel's own sections), on top of the components it renders. */
export type Screen = { id: string; roots: Chunk[]; own?: string; note?: string };

const appFile = join(SRC, "App.tsx");
const settingsFile = join(SRC, "pages", "Settings.tsx");

/** App.tsx's routes: each `page === "name"` arm of the screen switch, with the components it renders. The last arm is the default. */
export function routeScreens(): Screen[] {
  const text = parse(appFile).text;
  const start = text.indexOf("{redirect ? null :");
  const end = text.indexOf("</PageGuard>", start);
  const region = text.slice(start, end);
  const arms = [...region.matchAll(/page === "([\w-]+)"/g)];
  const screens: Screen[] = [];
  const tagsIn = (code: string) => usesIn(appFile, [...code.matchAll(/<([A-Z]\w*)/g)].map((m) => m[0]).join(" ")).filter((c) => c.file !== appFile);
  arms.forEach((a, i) => {
    const code = region.slice(a.index!, i + 1 < arms.length ? arms[i + 1]!.index! : region.length);
    const id = a[1]!;
    if (screens.some((s) => s.id === id)) {
      // `page === "tickets" && route[1]` style arms: merge into one screen
      screens.find((s) => s.id === id)!.roots.push(...tagsIn(code));
      return;
    }
    screens.push({ id, roots: tagsIn(code) });
  });
  const last = arms[arms.length - 1]!;
  const tail = region.slice(last.index!).split(/\) : \(/).pop()!; // the default arm after the final `: (`
  screens.push({ id: "(default)", roots: tagsIn(tail) });
  // Settings is a menu plus panels (below); its own screen is just the menu, so the panels and the two embedded pages go.
  const settings = screens.find((s) => s.id === "settings")!;
  settings.roots = settings.roots
    .filter((c) => c.name === "Settings")
    .map((c) => {
      const from = c.body.indexOf("const panels");
      const to = c.body.indexOf("\n  };", from);
      return { ...c, body: c.body.slice(0, from) + c.body.slice(to) };
    });
  return screens.map((s) => ({ ...s, id: `#/${s.id}` }));
}

/** The Settings panels: the arms of `const panels` in Settings.tsx. Secrets and Permissions embed a whole page that App.tsx passes in as children. */
export function settingsPanels(): Screen[] {
  const p = parse(settingsFile);
  const settings = p.chunks.get("Settings")!;
  const from = settings.body.indexOf("const panels");
  const to = settings.body.indexOf("\n  };", from);
  const region = settings.body.slice(from, to);
  const keys = [...region.matchAll(/^ {4}(\w+): /gm)];
  const embedded: Record<string, string[]> = { secrets: ["Secrets"], permissions: ["Rules"] };
  return keys.map((k, i) => {
    const code = region.slice(k.index!, i + 1 < keys.length ? keys[i + 1]!.index! : region.length);
    const id = k[1]!;
    const tags = [...code.matchAll(/<([A-Z]\w*)/g)].map((m) => m[0]).join(" ");
    const roots = usesIn(settingsFile, tags);
    for (const e of embedded[id] ?? []) {
      const c = findChunk(join(SRC, "pages", `${e}.tsx`), e);
      if (c) roots.push(c);
    }
    return { id: `#/settings/<company>/${id}`, roots, own: code };
  });
}

export type Inventory = { id: string; sections: string[]; reads: string[]; note?: string };

/** One screen's headings and API reads, from everything it renders. Shared building blocks and the page chrome add nothing but a variable. */
export function inventoryOf(screen: Screen): Inventory {
  const chunks = closure(screen.roots);
  const sections = new Set<string>();
  const reads = new Set<string>();
  if (screen.own) {
    for (const h of headingsOf(screen.own)) sections.add(h);
    for (const r of apiReadsOf(screen.own)) reads.add(r);
  }
  for (const c of chunks) {
    for (const h of headingsOf(c.body)) sections.add(h);
    for (const r of apiReadsOf(c.body)) reads.add(r);
  }
  return { id: screen.id, sections: [...sections].sort(), reads: [...reads].sort(), note: screen.note };
}

export function allScreens(): Screen[] {
  return [...routeScreens(), ...settingsPanels()];
}

/** Every component chunk that App.tsx (or the customer portal's entry) renders, directly or through anything it renders. */
export function renderedFromApp(): Set<string> {
  const roots: Chunk[] = [];
  // The entry points mount the app (main.tsx), the customer portal (portal-main.tsx) and the portal's email confirm page
  // (confirm-main.tsx); their top-level code is the root.
  for (const entry of [join(SRC, "main.tsx"), join(SRC, "portal-main.tsx"), join(SRC, "confirm-main.tsx")]) {
    if (!existsSync(entry)) continue;
    roots.push(...usesIn(entry, parse(entry).text.replace(/^import[^;]*;$/gm, "")));
  }
  return new Set(closure(roots).map((c) => `${c.file}#${c.name}`));
}
