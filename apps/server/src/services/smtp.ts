// A small, provider-neutral SMTP submission client (BOS-1387): connect, optionally STARTTLS, AUTH PLAIN or LOGIN,
// one plain-text message. No provider-specific code: the same path serves Proton Mail's SMTP submission
// (STARTTLS on 587), Cloudflare's, or any other server that speaks authenticated SMTP.
import { randomUUID } from "node:crypto";
import net from "node:net";
import os from "node:os";
import tls from "node:tls";

export type SmtpSecurity = "starttls" | "tls" | "none";

export type SmtpConfig = {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string | null;
  password: string | null;
  fromAddress: string;
  fromName: string | null;
  /** Whole-conversation limit. */
  timeoutMs?: number;
  /** Extra options for the TLS handshake (tests give their own CA); certificates are checked by default. */
  tlsOptions?: tls.ConnectionOptions;
};

export type MailMessage = { to: string; subject: string; text: string };

export class SmtpError extends Error {}

type Reply = { code: number; text: string; lines: string[] };

/** Reads the server's replies one at a time, handling multi-line ones ("250-..." then "250 ..."). */
class Wire {
  private buf = "";
  private lines: string[] = [];
  private ready: Reply[] = [];
  private waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private failure: Error | null = null;

  constructor(public sock: net.Socket) {
    this.attach(sock);
  }

  attach(sock: net.Socket) {
    this.sock = sock;
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => {
      this.buf += d;
      this.pump();
    });
    sock.on("error", (e) => this.fail(e));
    sock.on("close", () => this.fail(new SmtpError("The mail server closed the connection.")));
  }

  fail(e: Error) {
    this.failure ??= e;
    this.waiter?.reject(this.failure);
    this.waiter = null;
  }

  private pump() {
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i < 0) break;
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      const m = /^(\d{3})([ -]|$)/.exec(line);
      if (m && m[2] !== "-") {
        const lines = this.lines;
        this.lines = [];
        this.ready.push({ code: Number(m[1]), text: lines.map((l) => l.slice(4)).join("\n"), lines });
      }
    }
    if (this.waiter && this.ready.length) {
      const w = this.waiter;
      this.waiter = null;
      w.resolve(this.ready.shift()!);
    }
  }

  reply(): Promise<Reply> {
    if (this.ready.length) return Promise.resolve(this.ready.shift()!);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject };
    });
  }

  /** True when anything has arrived that hasn't been read as a reply yet (a whole reply, a partial line, or a partly-read multi-line reply). */
  get hasPending(): boolean {
    return this.ready.length > 0 || this.buf !== "" || this.lines.length > 0;
  }

  write(s: string) {
    this.sock.write(s);
  }
}

const NO_CRLF = /[\r\n]/;

/** Header text: plain when it is safe ASCII, otherwise an RFC 2047 encoded word. */
function headerText(s: string): string {
  if (NO_CRLF.test(s)) throw new SmtpError("A header can't contain a line break.");
  return /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;
}

function addressOnly(a: string): string {
  if (NO_CRLF.test(a) || /[<>\s]/.test(a) || !/^[^@]+@[^@]+$/.test(a)) throw new SmtpError(`"${a.slice(0, 80)}" isn't a usable email address.`);
  return a;
}

export function buildMessage(cfg: Pick<SmtpConfig, "fromAddress" | "fromName">, msg: MailMessage, now = new Date()): string {
  const from = cfg.fromName ? `"${headerText(cfg.fromName).replace(/(["\\])/g, "\\$1")}" <${addressOnly(cfg.fromAddress)}>` : addressOnly(cfg.fromAddress);
  const domain = cfg.fromAddress.split("@")[1] ?? "localhost";
  const body = Buffer.from(msg.text.replace(/\r?\n/g, "\r\n"), "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n");
  return [
    `From: ${from}`,
    `To: ${addressOnly(msg.to)}`,
    `Subject: ${headerText(msg.subject)}`,
    `Date: ${now.toUTCString().replace("GMT", "+0000")}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ].join("\r\n");
}

/** Sends one message. Throws SmtpError with the server's own words on a refusal. */
export async function sendMail(cfg: SmtpConfig, msg: MailMessage): Promise<void> {
  const data = buildMessage(cfg, msg);
  const timeoutMs = cfg.timeoutMs ?? 20_000;
  const opts = { host: cfg.host, port: cfg.port, servername: net.isIP(cfg.host) ? undefined : cfg.host, ...cfg.tlsOptions };
  const sock: net.Socket = await new Promise((resolve, reject) => {
    const s = cfg.security === "tls" ? tls.connect(opts, () => resolve(s)) : net.connect({ host: cfg.host, port: cfg.port }, () => resolve(s));
    s.once("error", reject);
  });
  const wire = new Wire(sock);
  const timer = setTimeout(() => {
    wire.fail(new SmtpError(`The mail server didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`));
    wire.sock.destroy();
  }, timeoutMs);
  const expect = async (what: string, ...ok: number[]) => {
    const r = await wire.reply();
    if (!ok.includes(r.code)) throw new SmtpError(`The mail server refused ${what}: ${r.code} ${r.text}`);
    return r;
  };
  const cmd = async (line: string, what: string, ...ok: number[]) => {
    wire.write(`${line}\r\n`);
    return expect(what, ...ok);
  };
  try {
    await expect("the connection", 220);
    const helo = os.hostname().replace(/[^A-Za-z0-9.-]/g, "") || "localhost";
    let ehlo = await cmd(`EHLO ${helo}`, "EHLO", 250);
    if (cfg.security === "starttls") {
      if (!ehlo.lines.some((l) => /^250[ -]STARTTLS$/i.test(l.trim()))) throw new SmtpError("The server doesn't offer STARTTLS on this port. Pick the security the server expects (often TLS on port 465), or none if it really is unencrypted.");
      await cmd("STARTTLS", "STARTTLS", 220);
      // Anything after the 220 in plaintext is a response-injection attempt (CVE-2011-0411), not a reply: the real
      // server wrote nothing more before the handshake, so refuse rather than let it answer EHLO, AUTH or the message.
      if (wire.hasPending) throw new SmtpError("The mail server sent data before the encryption started.");
      wire.sock.removeAllListeners("data"); // the TLS layer reads the raw socket from here
      const upgraded = tls.connect({ ...opts, socket: wire.sock });
      await new Promise<void>((resolve, reject) => {
        upgraded.once("secureConnect", resolve);
        upgraded.once("error", reject);
      });
      wire.attach(upgraded);
      ehlo = await cmd(`EHLO ${helo}`, "EHLO", 250);
    }
    if (cfg.username) {
      const mechs = ehlo.lines.map((l) => /^250[ -]AUTH[ =](.*)$/i.exec(l.trim())?.[1]?.toUpperCase().split(/\s+/)).find(Boolean) ?? [];
      const pw = cfg.password ?? "";
      if (mechs.includes("PLAIN") || !mechs.includes("LOGIN")) {
        const token = Buffer.from(`\0${cfg.username}\0${pw}`, "utf8").toString("base64");
        await cmd(`AUTH PLAIN ${token}`, "the login", 235);
      } else {
        await cmd("AUTH LOGIN", "the login", 334);
        await cmd(Buffer.from(cfg.username).toString("base64"), "the login", 334);
        await cmd(Buffer.from(pw).toString("base64"), "the login", 235);
      }
    }
    await cmd(`MAIL FROM:<${addressOnly(cfg.fromAddress)}>`, "the sender address", 250);
    await cmd(`RCPT TO:<${addressOnly(msg.to)}>`, "the recipient", 250, 251);
    await cmd("DATA", "the message", 354);
    // Dot-stuffing: a line starting with "." gets a second one.
    wire.write(`${data.replace(/^\./gm, "..")}\r\n.\r\n`);
    await expect("the message", 250);
    wire.write("QUIT\r\n");
  } finally {
    clearTimeout(timer);
    wire.sock.destroy();
  }
}
