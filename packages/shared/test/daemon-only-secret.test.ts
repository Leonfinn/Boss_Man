// The secrets only the runner daemon may hold (BOS-322, BOS-396), shared since BOS-373 so a tool server can't name one.
import { describe, expect, it } from "vitest";
import { isDaemonOnlySecret } from "../src/secrets.js";

describe("isDaemonOnlySecret", () => {
  it("matches git's own credential names and the config variables that build a header", () => {
    for (const n of ["GIT_TOKEN", "GIT_USERNAME", "GIT_PASSWORD", "GIT_ASKPASS", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_12"]) {
      expect(isDaemonOnlySecret(n), n).toBe(true);
    }
  });

  it("matches the forge and package token families, with or without a suffix", () => {
    for (const n of ["GH_TOKEN", "GH_PAT", "GITHUB_TOKEN", "GITHUB_PAT", "GITLAB_TOKEN", "GL_TOKEN", "GITEA_TOKEN", "CI_JOB_TOKEN", "BITBUCKET_TOKEN", "ATLASSIAN_API_TOKEN", "NPM_TOKEN", "NODE_AUTH_TOKEN", "YARN_NPM_AUTH_TOKEN", "VERCEL_TOKEN", "GITHUB_TOKEN_WORK", "NPM_TOKEN_LEGACY"]) {
      expect(isDaemonOnlySecret(n), n).toBe(true);
    }
  });

  it("leaves ordinary secrets alone, even ones that contain a token name", () => {
    for (const n of ["MY_GIT_TOKEN_NOTE", "SCRAPLING_MCP_TOKEN", "TOKEN_LIMIT", "MY_TOKEN", "NPM_REGISTRY", "GIT_AUTHOR_NAME", "PENPOT_TOKEN", "GIT_CONFIG_KEY_X"]) {
      expect(isDaemonOnlySecret(n), n).toBe(false);
    }
  });
});
