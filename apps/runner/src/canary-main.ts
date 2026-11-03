// `tsx src/canary-main.ts`: exits 0 when the image can run a session of each agent kind (R52),
// fenced wherever the host can fence agents (BOS-321), and every add-on it holds works (docs/12).
import { addonList, canaryAddons } from "./addons.js";
import { runCanary, type CanaryKind } from "./canary.js";
import { sandboxSelfTest } from "./fence.js";

const sandbox = sandboxSelfTest();
// One at a time, so a failure is the kind's own and not two sessions crowding each other.
const sessions: Partial<Record<CanaryKind, Awaited<ReturnType<typeof runCanary>>>> = {};
for (const kind of ["claude", "codex", "opencode"] as const) sessions[kind] = await runCanary({ agentKind: kind, fence: sandbox.level });
const addons = await canaryAddons(addonList());
const ok = Object.values(sessions).every((r) => r.ok) && addons.ok;
console.log(JSON.stringify({ ok, sandbox, sessions, addons }));
process.exit(ok ? 0 : 1);
