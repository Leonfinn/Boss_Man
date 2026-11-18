import { describe, expect, it } from "vitest";
import { confirmLink, confirmationEmail } from "../src/portal-emails.js";

describe("confirmLink", () => {
  it("puts the token after the # so it never reaches a server log", () => {
    expect(confirmLink("https://portal.example.com", "tok123")).toBe("https://portal.example.com/confirm.html#tok123");
  });
  it("drops trailing slashes from the portal address", () => {
    expect(confirmLink("https://portal.example.com/", "t")).toBe("https://portal.example.com/confirm.html#t");
    expect(confirmLink("https://portal.example.com///", "t")).toBe("https://portal.example.com/confirm.html#t");
  });
  it("keeps a path prefix", () => {
    expect(confirmLink("https://example.com/portal/", "t")).toBe("https://example.com/portal/confirm.html#t");
  });
  it("handles an empty token and an empty address", () => {
    expect(confirmLink("https://example.com", "")).toBe("https://example.com/confirm.html#");
    expect(confirmLink("", "t")).toBe("/confirm.html#t");
  });
});

const base = { to: "a@example.com", kind: "vote" as const, portalTitle: "Our Portal", about: "Dark mode", link: "https://example.com/confirm.html#t", hours: 24 };

describe("confirmationEmail", () => {
  it("addresses the message and names the kind and portal in the subject", () => {
    const m = confirmationEmail(base);
    expect(m.to).toBe("a@example.com");
    expect(m.subject).toBe("Please confirm your vote on Our Portal");
  });
  it.each(["vote", "comment", "idea"] as const)("uses the word %s in subject and body", (kind) => {
    const m = confirmationEmail({ ...base, kind });
    expect(m.subject).toContain(`your ${kind} on`);
    expect(m.text).toContain(`sent a ${kind} on Our Portal: "Dark mode".`);
    expect(m.text).toContain(`the unconfirmed ${kind} is deleted`);
  });
  it("contains the link on its own line", () => {
    expect(confirmationEmail(base).text.split("\n")).toContain(base.link);
  });
  it("describes the lifetime in plain words", () => {
    const life = (hours: number) => /stops working after (.*?)\. After/.exec(confirmationEmail({ ...base, hours }).text)?.[1];
    expect(life(1)).toBe("1 hour");
    expect(life(2)).toBe("2 hours");
    expect(life(24)).toBe("1 day");
    expect(life(48)).toBe("2 days");
    expect(life(36)).toBe("36 hours");
    expect(life(0)).toBe("0 days");
  });
  it("flattens line breaks in the about text and cuts it at 120 characters", () => {
    const m = confirmationEmail({ ...base, about: "line one\r\n\nline two" });
    expect(m.text).toContain('"line one line two"');
    const long = confirmationEmail({ ...base, about: "x".repeat(300) });
    expect(long.text).toContain(`"${"x".repeat(120)}"`);
    expect(long.text).not.toContain("x".repeat(121));
  });
  it("cannot be used to inject headers through the portal title", () => {
    const m = confirmationEmail({ ...base, portalTitle: "Evil\r\nBcc: x@example.com" });
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.subject).toBe("Please confirm your vote on Evil Bcc: x@example.com");
    expect(m.text).toContain("on Evil Bcc: x@example.com:");
  });
  it("cuts the subject at 200 characters", () => {
    expect(confirmationEmail({ ...base, portalTitle: "T".repeat(500) }).subject).toHaveLength(200);
  });
  it("handles empty about text", () => {
    expect(confirmationEmail({ ...base, about: "" }).text).toContain('Our Portal: "".');
  });
});
