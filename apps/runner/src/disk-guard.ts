// Free-disk guard (BOS-2182). The runner measures free space on its workspace volume. Below the warning level
// it reports more often (the server warns the owner); below the hard floor it holds new runs and checks, and lets
// them go on their own once space is back. Work already running is never killed.
import { statfsSync } from "node:fs";

const GB = 1024 ** 3;
const MB = 1024 ** 2;

export type DiskLevels = {
  /** Warn when free space is under this share of the volume (0..1) or under warnBytes, whichever is larger. */
  warnPercent: number;
  warnBytes: number;
  /** New runs and checks are held below this many free bytes. 0 turns the hold off. */
  floorBytes: number;
};

export const DEFAULT_DISK_LEVELS: DiskLevels = { warnPercent: 0.1, warnBytes: 5 * GB, floorBytes: 1 * GB };

const num = (v: string | undefined) => {
  if (v === undefined || v.trim() === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

/**
 * BOSSMAN_DISK_WARN_PERCENT (default 10), BOSSMAN_DISK_WARN_GB (default 5), BOSSMAN_DISK_FLOOR_MB (default 1024, 0 = never hold).
 * A value that isn't a non-negative number falls back to its default.
 */
export function levelsFromEnv(env: NodeJS.ProcessEnv): DiskLevels {
  const pct = num(env.BOSSMAN_DISK_WARN_PERCENT);
  const warnGb = num(env.BOSSMAN_DISK_WARN_GB);
  const floorMb = num(env.BOSSMAN_DISK_FLOOR_MB);
  return {
    warnPercent: pct !== undefined && pct <= 100 ? pct / 100 : DEFAULT_DISK_LEVELS.warnPercent,
    warnBytes: warnGb !== undefined ? warnGb * GB : DEFAULT_DISK_LEVELS.warnBytes,
    floorBytes: floorMb !== undefined ? floorMb * MB : DEFAULT_DISK_LEVELS.floorBytes,
  };
}

export type DiskSpace = { freeBytes: number; totalBytes: number };
export type DiskState = "ok" | "low" | "full";

export const measureDisk = (dir: string): DiskSpace => {
  const s = statfsSync(dir);
  return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
};

export function classify(space: DiskSpace, levels: DiskLevels): DiskState {
  if (levels.floorBytes > 0 && space.freeBytes < levels.floorBytes) return "full";
  const warnAt = Math.max(space.totalBytes * levels.warnPercent, levels.warnBytes);
  return space.freeBytes < warnAt ? "low" : "ok";
}

export const holdReason = (freeBytes: number) =>
  `Runner disk almost full: ${Math.floor(freeBytes / MB)} MB free; free space and it restarts on its own.`;

export class DiskGuard {
  private last: DiskSpace | null = null;
  constructor(
    private readonly dir: string,
    private readonly levels: DiskLevels = DEFAULT_DISK_LEVELS,
    private readonly measure: (dir: string) => DiskSpace = measureDisk,
    /** How often a held start looks again. */
    private readonly pollMs = 15_000,
  ) {}

  /** A fresh reading; a failed read keeps the last one (and never holds work on a guess). */
  read(): DiskSpace | null {
    try {
      this.last = this.measure(this.dir);
    } catch {
      /* keep the last reading */
    }
    return this.last;
  }

  state(): DiskState {
    const s = this.read();
    return s ? classify(s, this.levels) : "ok";
  }

  /** The plain reason when new work must wait, otherwise null. */
  hold(): string | null {
    const s = this.read();
    return s && classify(s, this.levels) === "full" ? holdReason(s.freeBytes) : null;
  }

  /**
   * Resolves once there is room (at once when there is). onHold gets the reason on the first refusal and again every
   * logEveryMs; cancelled() ends the wait early.
   */
  async waitForRoom(opts: { onHold: (reason: string) => void; cancelled?: () => boolean; pollMs?: number; logEveryMs?: number }): Promise<boolean> {
    const pollMs = opts.pollMs ?? this.pollMs;
    const logEveryMs = opts.logEveryMs ?? 5 * 60_000;
    let lastLogged = -Infinity;
    for (;;) {
      const reason = this.hold();
      if (!reason) return true;
      if (opts.cancelled?.()) return false;
      if (Date.now() - lastLogged >= logEveryMs) {
        lastLogged = Date.now();
        opts.onHold(reason);
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}
