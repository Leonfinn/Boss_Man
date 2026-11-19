import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { addonById } from "@boss-man/shared";
import { tmpdir } from "node:os";
import path from "node:path";
import { addonList, canaryAddons, checkAddons, installedAddons } from "../src/addons.js";

describe("runner add-ons (docs/12)", () => {
  it("reads the image's list and reports each add-on's check", async () => {
    expect(installedAddons(undefined)).toEqual([]);
    expect(installedAddons(" agent-browser@0.39.0 , mystery ")).toEqual([{ id: "agent-browser", version: "0.39.0" }, { id: "mystery", version: "" }]);
    const ran: string[] = [];
    const ok = await checkAddons("agent-browser@0.39.0,mystery", async (cmd, args) => void ran.push([cmd, ...args].join(" ")));
    expect(ran).toEqual(["agent-browser --version"]);
    expect(ok).toEqual([
      { id: "agent-browser", version: "0.39.0", ok: true },
      { id: "mystery", version: "", ok: false, detail: "Boss Man doesn't know this add-on." },
    ]);
    const broken = await checkAddons("agent-browser@0.39.0", async () => {
      throw new Error("spawn agent-browser ENOENT");
    });
    expect(broken).toEqual([{ id: "agent-browser", version: "0.39.0", ok: false, detail: "spawn agent-browser ENOENT" }]);
  });

  it("reads the list the image wrote unless BOSSMAN_ADDONS overrides it", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "bm-addons-")), "addons");
    writeFileSync(file, "agent-browser@0.39.0\n");
    expect(installedAddons(addonList({}, file))).toEqual([{ id: "agent-browser", version: "0.39.0" }]);
    expect(addonList({ BOSSMAN_ADDONS: "" }, file)).toBe("");
    expect(addonList({}, path.join(file, "missing"))).toBe("");
  });

  it("canary: each add-on does its real work, and the first failure stops it", async () => {
    const ran: string[] = [];
    expect(await canaryAddons("agent-browser@0.39.0", async (cmd, args) => void ran.push([cmd, ...args].join(" ")))).toEqual({ ok: true, failures: [] });
    expect(ran).toEqual(["agent-browser open about:blank", "agent-browser close"]);
    const broken = await canaryAddons("agent-browser@0.39.0", async () => {
      throw new Error("Chrome exited: no usable sandbox");
    });
    expect(broken).toEqual({ ok: false, failures: ["agent-browser: agent-browser open about:blank failed: Chrome exited: no usable sandbox"] });
    expect(await canaryAddons("", async () => {})).toEqual({ ok: true, failures: [] });
  });

  it("the image pins the same add-on versions as the catalogue", () => {
    const docker = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    expect(docker.match(/^ARG AGENT_BROWSER_VERSION=(.+)$/m)?.[1]).toBe(addonById("agent-browser")!.version);
    expect(docker.match(/^ARG PLAYWRIGHT_VERSION=(.+)$/m)?.[1]).toBe(addonById("webkit")!.version);
    // Off by default: a plain build holds no add-ons.
    expect(docker).toMatch(/^ARG RUNNER_ADDONS=""$/m);
  });

  // BOS-1917: any check worker must be able to run a full merge check, which includes the web render tests (they need the
  // playwright module and a browser with its system libraries). The worker image is the runner image built with
  // WITH_HARNESS=0, so one rule in the Dockerfile and one CI job keep them from drifting. Cheap guard here; the real proof
  // is the CI job that runs the project's own typecheck and tests inside the built worker image.
  it("the worker image always carries the browsers a full check needs, and CI runs the full check inside it", () => {
    const docker = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    // A worker build adds both add-ons itself, whatever RUNNER_ADDONS the worker's compose file passes.
    expect(docker).toMatch(/if \[ "\$WITH_HARNESS" = 0 \]; then RUNNER_ADDONS="\$\{RUNNER_ADDONS\},agent-browser,webkit"; fi/);
    // webkit installs Playwright's browser together with the system libraries it needs.
    expect(docker).toMatch(/playwright install --with-deps webkit/);
    expect(docker).toMatch(/chmod -R a\+rX \/ms-playwright/);
    // The node user (the image's user) can find the playwright module and its browser folder.
    expect(docker).toMatch(/PLAYWRIGHT_BROWSERS_PATH=\/ms-playwright/);
    expect(docker).toMatch(/NODE_PATH=\/usr\/local\/lib\/node_modules/);
    const ci = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const job = ci.slice(ci.indexOf("check-worker-image:"));
    expect(job).toContain("--build-arg WITH_HARNESS=0");
    // A missing browser must fail the tests, not skip them, and the whole suite runs, not a subset.
    expect(job).toContain("BOSSMAN_REQUIRE_BROWSER=1");
    expect(job).toMatch(/pnpm -r --no-bail typecheck/);
    expect(job).toMatch(/pnpm -r --no-bail --reporter-hide-prefix test/);
    expect(job).toContain("playwright --version");
  });
});
