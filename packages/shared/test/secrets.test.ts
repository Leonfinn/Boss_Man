import { describe, expect, it } from "vitest";
import {
  checkSecretFormat,
  DAEMON_ONLY_SECRET_REFUSAL,
  findCredential,
  isDaemonOnlySecret,
  normaliseSecret,
  secretHint,
  SECRET_KINDS,
} from "../src/secrets.js";

// Secret-shaped inputs are built in pieces where a scanner could mistake the literal for a
// real key (a PEM header line, a Slack token). They are all made up.
const pemHeader = ["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ");
const slackToken = ["xoxb", "1".repeat(12)].join("-");

describe("SECRET_KINDS", () => {
  it("lists every kind the server and the web app offer, in one place", () => {
    expect(SECRET_KINDS).toEqual([
      "claude_oauth_token",
      "anthropic_api_key",
      "anthropic_admin_key",
      "openai_api_key",
      "ssh_private_key",
      "generic",
    ]);
  });
});

describe("normaliseSecret", () => {
  it("strips every whitespace character from a token, however it was pasted", () => {
    expect(normaliseSecret("claude_oauth_token", " sk-ant-oat01-ab\nc d\te ")).toBe("sk-ant-oat01-abcde");
    expect(normaliseSecret("anthropic_api_key", "sk-ant-api\t03\nx")).toBe("sk-ant-api03x");
    expect(normaliseSecret("anthropic_admin_key", "a\u00a0b c")).toBe("abc");
    expect(normaliseSecret("openai_api_key", "  sk-abc  ")).toBe("sk-abc");
  });

  it("normalises an SSH private key to Unix newlines, trimmed, with one trailing newline", () => {
    expect(normaliseSecret("ssh_private_key", `  ${pemHeader}\r\nline\r\n\r\n`)).toBe(`${pemHeader}\nline\n`);
    expect(normaliseSecret("ssh_private_key", "already\n")).toBe("already\n");
    expect(normaliseSecret("ssh_private_key", "no newline")).toBe("no newline\n");
  });

  it("only trims a generic secret, keeping its inner line breaks", () => {
    expect(normaliseSecret("generic", "  a\nb\tc  ")).toBe("a\nb\tc");
    expect(normaliseSecret("generic", "")).toBe("");
  });
});

describe("checkSecretFormat", () => {
  it("rejects an empty value for every kind", () => {
    for (const kind of SECRET_KINDS) {
      const check = checkSecretFormat(kind, "");
      expect(check.ok).toBe(false);
      expect(check.problems[0]).toBe("The value is empty.");
    }
    expect(checkSecretFormat("openai_api_key", "").problems).toHaveLength(1);
    // An empty SSH value fails both checks: it is empty, and it has no PEM header.
    expect(checkSecretFormat("ssh_private_key", "").problems).toEqual([
      "The value is empty.",
      "This doesn't look like a private key (no BEGIN … PRIVATE KEY line).",
    ]);
  });

  it("accepts a value that starts with the kind's expected prefix", () => {
    expect(checkSecretFormat("claude_oauth_token", "sk-ant-oat01-abc").ok).toBe(true);
    expect(checkSecretFormat("anthropic_api_key", "sk-ant-api03-abc").ok).toBe(true);
    expect(checkSecretFormat("anthropic_admin_key", "sk-ant-admin-abc").ok).toBe(true);
    expect(checkSecretFormat("openai_api_key", "sk-abc").ok).toBe(true);
    expect(checkSecretFormat("generic", "anything at all").ok).toBe(true);
  });

  it("names the prefix a token should start with", () => {
    expect(checkSecretFormat("claude_oauth_token", "wrong").problems).toEqual([
      'Expected the value to start with "sk-ant-oat01-".',
    ]);
    expect(checkSecretFormat("anthropic_api_key", "wrong").problems).toEqual([
      'Expected the value to start with "sk-ant-api".',
    ]);
    expect(checkSecretFormat("anthropic_admin_key", "wrong").problems).toEqual([
      'Expected the value to start with "sk-ant-admin".',
    ]);
    expect(checkSecretFormat("openai_api_key", "wrong").problems).toEqual([
      'Expected the value to start with "sk-".',
    ]);
  });

  it("rejects quotes around or inside a token, but not inside a generic secret", () => {
    expect(checkSecretFormat("openai_api_key", "sk-ab'cd").problems).toEqual([
      "The value contains quote characters; paste the token without quotes.",
    ]);
    expect(checkSecretFormat("anthropic_api_key", 'sk-ant-api`x').problems).toEqual([
      "The value contains quote characters; paste the token without quotes.",
    ]);
    expect(checkSecretFormat("generic", "it's fine").ok).toBe(true);
  });

  it("asks for a PEM header in an SSH private key", () => {
    expect(checkSecretFormat("ssh_private_key", "not a key\n").problems).toEqual([
      "This doesn't look like a private key (no BEGIN … PRIVATE KEY line).",
    ]);
    expect(checkSecretFormat("ssh_private_key", `${pemHeader}\nkey\n`).ok).toBe(true);
  });

  it("reports every problem it finds, not just the first", () => {
    const check = checkSecretFormat("openai_api_key", "'nope'");
    expect(check.ok).toBe(false);
    expect(check.problems).toHaveLength(2);
    expect(check.problems[0]).toMatch(/quote/);
    expect(check.problems[1]).toMatch(/start with "sk-"/);
  });
});

describe("secretHint", () => {
  it("shows only the last four characters once a value is longer than eight", () => {
    expect(secretHint("sk-ant-oat01-abcdefgh1234")).toBe("••••1234");
    expect(secretHint("123456789")).toBe("••••6789");
  });

  it("shows no characters for a value of eight or fewer", () => {
    expect(secretHint("12345678")).toBe("••••");
    expect(secretHint("short")).toBe("••••");
    expect(secretHint("")).toBe("••••");
  });
});

describe("isDaemonOnlySecret", () => {
  it("withholds every way git reads a login from the environment", () => {
    for (const name of [
      "GIT_TOKEN",
      "GIT_USERNAME",
      "GIT_PASSWORD",
      "GIT_ASKPASS",
      "GIT_SSH",
      "GIT_SSH_COMMAND",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_PARAMETERS",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_SYSTEM",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_12",
    ]) {
      expect(isDaemonOnlySecret(name)).toBe(true);
    }
  });

  it("withholds the forge and package-manager tokens, including a whole suffixed family", () => {
    for (const name of [
      "GH_TOKEN",
      "GH_PAT",
      "GITHUB_TOKEN",
      "GITHUB_PAT",
      "GITLAB_TOKEN",
      "GL_TOKEN",
      "GITEA_TOKEN",
      "CI_JOB_TOKEN",
      "BITBUCKET_TOKEN",
      "ATLASSIAN_API_TOKEN",
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "YARN_NPM_AUTH_TOKEN",
      "VERCEL_TOKEN",
      "GITHUB_TOKEN_WORK",
      "NPM_TOKEN_LEGACY",
    ]) {
      expect(isDaemonOnlySecret(name)).toBe(true);
    }
  });

  it("leaves an ordinary secret name alone", () => {
    for (const name of [
      "SECRET_TOKEN",
      "github_token",
      "MY_GITHUB_TOKEN",
      "GITHUB_TOKENSHORT",
      "GIT_SSH_KEY",
      "OPENAI_API_KEY",
      "",
    ]) {
      expect(isDaemonOnlySecret(name)).toBe(false);
    }
  });
});

describe("DAEMON_ONLY_SECRET_REFUSAL", () => {
  it("says why a tool server may not hold the git login", () => {
    expect(DAEMON_ONLY_SECRET_REFUSAL).toBe(
      "That is the git login, which agents may never hold. Give the tool server its own token.",
    );
  });
});

describe("findCredential", () => {
  it("names each shape of credential it spots", () => {
    expect(findCredential("token sk-ant-abcdefghij")).toBe("an Anthropic key or token");
    expect(findCredential(`use ${"sk-" + "a".repeat(20)}`)).toBe("an OpenAI key");
    expect(findCredential(`token ghp_${"a".repeat(24)}`)).toBe("a GitHub token");
    expect(findCredential(`token github_pat_${"b".repeat(20)}`)).toBe("a GitHub token");
    expect(findCredential("AKIAIOSFODNN7EXAMPLE")).toBe("an AWS access key");
    expect(findCredential(`token ${slackToken}`)).toBe("a Slack token");
    expect(findCredential(`key\n${pemHeader}\nbody`)).toBe("a private key");
    expect(findCredential("postgres://app:hunter2@db:5432/app")).toBe("a password in a URL");
  });

  it("reports the first shape in its fixed order when a text holds several", () => {
    expect(findCredential(`${slackToken} and ghp_${"a".repeat(24)}`)).toBe("a GitHub token");
    expect(findCredential(`AKIAIOSFODNN7EXAMPLE and ${"sk-" + "a".repeat(20)}`)).toBe("an OpenAI key");
  });

  it("returns null for ordinary text and for a value that only looks close", () => {
    expect(findCredential("Deployed v1.4 (commit 7d2d5cb). Health check: https://app.example/healthz")).toBeNull();
    expect(findCredential("Set APP_TOKEN from the grant named app-deploy; the value is in the store.")).toBeNull();
    expect(findCredential("")).toBeNull();
  });
});
