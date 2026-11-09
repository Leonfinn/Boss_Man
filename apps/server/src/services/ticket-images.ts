// Images on a ticket (screenshots from testing). The agent names a file it saved where it works; the
// runner sends the bytes straight to the server, so the picture never passes through the model.
import path from "node:path";
import { and, asc, count, eq, like } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runners, ticketImages, tickets } from "../db/schema.js";
import { pictureType } from "./company-import.js";
import type { runnersService } from "./runners.js";

// shortcut: a fixed cap per ticket keeps the database from filling with screenshots; make it a setting if testers hit it.
export const MAX_IMAGES_PER_TICKET = 100;

// What the owner attaches is screenshots and documents; this keeps one upload from filling the database.
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** How an image appears in a description or message: Markdown the pages show, with the id agents pass to open_attachment. */
export const imageMarkdown = (name: string, id: string) => `![${name}](/api/ticket-images/${id})`;
/** How any other file appears: a link that downloads it. */
export const fileMarkdown = (name: string, id: string) => `[📎 ${name}](/api/ticket-images/${id})`;

/**
 * Finds an attachment link in what the owner wrote (an answer in their own words, BOS-759): a picture
 * or a file, whichever image or file link it is. Never global, so a lastIndex from one text can't
 * carry into the next.
 */
export const ATTACHMENT_LINK = /!?\[[^\]]*\]\(\/api\/ticket-images\/[0-9a-fA-F-]{36}\)/;

/** The type of an attached file, from its bytes: a picture, a PDF, UTF-8 text, or anything else. */
export function fileType(bytes: Buffer): string {
  const picture = pictureType(bytes);
  if (picture) return picture;
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  // A zip (BOS-228): its entries are read by attachment-zip.ts, never stored as one big opaque blob.
  if (bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) return "application/zip";
  const sample = bytes.subarray(0, 64 * 1024);
  if (!sample.includes(0) && Buffer.from(sample.toString("utf8"), "utf8").equals(sample)) return "text/plain";
  return "application/octet-stream";
}

export class TicketImageError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export function ticketImagesService(db: Db, deps: { runners: Pick<ReturnType<typeof runnersService>, "request"> }) {
  return {
    /** Attaches the image at `file` in the ticket's working folder; returns its id. */
    async attach(companyId: string, input: { ticketId: string; path: string; caption?: string | null; agentId?: string | null }) {
      const [t] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, input.ticketId), eq(tickets.companyId, companyId)));
      if (!t) throw new TicketImageError("No ticket with that id in your company.");
      const [n] = await db.select({ n: count() }).from(ticketImages).where(eq(ticketImages.ticketId, t.id));
      if (n!.n >= MAX_IMAGES_PER_TICKET) throw new TicketImageError(`This ticket already has ${MAX_IMAGES_PER_TICKET} images.`);
      const [runner] = await db.select({ id: runners.id }).from(runners).where(eq(runners.companyId, companyId));
      if (!runner) throw new TicketImageError("The company has no runner.");
      let got: { base64: string; size: number };
      try {
        got = await deps.runners.request(runner.id, (requestId) => ({ type: "workspace.image", requestId, ticketId: t.id, path: input.path }));
      } catch (err) {
        throw new TicketImageError((err as Error).message);
      }
      const bytes = Buffer.from(got.base64, "base64");
      // The type comes from the bytes, never the name: PNG, JPEG or WebP only.
      const type = pictureType(bytes);
      if (!type) throw new TicketImageError(`${input.path} isn't a PNG, JPEG or WebP image.`);
      const [row] = await db
        .insert(ticketImages)
        .values({ companyId, ticketId: t.id, name: path.posix.basename(input.path.replace(/\\/g, "/")).slice(0, 200), caption: input.caption?.trim().slice(0, 500) || null, type, size: bytes.length, bytes, agentId: input.agentId ?? null })
        .returning({ id: ticketImages.id });
      return row!.id;
    },

    /** A picture or file the owner pasted or picked: on a ticket, or (ticketId null) for a chat or a task not yet made. */
    async upload(companyId: string, input: { ticketId?: string | null; name?: string | null; base64: string }) {
      if (input.ticketId) {
        const [t] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, input.ticketId), eq(tickets.companyId, companyId)));
        if (!t) throw new TicketImageError("No ticket with that id in this company.");
        const [n] = await db.select({ n: count() }).from(ticketImages).where(eq(ticketImages.ticketId, t.id));
        if (n!.n >= MAX_IMAGES_PER_TICKET) throw new TicketImageError(`This ticket already has ${MAX_IMAGES_PER_TICKET} images.`);
      }
      const bytes = Buffer.from(input.base64, "base64");
      if (!bytes.length) throw new TicketImageError("The file is empty.");
      if (bytes.length > MAX_UPLOAD_BYTES) throw new TicketImageError(`The file must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or smaller.`);
      const type = fileType(bytes);
      const image = type.startsWith("image/");
      const name = (input.name?.trim() || (image ? `pasted.${type.split("/")[1]}` : "file")).replace(/[\]\[()\n\r]/g, "").slice(0, 120);
      const [row] = await db.insert(ticketImages).values({ companyId, ticketId: input.ticketId ?? null, name, type, size: bytes.length, bytes }).returning({ id: ticketImages.id });
      return { id: row!.id, name, markdown: image ? imageMarkdown(name, row!.id) : fileMarkdown(name, row!.id) };
    },

    /** An attachment of this company, for an agent's open_attachment. */
    async forCompany(id: string, companyId: string) {
      const [row] = await db.select({ bytes: ticketImages.bytes, type: ticketImages.type, name: ticketImages.name, caption: ticketImages.caption }).from(ticketImages).where(and(eq(ticketImages.id, id), eq(ticketImages.companyId, companyId)));
      return row ?? null;
    },

    list(ticketId: string) {
      return db
        .select({ id: ticketImages.id, name: ticketImages.name, caption: ticketImages.caption, size: ticketImages.size, agentId: ticketImages.agentId, createdAt: ticketImages.createdAt })
        .from(ticketImages)
        // Only pictures: other files show as links where they were attached.
        .where(and(eq(ticketImages.ticketId, ticketId), like(ticketImages.type, "image/%")))
        .orderBy(asc(ticketImages.createdAt));
    },

    async get(id: string) {
      const [row] = await db.select({ bytes: ticketImages.bytes, type: ticketImages.type, name: ticketImages.name }).from(ticketImages).where(eq(ticketImages.id, id));
      return row ?? null;
    },
  };
}
