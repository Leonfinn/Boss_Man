// BOS-1687: the plain-text MIME message the SMTP client sends (BOS-1387), pinned without a network.
// The routes files left no pure exported helper to pin, so this uses the fallback the routes lane
// set on BOS-1448: a services file. buildMessage is pure apart from its random Message-ID.
import { describe, expect, it } from "vitest";
import { buildMessage, SmtpError, type MailMessage } from "../src/services/smtp.js";

const NOW = new Date("2026-11-17T12:34:56Z");
const cfg = (over: Partial<{ fromAddress: string; fromName: string | null }> = {}) => ({ fromAddress: "boss@example.com", fromName: null, ...over });
const msg = (over: Partial<MailMessage> = {}): MailMessage => ({ to: "owner@example.org", subject: "Hello", text: "Hi there", ...over });
const build = (c = cfg(), m = msg(), now = NOW) => buildMessage(c, m, now);

/** One header line, e.g. line(s, "From"). */
const line = (s: string, name: string) => s.split("\r\n").find((l) => l.startsWith(`${name}: `))!;
/** The part after the blank line between headers and body. */
const afterHeaders = (s: string) => s.slice(s.indexOf("\r\n\r\n") + 4);
/** The body, base64-decoded, with the 76-character wrapping removed. */
const decodeBody = (s: string) => Buffer.from(afterHeaders(s).replace(/\r\n/g, ""), "base64").toString("utf8");
const encoded = (s: string) => `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

describe("buildMessage: From", () => {
  it("is the bare address when there is no sender name", () => {
    expect(line(build(cfg({ fromName: null })), "From")).toBe("From: boss@example.com");
  });

  it("treats an empty sender name as no name", () => {
    expect(line(build(cfg({ fromName: "" })), "From")).toBe("From: boss@example.com");
  });

  it("quotes a plain sender name", () => {
    expect(line(build(cfg({ fromName: "Boss Man" })), "From")).toBe('From: "Boss Man" <boss@example.com>');
  });

  it("escapes quotes and backslashes in the sender name", () => {
    expect(line(build(cfg({ fromName: 'Boss "B" \\ Co' })), "From")).toBe('From: "Boss \\"B\\" \\\\ Co" <boss@example.com>');
  });

  it("encodes a sender name that is not plain ASCII", () => {
    expect(line(build(cfg({ fromName: "Zoë" })), "From")).toBe(`From: "${encoded("Zoë")}" <boss@example.com>`);
  });

  it("encodes the whole name, quotes included, when it is not plain ASCII", () => {
    const from = line(build(cfg({ fromName: 'Zoë "Z"' })), "From");
    expect(from).toBe(`From: "${encoded('Zoë "Z"')}" <boss@example.com>`);
    expect(from).not.toContain('\\"');
  });

  it("refuses a sender name with a line break", () => {
    expect(() => build(cfg({ fromName: "Boss\nMan" }))).toThrow(SmtpError);
    expect(() => build(cfg({ fromName: "Boss\rMan" }))).toThrow("A header can't contain a line break.");
  });
});

describe("buildMessage: To and the sender address", () => {
  it("writes the recipient address as given", () => {
    expect(line(build(cfg(), msg({ to: "someone@example.net" })), "To")).toBe("To: someone@example.net");
  });

  it.each(["no-at-sign", "has space@example.com", "<owner@example.org>", "owner@example.org\nBcc: x@y.com", "owner@example.org\r"])(
    "refuses the unusable recipient %j",
    (to) => {
      expect(() => build(cfg(), msg({ to }))).toThrow(SmtpError);
      expect(() => build(cfg(), msg({ to }))).toThrow("isn't a usable email address");
    },
  );

  it("refuses an unusable sender address when there is no name", () => {
    expect(() => build(cfg({ fromAddress: "boss at example.com" }))).toThrow("isn't a usable email address");
  });

  it("quotes at most 80 characters of a bad address in the error", () => {
    const bad = `${"a".repeat(100)} b@example.com`;
    expect(() => build(cfg(), msg({ to: bad }))).toThrow(`"${bad.slice(0, 80)}"`);
  });
});

describe("buildMessage: Subject", () => {
  it("writes a plain subject as it is", () => {
    expect(line(build(cfg(), msg({ subject: "A plain subject" })), "Subject")).toBe("Subject: A plain subject");
  });

  it("encodes a subject with non-ASCII text", () => {
    expect(line(build(cfg(), msg({ subject: "Grüße" })), "Subject")).toBe(`Subject: ${encoded("Grüße")}`);
  });

  it("encodes a subject with a tab, which is not plain printable ASCII", () => {
    expect(line(build(cfg(), msg({ subject: "a\tb" })), "Subject")).toBe(`Subject: ${encoded("a\tb")}`);
  });

  it("refuses a subject with a line break", () => {
    expect(() => build(cfg(), msg({ subject: "Hello\nBcc: x@y.com" }))).toThrow("A header can't contain a line break.");
  });
});

describe("buildMessage: Date and Message-ID", () => {
  it("writes the given time in UTC with a +0000 zone", () => {
    expect(line(build(), "Date")).toBe("Date: Tue, 17 Nov 2026 12:34:56 +0000");
  });

  it("keeps the same format on another day", () => {
    expect(line(buildMessage(cfg(), msg(), new Date("2026-01-02T03:04:05Z")), "Date")).toBe("Date: Fri, 02 Jan 2026 03:04:05 +0000");
  });

  it("makes a Message-ID on the sender's own domain", () => {
    expect(line(build(), "Message-ID")).toMatch(/^Message-ID: <[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@example\.com>$/);
  });

  it("takes the domain from a longer sender address", () => {
    expect(line(build(cfg({ fromAddress: "boss@mail.example.co.uk" })), "Message-ID")).toMatch(/@mail\.example\.co\.uk>$/);
  });

  it("gives each message a different Message-ID", () => {
    expect(line(build(), "Message-ID")).not.toBe(line(build(), "Message-ID"));
  });
});

describe("buildMessage: headers and body", () => {
  it("writes the MIME headers in order, then a blank line, then the body", () => {
    const s = build();
    expect(s.split("\r\n\r\n")[0]!.split("\r\n").map((l) => l.split(": ")[0])).toEqual([
      "From",
      "To",
      "Subject",
      "Date",
      "Message-ID",
      "MIME-Version",
      "Content-Type",
      "Content-Transfer-Encoding",
    ]);
    expect(line(s, "MIME-Version")).toBe("MIME-Version: 1.0");
    expect(line(s, "Content-Type")).toBe("Content-Type: text/plain; charset=utf-8");
    expect(line(s, "Content-Transfer-Encoding")).toBe("Content-Transfer-Encoding: base64");
  });

  it("base64-encodes the body", () => {
    expect(afterHeaders(build(cfg(), msg({ text: "Hi there" })))).toBe("SGkgdGhlcmU=");
    expect(decodeBody(build(cfg(), msg({ text: "Hi there" })))).toBe("Hi there");
  });

  it("turns a bare newline into CRLF", () => {
    expect(decodeBody(build(cfg(), msg({ text: "one\ntwo" })))).toBe("one\r\ntwo");
  });

  it("leaves an existing CRLF alone, and handles mixed ones", () => {
    expect(decodeBody(build(cfg(), msg({ text: "one\r\ntwo" })))).toBe("one\r\ntwo");
    expect(decodeBody(build(cfg(), msg({ text: "one\r\ntwo\nthree\r\nfour" })))).toBe("one\r\ntwo\r\nthree\r\nfour");
  });

  it("keeps non-ASCII body text through UTF-8", () => {
    expect(decodeBody(build(cfg(), msg({ text: "café ☕" })))).toBe("café ☕");
  });

  it("writes an empty body for empty text", () => {
    expect(afterHeaders(build(cfg(), msg({ text: "" })))).toBe("");
    expect(decodeBody(build(cfg(), msg({ text: "" })))).toBe("");
  });

  it("wraps the base64 body at 76 characters a line", () => {
    const text = "x".repeat(200);
    const bodyLines = afterHeaders(build(cfg(), msg({ text }))).split("\r\n");
    expect(bodyLines.length).toBeGreaterThan(1);
    for (const l of bodyLines) expect(l.length).toBeLessThanOrEqual(76);
    expect(decodeBody(build(cfg(), msg({ text })))).toBe(text);
  });
});
