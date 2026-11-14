// `tsx src/canary-main.ts`: exits 0 when the image can run a session of each agent kind it holds (R52),
// fenced wherever the host can fence agents (BOS-321), and every add-on it holds works (docs/12).
// The image holds no Claude code (DR-050): a Claude session needs the ready Claude pack, which CI's
// --network none run doesn't have, so Claude is skipped here and proven by the pack installer instead
// (src/claude-pack-main.ts), which runs the same Claude canary once it has installed the pack.
import { existsSync } from "node:fs";
import { addonList, canaryAddons } from "./addons.js";
import { runCanary, type CanaryKind } from "./canary.js";
import { sandboxSelfTest } from "./fence.js";

const sandbox = sandboxSelfTest();
// Claude is present only when an executable is pointed at (the pack installer sets CLAUDE_CODE_EXECUTABLE).
const claudeBin = process.env.CLAUDE_CODE_EXECUTABLE;
const claudePresent = !!claudeBin && existsSync(claudeBin);
const kinds: CanaryKind[] = [...(claudePresent ? (["claude"] as const) : []), "codex", "opencode"];
const skipped: CanaryKind[] = claudePresent ? [] : ["claude"];
// One at a time, so a failure is the kind's own and not two sessions crowding each other.
const sessions: Partial<Record<CanaryKind, Awaited<ReturnType<typeof runCanary>>>> = {};
for (const kind of kinds) sessions[kind] = await runCanary({ agentKind: kind, fence: sandbox.level });
const addons = await canaryAddons(addonList());
const ok = Object.values(sessions).every((r) => r.ok) && addons.ok;
const note = claudePresent ? undefined : "no Claude executable (DR-050: the pack installs it)";
console.log(JSON.stringify({ ok, sandbox, sessions, skipped, ...(note ? { claudeSkippedBecause: note } : {}), addons }));
process.exit(ok ? 0 : 1);
