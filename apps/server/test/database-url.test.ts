import { describe, expect, it } from "vitest";
import { databaseUrl } from "../src/database-url.js";

describe("databaseUrl (BOS-974)", () => {
  it("leaves the address alone when no password file is set", () => {
    expect(databaseUrl({ DATABASE_URL: "postgres://bossman:pw@db:5432/bossman" })).toBe("postgres://bossman:pw@db:5432/bossman");
    expect(databaseUrl({})).toBeUndefined();
  });
  it("puts the file's password in, trimmed", () => {
    expect(databaseUrl({ DATABASE_URL: "postgres://bossman@db:5432/bossman", BOSSMAN_DATABASE_PASSWORD_FILE: "/x" }, () => "abc123\n")).toBe("postgres://bossman:abc123@db:5432/bossman");
  });
  it("keeps a password that is already in the address", () => {
    expect(databaseUrl({ DATABASE_URL: "postgres://bossman:pw@db/bossman", BOSSMAN_DATABASE_PASSWORD_FILE: "/x" }, () => "other")).toBe("postgres://bossman:pw@db/bossman");
  });
  it("refuses an empty file", () => {
    expect(() => databaseUrl({ DATABASE_URL: "postgres://bossman@db/bossman", BOSSMAN_DATABASE_PASSWORD_FILE: "/x" }, () => " \n")).toThrow(/empty/);
  });
});
