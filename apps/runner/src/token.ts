// The runner's own token, kept out of agent sessions (BOS-322).
import { readFileSync } from "node:fs";

/**
 * Reads the runner's token from a file (a Docker secret) or the environment.
 * A token from the environment is deleted from this process before it is returned, and `fromEnv`
 * tells the caller to warn: a child session could otherwise read it from /proc, and it stays in
 * the command that started the runner. The file is preferred because the fence (BOS-321) keeps
 * /run out of a session's read list, so a session cannot read the file either.
 */
export function runnerToken(env: NodeJS.ProcessEnv): { token: string | undefined; fromEnv: boolean } {
  if (env.BOSSMAN_RUNNER_TOKEN_FILE) return { token: readFileSync(env.BOSSMAN_RUNNER_TOKEN_FILE, "utf8").trim(), fromEnv: false };
  const token = env.BOSSMAN_RUNNER_TOKEN?.trim();
  delete env.BOSSMAN_RUNNER_TOKEN;
  return { token, fromEnv: token !== undefined };
}
