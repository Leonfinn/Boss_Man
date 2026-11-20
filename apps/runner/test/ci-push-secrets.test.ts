// BOS-2125: the gate's bossman-ci/* pushes use GIT_CI_TOKEN when the company has one, so GitHub's failure emails go to that account.
import { describe, expect, it } from "vitest";
import { ciPushSecrets, gitAuthEnv } from "../src/workspace.js";

const basic = (env: Record<string, string>) => Buffer.from((env.GIT_CONFIG_VALUE_0 ?? "").replace("Authorization: Basic ", ""), "base64").toString();

describe("ciPushSecrets", () => {
  it("keeps GIT_TOKEN when the company has no GIT_CI_TOKEN", () => {
    const env = gitAuthEnv(ciPushSecrets({ GIT_TOKEN: "main-token" }));
    expect(basic(env)).toBe("x-access-token:main-token");
  });

  it("logs in with GIT_CI_TOKEN, and its own username, when set", () => {
    const env = gitAuthEnv(ciPushSecrets({ GIT_TOKEN: "main-token", GIT_USERNAME: "owner", GIT_CI_TOKEN: "bot-token", GIT_CI_USERNAME: "gate-bot" }));
    expect(basic(env)).toBe("gate-bot:bot-token");
  });

  it("does not borrow GIT_USERNAME for the bot token", () => {
    const env = gitAuthEnv(ciPushSecrets({ GIT_TOKEN: "main-token", GIT_USERNAME: "owner", GIT_CI_TOKEN: "bot-token" }));
    expect(basic(env)).toBe("x-access-token:bot-token");
  });
});
