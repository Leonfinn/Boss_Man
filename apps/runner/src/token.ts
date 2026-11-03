// The runner's own token, kept out of agent sessions (BOS-322).
import { readFileSync } from "node:fs";

/**
 * Reads the runner's token from a file (a Docker secret) or, as a fallback, the environment.
 * `fromEnv` tells the caller that route is unsafe: a token in the environment is in the command that
 * started the runner, and deleting it from `process.env` does not scrub `/proc/<pid>/environ`, which
 * the kernel exposes for the life of the process (BOS-322). The caller refuses to start on it, so the
 * file is the only route that keeps the token out of a session's reach (the fence, BOS-321, keeps
 * /run out of a session's read list and a session needs /proc for its own tools).
 */
export function runnerToken(env: NodeJS.ProcessEnv): { token: string | undefined; fromEnv: boolean } {
  // The plain token is read and cleared first, whatever else is set: when the file also wins, the
  // plain copy is still in /proc, so the caller must still refuse (BOS-394).
  const plain = env.BOSSMAN_RUNNER_TOKEN?.trim();
  delete env.BOSSMAN_RUNNER_TOKEN;
  if (env.BOSSMAN_RUNNER_TOKEN_FILE) return { token: readFileSync(env.BOSSMAN_RUNNER_TOKEN_FILE, "utf8").trim(), fromEnv: plain !== undefined };
  return { token: plain, fromEnv: plain !== undefined };
}

/**
 * The runner's start-up guard: a token from the environment is refused because a session can read it
 * from /proc (BOS-322). That includes a plain token set beside the file: the file would be used, but
 * the plain copy would stay readable, so that is refused too (BOS-394). Returns the token to use, or
 * throws with what to do instead.
 */
export function safeRunnerToken(env: NodeJS.ProcessEnv): string {
  const { token, fromEnv } = runnerToken(env);
  if (fromEnv) throw new Error("BOSSMAN_RUNNER_TOKEN was found in the environment, where a session can read it from /proc. Remove it and set only BOSSMAN_RUNNER_TOKEN_FILE to a file.");
  if (!token) throw new Error("Set BOSSMAN_RUNNER_TOKEN_FILE to the token from POST /api/companies/:id/runner.");
  return token;
}
