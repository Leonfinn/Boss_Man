// Merge check presets (R57): what Boss Man runs in a ticket's worktree before merging, as a
// choice in plain words rather than a command to write. The runner proposes one from the repo.

export type CheckPreset = {
  id: string;
  label: string;
  /** The command run in the worktree; null means merge after review only. */
  command: string | null;
  /** What it does, in plain words. */
  plain: string;
  /** Tools it needs on the runner, so the owner can be warned when one is missing. */
  needs: string[];
};

export const STANDARD_CHECKS: CheckPreset[] = [
  { id: "node-npm", label: "Node (npm)", command: "npm ci && npm test", plain: "Install with npm, then run the tests", needs: ["npm"] },
  { id: "node-pnpm", label: "Node (pnpm)", command: "pnpm install --frozen-lockfile && pnpm test", plain: "Install with pnpm, then run the tests", needs: ["pnpm"] },
  { id: "node-yarn", label: "Node (yarn)", command: "yarn install && yarn test", plain: "Install with yarn, then run the tests", needs: ["yarn"] },
  { id: "python-pytest", label: "Python (pytest)", command: "pip install -r requirements.txt && pytest", plain: "Install the requirements with pip, then run pytest", needs: ["python3", "pip"] },
  { id: "go", label: "Go", command: "go vet ./... && go test ./...", plain: "Run go vet and the Go tests", needs: ["go"] },
  { id: "rust", label: "Rust", command: "cargo test", plain: "Build and run the Rust tests with cargo", needs: ["cargo"] },
  { id: "make", label: "Make", command: "make test", plain: "Run make test", needs: ["make"] },
];

export const NO_CHECK: CheckPreset = { id: "none", label: "Nothing", command: null, plain: "Merge after review only", needs: [] };

/** The tools the runner is asked about. */
export const CHECK_TOOLS = ["node", "npm", "pnpm", "yarn", "python3", "pip", "uv", "poetry", "go", "cargo", "make"];

const NPM_PLACEHOLDER = /no test specified/;

/**
 * Proposes checks from a repo's top-level files, best first. `files` are the names at the root;
 * `read` returns a root file's text, or null. Nothing here runs the repo's code.
 */
export function detectChecks(files: string[], read: (name: string) => string | null): CheckPreset[] {
  const has = (name: string) => files.includes(name);
  const out: CheckPreset[] = [];

  if (has("package.json")) {
    let scripts: Record<string, string> = {};
    let manager = "";
    try {
      const pkg = JSON.parse(read("package.json") ?? "{}") as { scripts?: Record<string, string>; packageManager?: string };
      scripts = pkg.scripts ?? {};
      manager = (pkg.packageManager ?? "").split("@")[0] ?? "";
    } catch {
      // A package.json that doesn't parse gets the plain default below.
    }
    const pm = has("pnpm-lock.yaml") || manager === "pnpm" ? "pnpm" : has("yarn.lock") || manager === "yarn" ? "yarn" : "npm";
    const install = pm === "pnpm" ? "pnpm install --frozen-lockfile" : pm === "yarn" ? "yarn install" : has("package-lock.json") ? "npm ci" : "npm install";
    const run = (s: string) => (pm === "npm" ? (s === "test" ? "npm test" : `npm run ${s}`) : `${pm} ${s}`);
    const steps = ["typecheck", "lint", "test"].filter((s) => scripts[s] && !(s === "test" && NPM_PLACEHOLDER.test(scripts[s]!)));
    if (steps.length)
      out.push({
        id: "detected-node",
        label: "Run the tests (detected)",
        command: [install, ...steps.map(run)].join(" && "),
        plain: `Install with ${pm}, then run ${steps.length === 1 ? steps[0] : `${steps.slice(0, -1).join(", ")} and ${steps.at(-1)}`}`,
        needs: [pm],
      });
  }

  if (has("pyproject.toml") || files.some((f) => /^requirements.*\.txt$/.test(f))) {
    if (has("uv.lock")) out.push({ id: "detected-python", label: "Run the tests (detected)", command: "uv sync && uv run pytest", plain: "Install with uv, then run pytest", needs: ["uv"] });
    else if (has("poetry.lock")) out.push({ id: "detected-python", label: "Run the tests (detected)", command: "poetry install && poetry run pytest", plain: "Install with poetry, then run pytest", needs: ["poetry"] });
    else if (files.some((f) => /^requirements.*\.txt$/.test(f))) {
      const req = has("requirements.txt") ? "requirements.txt" : files.find((f) => /^requirements.*\.txt$/.test(f))!;
      out.push({ id: "detected-python", label: "Run the tests (detected)", command: `pip install -r ${req} && pytest`, plain: `Install ${req} with pip, then run pytest`, needs: ["python3", "pip"] });
    } else out.push({ id: "detected-python", label: "Run the tests (detected)", command: "pip install -e . && pytest", plain: "Install the project with pip, then run pytest", needs: ["python3", "pip"] });
  }

  if (has("go.mod")) out.push({ id: "detected-go", label: "Run the tests (detected)", command: "go vet ./... && go test ./...", plain: "Run go vet and the Go tests", needs: ["go"] });
  if (has("Cargo.toml")) out.push({ id: "detected-rust", label: "Run the tests (detected)", command: "cargo test", plain: "Build and run the Rust tests with cargo", needs: ["cargo"] });
  if ((has("Makefile") || has("makefile")) && /^test\s*:/m.test(read(has("Makefile") ? "Makefile" : "makefile") ?? ""))
    out.push({ id: "detected-make", label: "Run the tests (detected)", command: "make test", plain: "Run the repo's make test", needs: ["make"] });
  return out;
}
