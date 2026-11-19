// The git identity the runner gives an agent's session (BOS-255): the agent's name, Boss Man's
// address, and a safe fallback when no name reaches the runner (BOS-1763).
import { describe, expect, it } from "vitest";
import { gitAuthorEnv } from "../src/workspace.js";

const BOSS_MAN = {
  GIT_AUTHOR_NAME: "Boss Man",
  GIT_AUTHOR_EMAIL: "bossman@localhost",
  GIT_COMMITTER_NAME: "Boss Man",
  GIT_COMMITTER_EMAIL: "bossman@localhost",
};

describe("gitAuthorEnv", () => {
  it("uses Boss Man when no name is given", () => {
    expect(gitAuthorEnv()).toEqual(BOSS_MAN);
  });

  it("uses the agent's name for author and committer, and Boss Man's address for both", () => {
    expect(gitAuthorEnv("Ada Lovelace")).toEqual({
      GIT_AUTHOR_NAME: "Ada Lovelace",
      GIT_AUTHOR_EMAIL: "bossman@localhost",
      GIT_COMMITTER_NAME: "Ada Lovelace",
      GIT_COMMITTER_EMAIL: "bossman@localhost",
    });
  });

  it("keeps internal spaces and punctuation in a real display name", () => {
    expect(gitAuthorEnv("Dylan - Background Developer").GIT_AUTHOR_NAME).toBe("Dylan - Background Developer");
  });

  it("trims leading and trailing whitespace before using the name", () => {
    const env = gitAuthorEnv("  Grace Hopper \n");
    expect(env.GIT_AUTHOR_NAME).toBe("Grace Hopper");
    expect(env.GIT_COMMITTER_NAME).toBe("Grace Hopper");
  });

  it.each(["", "   ", "\t\n", " ".repeat(201)])("falls back to Boss Man for a blank name (%j)", (blank) => {
    expect(gitAuthorEnv(blank)).toEqual(BOSS_MAN);
  });

  it("keeps a 200-character name whole", () => {
    const name = "a".repeat(200);
    expect(gitAuthorEnv(name).GIT_AUTHOR_NAME).toBe(name);
  });

  it("cuts a longer name at 200 characters", () => {
    expect(gitAuthorEnv("b".repeat(201)).GIT_AUTHOR_NAME).toBe("b".repeat(200));
    expect(gitAuthorEnv("c".repeat(500)).GIT_AUTHOR_NAME).toHaveLength(200);
  });

  it("trims before cutting, so padding cannot shorten the kept name", () => {
    expect(gitAuthorEnv(`  ${"d".repeat(200)}  `).GIT_AUTHOR_NAME).toBe("d".repeat(200));
  });

  it("uses the same name for author and committer", () => {
    const env = gitAuthorEnv("  Same Name  ");
    expect(env.GIT_AUTHOR_NAME).toBe(env.GIT_COMMITTER_NAME);
  });

  it("only returns the four git identity variables", () => {
    expect(Object.keys(gitAuthorEnv("Kit")).sort()).toEqual([
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_COMMITTER_NAME",
    ]);
  });
});
