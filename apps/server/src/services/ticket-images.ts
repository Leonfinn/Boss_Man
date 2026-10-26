// Images on a ticket (screenshots from testing). The agent names a file it saved where it works; the
// runner sends the bytes straight to the server, so the picture never passes through the model.
import path from "node:path";
import { and, asc, count, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runners, ticketImages, tickets } from "../db/schema.js";
import { pictureType } from "./company-import.js";
import type { runnersService } from "./runners.js";

// shortcut: a fixed cap per ticket keeps the database from filling with screenshots; make it a setting if testers hit it.
export const MAX_IMAGES_PER_TICKET = 100;

// The owner's pictures are screenshots; this keeps one paste from filling the database.
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** How an image appears in a description or message: Markdown the pages show, with the id agents pass to view_image. */
export const imageMarkdown = (name: string, id: string) => `![${name}](/api/ticket-images/${id})`;

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

    /** An image the owner pasted or picked: on a ticket, or (ticketId null) for a chat or a task not yet made. Returns its id. */
    async upload(companyId: string, input: { ticketId?: string | null; name?: string | null; base64: string }) {
      if (input.ticketId) {
        const [t] = await db.select({ id: tickets.id }).from(tickets).where(and(eq(tickets.id, input.ticketId), eq(tickets.companyId, companyId)));
        if (!t) throw new TicketImageError("No ticket with that id in this company.");
        const [n] = await db.select({ n: count() }).from(ticketImages).where(eq(ticketImages.ticketId, t.id));
        if (n!.n >= MAX_IMAGES_PER_TICKET) throw new TicketImageError(`This ticket already has ${MAX_IMAGES_PER_TICKET} images.`);
      }
      const bytes = Buffer.from(input.base64, "base64");
      if (!bytes.length) throw new TicketImageError("The image is empty.");
      if (bytes.length > MAX_UPLOAD_BYTES) throw new TicketImageError(`The image must be ${MAX_UPLOAD_BYTES / 1024 / 1024} MB or smaller.`);
      const type = pictureType(bytes);
      if (!type) throw new TicketImageError("The image must be a PNG, JPEG or WebP.");
      const name = (input.name?.trim() || `pasted.${type.split("/")[1]}`).replace(/[\]\[()\n\r]/g, "").slice(0, 120);
      const [row] = await db.insert(ticketImages).values({ companyId, ticketId: input.ticketId ?? null, name, type, size: bytes.length, bytes }).returning({ id: ticketImages.id });
      return { id: row!.id, name, markdown: imageMarkdown(name, row!.id) };
    },

    /** An image of this company, for an agent's view_image. */
    async forCompany(id: string, companyId: string) {
      const [row] = await db.select({ bytes: ticketImages.bytes, type: ticketImages.type, name: ticketImages.name, caption: ticketImages.caption }).from(ticketImages).where(and(eq(ticketImages.id, id), eq(ticketImages.companyId, companyId)));
      return row ?? null;
    },

    list(ticketId: string) {
      return db
        .select({ id: ticketImages.id, name: ticketImages.name, caption: ticketImages.caption, size: ticketImages.size, agentId: ticketImages.agentId, createdAt: ticketImages.createdAt })
        .from(ticketImages)
        .where(eq(ticketImages.ticketId, ticketId))
        .orderBy(asc(ticketImages.createdAt));
    },

    async get(id: string) {
      const [row] = await db.select({ bytes: ticketImages.bytes, type: ticketImages.type }).from(ticketImages).where(eq(ticketImages.id, id));
      return row ?? null;
    },
  };
}
