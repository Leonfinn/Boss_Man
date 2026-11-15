// BOS-1550: the compose file the owner pastes on the worker's machine, filled in with what Boss Man knows (its address,
// the commit its runner is built from, the worker's slots and the token). The template is a byte-for-byte copy of
// deploy/check-worker/compose.yaml (the web build has no deploy/ folder); test/check-worker-compose.test.ts keeps them equal.
import template from "./check-worker-compose.yaml?raw";

const ZEROS = "0".repeat(40);
const SERVER_PLACEHOLDER = "wss://boss.example.com/api/check-worker/connect";
const TOKEN_PLACEHOLDER = "PASTE-THE-WORKER-TOKEN-HERE";

/** The worker socket address for the page the owner is on (https://x -> wss://x/api/check-worker/connect). */
export const workerSocketUrl = (origin: string) => `${origin.replace(/^http/, "ws").replace(/\/+$/, "")}/api/check-worker/connect`;

/**
 * The template with each CHANGE THIS value replaced. `commit` is null when no runner has reported one yet: the
 * placeholder then stays, and the owner is told to fill it in. JSON.stringify quotes the strings the way YAML wants.
 */
export function workerComposeFile(v: { url: string; commit: string | null; slots: number; token: string }): string {
  let out = template.split(SERVER_PLACEHOLDER).join(v.url);
  if (v.commit && /^[0-9a-f]{40}$/i.test(v.commit)) out = out.split(ZEROS).join(v.commit.toLowerCase());
  out = out.replace(/BOSSMAN_CHECK_SLOTS: "\d+"/, `BOSSMAN_CHECK_SLOTS: "${Math.max(1, Math.floor(v.slots))}"`);
  return out.split(`content: "${TOKEN_PLACEHOLDER}"`).join(`content: ${JSON.stringify(v.token)}`);
}
