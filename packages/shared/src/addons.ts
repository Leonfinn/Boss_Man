import { z } from "zod";

/**
 * Runner add-ons (docs/12): optional third-party tools baked into the runner image at build,
 * each pinned. Boss Man works without any of them; a skill that needs one is only given to
 * runs whose runner reports it installed and healthy.
 */
export type RunnerAddon = { id: string; title: string; summary: string; npm: string; version: string; licence: string; homepage: string; /** Run on the runner to prove it works; exit 0 means healthy. */ check: string[]; /** Run by the image canary before a build is promoted (docs/12): the add-on doing real work. */ canary: string[][] };

export const RUNNER_ADDONS: RunnerAddon[] = [
  {
    id: "agent-browser",
    title: "Browser (agent-browser)",
    summary: "A headless Chrome agents can drive from the shell: open pages, click, fill forms, take screenshots, read the console.",
    npm: "agent-browser",
    version: "0.39.0",
    licence: "Apache-2.0",
    homepage: "https://github.com/vercel-labs/agent-browser",
    check: ["agent-browser", "--version"],
    canary: [["agent-browser", "open", "about:blank"], ["agent-browser", "close"]],
  },
  {
    id: "webkit",
    title: "WebKit (Playwright)",
    summary:
      "Safari's engine, headless, for Safari-style checks: playwright screenshot -b webkit --device \"iPhone 13\" <url> <file.png>, or a Node script using require(\"playwright\").webkit. Close to Safari but not Safari itself (Linux fonts, no Apple-only behaviour).",
    npm: "playwright",
    version: "1.64.1",
    licence: "Apache-2.0",
    homepage: "https://playwright.dev",
    check: ["playwright", "--version"],
    canary: [["playwright", "screenshot", "-b", "webkit", "about:blank", "/tmp/bossman-webkit-canary.png"]],
  },
];

/** What a runner last said about its add-ons. */
export const AddonReport = z.object({ id: z.string().max(40), version: z.string().max(40), ok: z.boolean(), detail: z.string().max(500).optional() });
export type AddonReport = z.infer<typeof AddonReport>;

export const addonById = (id: string) => RUNNER_ADDONS.find((a) => a.id === id);

/** The add-ons a skill needs that the runner can't provide right now. */
export function missingAddons(requires: string[] | null | undefined, report: AddonReport[] | null | undefined): string[] {
  const ok = new Set((report ?? []).filter((r) => r.ok).map((r) => r.id));
  return (requires ?? []).filter((id) => !ok.has(id));
}
