// Which add-ons are running (DR-023 ticket 1, BOS-521). Derived on the server from what it already
// knows, with no host report and no schema change: ntfy from the notification settings and the last
// phone push, Tailscale from BOSSMAN_TRUSTED_PROXIES and the last request that came through that edge.
// Penpot, and Tailscale's own container and login, stay `unknown` until the host reports them (BOS-419).
// server_status shows these facts, and the card lint (R9) refuses owner steps that rely on an add-on
// that isn't running.
import { desc, isNotNull, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { notifications } from "../db/schema.js";
import type { notificationsService } from "./notifications.js";

export const ADDONS = ["tailscale", "ntfy", "penpot"] as const;
export type Addon = (typeof ADDONS)[number];
export type AddonState = "not_set_up" | "stopped" | "needs_login" | "running" | "unknown";
/** One add-on's state, when it was last seen in it (null when that isn't known) and what the state was read from. */
export type AddonFact = { state: AddonState; since: string | null; source: string; detail?: string };
export type AddonFacts = Record<Addon, AddonFact>;
/** Each add-on's name as the owner reads it. */
export const ADDON_LABELS: Record<Addon, string> = { tailscale: "Tailscale", ntfy: "ntfy", penpot: "Penpot" };

/**
 * A request through the edge counts as Tailscale running for this long. Past it the overlay may have
 * stopped, so the state goes back to unknown (a warning, never a refusal) rather than claim it's up.
 */
export const EDGE_FRESH_MS = 24 * 3_600_000;

/** Node reports IPv4 peers on a dual-stack socket as ::ffff:a.b.c.d. */
const plainIp = (ip: string) => ip.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, "");

/** What we know when nothing could be read: every add-on unknown, so the lint warns and never refuses. */
export function unknownAddons(why: string): AddonFacts {
  return Object.fromEntries(ADDONS.map((a) => [a, { state: "unknown", since: null, source: why }])) as AddonFacts;
}

export function addonsService(db: Db, deps: { trustedProxies: string[]; notifySettings: ReturnType<typeof notificationsService>["getSettings"]; now?: () => Date }) {
  const now = deps.now ?? (() => new Date());
  // Exact addresses only. A CIDR range in BOSSMAN_TRUSTED_PROXIES never matches here, so Tailscale stays
  // unknown (a warning) rather than running; that's the safe side to be wrong on.
  const edges = new Set(deps.trustedProxies.map(plainIp));
  // In memory, per process: after a restart Tailscale reads unknown until the next request through it.
  let lastEdgeAt: Date | null = null;

  return {
    /** Called for every request with the socket's peer address (not X-Forwarded-For, which the client can set). */
    noteRequest(peer: string | undefined) {
      if (peer && edges.has(plainIp(peer))) lastEdgeAt = now();
    },

    async facts(): Promise<AddonFacts> {
      const at = now();
      const tailscale: AddonFact = !edges.size
        ? { state: "not_set_up", since: null, source: "BOSSMAN_TRUSTED_PROXIES is not set, so no Tailscale edge sits in front of Boss Man" }
        : lastEdgeAt && at.getTime() - lastEdgeAt.getTime() < EDGE_FRESH_MS
          ? { state: "running", since: lastEdgeAt.toISOString(), source: "last request through the trusted edge address (BOSSMAN_TRUSTED_PROXIES)" }
          : { state: "unknown", since: lastEdgeAt?.toISOString() ?? null, source: lastEdgeAt ? "no request through the trusted edge address for over a day" : "no request through the trusted edge address since this server started" };

      const s = await deps.notifySettings();
      let ntfy: AddonFact;
      if (!s.ntfy) ntfy = { state: "not_set_up", since: null, source: "The Notifications page has no ntfy server" };
      else {
        const [last] = await db
          .select({ createdAt: notifications.createdAt, pushedAt: notifications.pushedAt, pushError: notifications.pushError })
          .from(notifications)
          .where(or(isNotNull(notifications.pushedAt), isNotNull(notifications.pushError)))
          .orderBy(desc(notifications.createdAt))
          .limit(1);
        ntfy = !last
          ? { state: "unknown", since: null, source: "ntfy is set up but no phone push has been sent yet" }
          : last.pushedAt
            ? { state: "running", since: last.pushedAt.toISOString(), source: "the last phone push went through" }
            : { state: "stopped", since: last.createdAt.toISOString(), source: "the last phone push failed", detail: last.pushError ?? undefined };
      }

      const penpot: AddonFact = { state: "unknown", since: null, source: "Boss Man can't see Penpot until the host reports it (BOS-419)" };
      return { tailscale, ntfy, penpot };
    },
  };
}
