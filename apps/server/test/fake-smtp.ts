// A local fake SMTP server for the outgoing-email tests (BOS-1387): no real account, no network beyond loopback.
// It speaks enough ESMTP for a submission client: EHLO, STARTTLS, AUTH PLAIN/LOGIN, MAIL, RCPT, DATA, QUIT.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

/** A throwaway self-signed certificate for localhost, made with the openssl CLI so no key is committed. */
export function makeTestCert(): { key: string; cert: string } {
  const dir = mkdtempSync(join(tmpdir(), "fake-smtp-"));
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-days", "2", "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1"], { stdio: "pipe" });
    return { key: readFileSync(join(dir, "k.pem"), "utf8"), cert: readFileSync(join(dir, "c.pem"), "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export type FakeSmtpOptions = {
  /** Offer STARTTLS (needs cert). */
  starttls?: boolean;
  /** Speak TLS from the first byte (port 465 style). */
  implicitTls?: boolean;
  cert?: { key: string; cert: string };
  /** When set, AUTH is offered and only these credentials pass. */
  auth?: { user: string; pass: string };
  /** Refuse RCPT with this reply line, e.g. "550 5.1.1 no such mailbox". */
  rejectRcpt?: string;
  /** Refuse the login with this reply, echoing whatever it was given (to prove the client hides secrets). */
  authFailReply?: (given: string) => string;
};

export type Received = { from: string; to: string[]; data: string; authed: string | null; encrypted: boolean };

export async function startFakeSmtp(opts: FakeSmtpOptions = {}) {
  const received: Received[] = [];
  const handle = (sock: net.Socket) => {
    let s: net.Socket = sock;
    let encrypted = !!opts.implicitTls;
    let buf = "";
    let inData = false;
    let data = "";
    let from = "";
    let to: string[] = [];
    let authed: string | null = null;
    let loginStep: null | "user" | "pass" = null;
    let loginUser = "";
    const say = (l: string) => s.write(`${l}\r\n`);
    const line = (l: string) => {
      if (inData) {
        if (l === ".") {
          inData = false;
          received.push({ from, to, data, authed, encrypted });
          data = "";
          to = [];
          return say("250 2.0.0 queued");
        }
        data += `${l.startsWith("..") ? l.slice(1) : l}\r\n`;
        return;
      }
      if (loginStep === "user") {
        loginUser = Buffer.from(l, "base64").toString();
        loginStep = "pass";
        return say("334 UGFzc3dvcmQ6");
      }
      if (loginStep === "pass") {
        loginStep = null;
        return checkAuth(loginUser, Buffer.from(l, "base64").toString());
      }
      const [verb = "", ...rest] = l.split(" ");
      switch (verb.toUpperCase()) {
        case "EHLO":
          say("250-fake.example.com");
          if (opts.starttls && !encrypted) say("250-STARTTLS");
          if (opts.auth && (encrypted || !opts.starttls)) say("250-AUTH PLAIN LOGIN");
          return say("250 8BITMIME");
        case "STARTTLS": {
          say("220 2.0.0 go ahead");
          sock.removeAllListeners("data");
          const secure = new tls.TLSSocket(s, { isServer: true, key: opts.cert!.key, cert: opts.cert!.cert });
          secure.on("data", (d) => feed(d.toString()));
          secure.on("error", () => undefined);
          s = secure;
          encrypted = true;
          return;
        }
        case "AUTH": {
          if (opts.auth && opts.starttls && !encrypted) return say("530 5.7.0 Must issue a STARTTLS command first");
          if (rest[0]?.toUpperCase() === "PLAIN") {
            const [, user = "", pass = ""] = Buffer.from(rest[1] ?? "", "base64").toString().split("\0");
            return checkAuth(user, pass, rest[1]);
          }
          loginStep = "user";
          return say("334 VXNlcm5hbWU6");
        }
        case "MAIL":
          if (opts.auth && !authed) return say("530 5.7.0 Authentication required");
          from = /<(.*)>/.exec(l)?.[1] ?? "";
          return say("250 2.1.0 ok");
        case "RCPT":
          if (opts.rejectRcpt) return say(opts.rejectRcpt);
          to.push(/<(.*)>/.exec(l)?.[1] ?? "");
          return say("250 2.1.5 ok");
        case "DATA":
          inData = true;
          return say("354 end with <CRLF>.<CRLF>");
        case "QUIT":
          say("221 bye");
          return s.end();
        default:
          return say("502 5.5.2 command not recognised");
      }
    };
    const checkAuth = (user: string, pass: string, raw?: string) => {
      if (opts.auth && user === opts.auth.user && pass === opts.auth.pass) {
        authed = user;
        return say("235 2.7.0 authenticated");
      }
      return say(opts.authFailReply ? opts.authFailReply(raw ?? pass) : "535 5.7.8 authentication failed");
    };
    const feed = (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const l = buf.slice(0, i);
        buf = buf.slice(i + 2);
        line(l);
      }
    };
    if (opts.implicitTls) {
      const secure = new tls.TLSSocket(sock, { isServer: true, key: opts.cert!.key, cert: opts.cert!.cert });
      secure.on("data", (d) => feed(d.toString()));
      secure.on("error", () => undefined);
      s = secure;
    } else sock.on("data", (d) => feed(d.toString()));
    sock.on("error", () => undefined);
    say("220 fake.example.com ESMTP ready");
  };
  const open = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    open.add(sock);
    sock.on("close", () => open.delete(sock));
    handle(sock);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { port, received, close: () => new Promise<void>((r) => (server.close(() => r()), open.forEach((s) => s.destroy()))) };
}
