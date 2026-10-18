import { describe, expect, it } from "vitest";
import { detectChecks } from "../src/checks.js";

const repo = (files: Record<string, string>) => [Object.keys(files), (name: string) => files[name] ?? null] as const;

describe("merge check detection (R57)", () => {
  it("proposes Node checks from the scripts and the lockfile's package manager", () => {
    const [files, read] = repo({ "package.json": JSON.stringify({ scripts: { typecheck: "tsc", test: "vitest run", build: "vite build" } }), "pnpm-lock.yaml": "" });
    expect(detectChecks(files, read)).toEqual([
      { id: "detected-node", label: "Run the tests (detected)", command: "pnpm install --frozen-lockfile && pnpm typecheck && pnpm test", plain: "Install with pnpm, then run typecheck and test", needs: ["pnpm"] },
    ]);
    const [f2, r2] = repo({ "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "jest" } }), "package-lock.json": "" });
    expect(detectChecks(f2, r2)[0]!.command).toBe("npm ci && npm run lint && npm test");
    // npm's placeholder test script isn't a test.
    const [f3, r3] = repo({ "package.json": JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) });
    expect(detectChecks(f3, r3)).toEqual([]);
    const [f4, r4] = repo({ "package.json": JSON.stringify({ packageManager: "yarn@4.5.0", scripts: { test: "jest" } }) });
    expect(detectChecks(f4, r4)[0]!.command).toBe("yarn install && yarn test");
  });

  it("proposes Python, Go, Rust and make checks", () => {
    expect(detectChecks(...repo({ "pyproject.toml": "", "uv.lock": "" }))[0]!.command).toBe("uv sync && uv run pytest");
    expect(detectChecks(...repo({ "requirements-dev.txt": "pytest" }))[0]!.command).toBe("pip install -r requirements-dev.txt && pytest");
    expect(detectChecks(...repo({ "go.mod": "module x" }))[0]!.command).toBe("go vet ./... && go test ./...");
    expect(detectChecks(...repo({ "Cargo.toml": "" }))[0]!.needs).toEqual(["cargo"]);
    expect(detectChecks(...repo({ Makefile: "build:\n\tgo build\ntest:\n\tgo test ./...\n" })).map((c) => c.command)).toEqual(["make test"]);
    expect(detectChecks(...repo({ Makefile: "build:\n\tgo build\n" }))).toEqual([]);
    expect(detectChecks(...repo({ "README.md": "" }))).toEqual([]);
  });
});
