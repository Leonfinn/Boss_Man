// BOS-322: the git credential stays with the daemon; an agent's session never holds it.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SessionManager, withoutGitCredentials } from "../src/session-manager.js";
import { gitAuthEnv, safeGitEnv } from "../src/workspace.js";

const start = { type: "run.start", runId: randomUUID(), agentId: randomUUID(), agentKind: "claude", model: null, fundingSourceId: randomUUID(), cwd: "/tmp", prompt: "x", mcpToken: "bm_x" } as const;

function launchEnv(secrets: Record<string, string>, baseEnv: NodeJS.ProcessEnv = { PATH: "/usr/bin" }) {
  const m = new SessionManager({ mcpUrl: "http://127.0.0.1:1/mcp", baseEnv, resolveEnv: async () => ({}), emit: () => {} });
  return (m as unknown as { launchEnv: (c: typeof start, s: Record<string, string>) => NodeJS.ProcessEnv }).launchEnv(start, secrets);
}

describe("an agent session's environment", () => {
  const secrets = { GIT_TOKEN: "ghp_secret_token", GIT_USERNAME: "bot", PENPOT_TOKEN: "pp-1" };

  it("carries no git credential, in any form git reads it", () => {
    const env = launchEnv(secrets);
    const blob = JSON.stringify(env);
    expect(env.GIT_TOKEN).toBeUndefined();
    expect(env.GIT_USERNAME).toBeUndefined();
    expect(env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(blob).not.toContain("ghp_secret_token");
    expect(blob).not.toContain(Buffer.from("bot:ghp_secret_token").toString("base64"));
  });

  it("still carries the other granted secrets, and a push fails instead of prompting", () => {
    const env = launchEnv(secrets);
    expect(env.PENPOT_TOKEN).toBe("pp-1");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("does not take the runner's own token from the environment it was started with", () => {
    const env = launchEnv({}, { PATH: "/usr/bin", BOSSMAN_RUNNER_TOKEN: "runner-secret", BOSSMAN_RUNNER_TOKEN_FILE: "/run/secrets/runner_token" });
    expect(JSON.stringify(env)).not.toContain("runner-secret");
    expect(env.BOSSMAN_RUNNER_TOKEN_FILE).toBeUndefined();
  });

  it("strips pre-built git auth names if a secret is named like one", () => {
    const out = withoutGitCredentials({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "http.extraHeader", GIT_CONFIG_VALUE_0: "Authorization: x", GIT_ASKPASS: "/x", KEEP: "1" });
    expect(out).toEqual({ KEEP: "1" });
  });

  it("withholds a push or package token granted under a forge's own name (BOS-396)", () => {
    // Each of these is a credential git or a package tool pushes with; a granted secret by that name used to reach the session.
    const named = {
      GITLAB_TOKEN: "glpat-1",
      GL_TOKEN: "glpat-2",
      CI_JOB_TOKEN: "ci-3",
      BITBUCKET_TOKEN: "bb-4",
      ATLASSIAN_API_TOKEN: "atl-5",
      NPM_TOKEN: "npm-6",
      NODE_AUTH_TOKEN: "npm-7",
      YARN_NPM_AUTH_TOKEN: "npm-8",
      VERCEL_TOKEN: "vc-9",
      GITHUB_PAT: "ghp-10",
      GH_PAT: "ghp-11",
      // The prefixed forms: a suffix would say which repo or registry, so the whole family is withheld.
      GITHUB_TOKEN_WORK: "ghp-12",
      GITLAB_TOKEN_WORK: "glpat-13",
      NPM_TOKEN_LEGACY: "npm-14",
      KEEP: "kept",
    };
    const out = withoutGitCredentials(named);
    expect(out).toEqual({ KEEP: "kept" });
  });

  it("withholds those names from an agent session's environment too (BOS-396)", () => {
    const env = launchEnv({ GITLAB_TOKEN: "glpat-session", NPM_TOKEN: "npm-session", BITBUCKET_TOKEN: "bb-session", GL_TOKEN: "gl-session", PENPOT_TOKEN: "pp-2" });
    expect(JSON.stringify(env)).not.toContain("glpat-session");
    expect(JSON.stringify(env)).not.toContain("npm-session");
    expect(JSON.stringify(env)).not.toContain("bb-session");
    expect(JSON.stringify(env)).not.toContain("gl-session");
    expect(env.PENPOT_TOKEN).toBe("pp-2");
  });

  it("keeps credentials that only look like a token name, so an ordinary secret still arrives (BOS-396)", () => {
    const env = launchEnv({ TOKEN_LIMIT: "100", MY_TOKEN: "mine", NPM_REGISTRY: "https://registry.example", GIT_AUTHOR_NAME: "Kit" });
    expect(Object.keys(env).filter((k) => ["TOKEN_LIMIT", "MY_TOKEN", "NPM_REGISTRY", "GIT_AUTHOR_NAME"].includes(k))).toHaveLength(4);
  });

  it("leaves the daemon's own git authentication intact", () => {
    expect(gitAuthEnv(secrets).GIT_CONFIG_VALUE_0).toContain(Buffer.from("bot:ghp_secret_token").toString("base64"));
  });

  it("gives the daemon the auth header and the session none, from the same granted secrets", () => {
    const daemon = safeGitEnv(gitAuthEnv(secrets));
    const headers = Object.values(daemon).filter((v) => v.startsWith("Authorization: Basic "));
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain(Buffer.from("bot:ghp_secret_token").toString("base64"));
    expect(JSON.stringify(launchEnv(secrets))).not.toContain("Authorization: Basic");
  });
});
