// Blue/green at a glance (DR-020 E): each colour's own /api/health over the compose network, or down
// when it doesn't answer. Shared by the owner's GET /api/bluegreen and the CEO's server_status, so
// both read the stack the same way.

export type ColourProbe = { colour: string; up: boolean; role: string | null; commit: string | null; startedAt: string | null };
export type BlueGreen = { enabled: false } | { enabled: true; self: string; colours: Array<ColourProbe & Record<string, unknown>> };

/** `self` is this process's colour (null on a single server); `own` is this process's /api/health body. */
export async function probeColours(self: string | null, own: () => { role: string; commit: string; startedAt: string } & Record<string, unknown>): Promise<BlueGreen> {
  if (!self) return { enabled: false };
  const peek = async (c: string) => {
    if (c === self) return { ...own(), colour: c, up: true };
    try {
      const r = await fetch(`http://server-${c}:3100/api/health`, { signal: AbortSignal.timeout(2000) });
      const h = (await r.json()) as { role?: string; commit?: string; startedAt?: string };
      return { colour: c, up: r.ok, role: h.role ?? null, commit: h.commit ?? null, startedAt: h.startedAt ?? null };
    } catch {
      return { colour: c, up: false, role: null, commit: null, startedAt: null };
    }
  };
  return { enabled: true, self, colours: await Promise.all(["blue", "green"].map(peek)) };
}
