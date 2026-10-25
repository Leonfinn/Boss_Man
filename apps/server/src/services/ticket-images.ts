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
