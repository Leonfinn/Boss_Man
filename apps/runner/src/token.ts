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
/**
 * A check worker's token (BOS-1435), from BOSSMAN_CHECK_WORKER_TOKEN_FILE only, for the same reason as the runner's: a
 * token in the environment stays readable in /proc. A plain BOSSMAN_CHECK_WORKER_TOKEN is cleared and refused.
 */
export function safeWorkerToken(env: NodeJS.ProcessEnv): string {
  const plain = env.BOSSMAN_CHECK_WORKER_TOKEN?.trim();
  delete env.BOSSMAN_CHECK_WORKER_TOKEN;
  if (plain !== undefined) throw new Error("BOSSMAN_CHECK_WORKER_TOKEN was found in the environment, where a check can read it from /proc. Remove it and set only BOSSMAN_CHECK_WORKER_TOKEN_FILE to a file.");
  const file = env.BOSSMAN_CHECK_WORKER_TOKEN_FILE;
  let token = "";
  if (file) {
    try {
      token = readFileSync(file, "utf8").trim();
    } catch (err) {
      // A token file the worker's user (uid 1000) can't read used to end the process with a bare EACCES stack.
      const code = (err as NodeJS.ErrnoException).code;
      throw new Error(`The worker token file ${file} can't be read (${code ?? "error"}). ${code === "EACCES" ? "The file must be readable by user id 1000: use the compose file from Settings → Server and runner → Checks → Add a check worker, which sets this up by itself." : "Check the path in BOSSMAN_CHECK_WORKER_TOKEN_FILE."}`);
    }
  }
  if (!token) throw new Error("Set BOSSMAN_CHECK_WORKER_TOKEN_FILE to a file holding the token from Settings → Server and runner → Checks → Add a check worker.");
  return token;
}

export function safeRunnerToken(env: NodeJS.ProcessEnv): string {
  const { token, fromEnv } = runnerToken(env);
  if (fromEnv) throw new Error("BOSSMAN_RUNNER_TOKEN was found in the environment, where a session can read it from /proc. Remove it and set only BOSSMAN_RUNNER_TOKEN_FILE to a file.");
  if (!token) throw new Error("Set BOSSMAN_RUNNER_TOKEN_FILE to the token from POST /api/companies/:id/runner.");
  return token;
}
