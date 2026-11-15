// BOS-1388: the one email the portal sends: "click to confirm". Plain words, plain text, no tracking.
// The link carries the single-use token after the "#", so it never reaches a server log or a Referer header;
// the confirm page passes it to the API in the request body.
import type { MailMessage } from "./services/smtp.js";

/** What the portal needs from outgoing email: whether it is set up, and a plain send. */
export type PortalMailer = { isConfigured(): Promise<boolean>; send(msg: MailMessage): Promise<void> };

export type ConfirmKind = "vote" | "comment" | "idea";

const WHAT: Record<ConfirmKind, string> = { vote: "vote", comment: "comment", idea: "idea" };

/** The link in the email; the portal's own address, as configured (BOSSMAN_PORTAL_URL). */
export function confirmLink(portalUrl: string, token: string) {
  return `${portalUrl.replace(/\/+$/, "")}/confirm.html#${token}`;
}

export function confirmationEmail(opts: { to: string; kind: ConfirmKind; portalTitle: string; about: string; link: string; hours: number }): MailMessage {
  const about = opts.about.replace(/[\r\n]+/g, " ").slice(0, 120);
  const lifetime = opts.hours === 1 ? "1 hour" : opts.hours % 24 === 0 ? `${opts.hours / 24} day${opts.hours === 24 ? "" : "s"}` : `${opts.hours} hours`;
  return {
    to: opts.to,
    subject: `Please confirm your ${WHAT[opts.kind]} on ${opts.portalTitle}`.replace(/[\r\n]+/g, " ").slice(0, 200),
    text: [
      `Hello,`,
      ``,
      `Someone, hopefully you, sent a ${WHAT[opts.kind]} on ${opts.portalTitle.replace(/[\r\n]+/g, " ")}: "${about}".`,
      ``,
      `It only counts once you confirm it. Open this link to do that:`,
      opts.link,
      ``,
      `The link works once and stops working after ${lifetime}. After you confirm, this browser can post without asking again for a while.`,
      ``,
      `If it wasn't you, do nothing. Nothing is shared, and the unconfirmed ${WHAT[opts.kind]} is deleted when the link runs out.`,
    ].join("\n"),
  };
}
