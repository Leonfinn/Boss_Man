import type { ReactNode } from "react";
import { api } from "../../api";
import { usePoll } from "../../hooks";
import { useAction } from "./shared";

export type ReleaseWatchView =
  | { active: false }
  | { active: true; current: string; channel: "beta" | "stable"; enabled: boolean; ntfy: boolean; checkedAt: string | null; couldntCheck: boolean; available: { version: string; url: string; summary: string; publishedAt: string | null; prerelease: boolean } | null };

/**
 * BOS-2663: a new release of an install from the published images, found by the server's daily check. Shows nothing on a source
 * install. The line names the version, says in plain words what is in it, and links the release notes; the two switches turn the
 * daily check off, and the phone push on.
 */
export function ReleaseNotice() {
  const w = usePoll((signal) => api<ReleaseWatchView>("/api/release-watch", { signal }), 60_000, "release-watch");
  const act = useAction();
  const v = w.data;
  if (!v || !v.active) return null;
  const set = (patch: { enabled?: boolean; ntfy?: boolean }) =>
    act.run(async () => {
      await api("/api/release-watch", { method: "PUT", body: patch });
      w.reload();
    });
  return <ReleaseNoticeBody v={v} busy={act.busy} set={set} extra={act.view} />;
}

/** The release line and its two switches, apart from the polling so a browser test can render it with fixed data. */
export function ReleaseNoticeBody({ v, busy, set, extra }: { v: Extract<ReleaseWatchView, { active: true }>; busy: boolean; set: (patch: { enabled?: boolean; ntfy?: boolean }) => void; extra?: ReactNode }) {
  const act = { busy, view: extra };
  return (
    <div data-testid="release-notice" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {v.available ? (
        <p role="status" style={{ fontSize: 14 }}>
          <strong>Boss Man {v.available.version} is available</strong> (you run {v.current}).{v.available.summary ? ` ${v.available.summary}` : ""}{" "}
          <a href={v.available.url} target="_blank" rel="noreferrer">Release notes</a>
        </p>
      ) : (
        <p className="muted" style={{ fontSize: 14 }}>
          {!v.enabled ? `Checking for new releases is off. You run ${v.current}.` : v.couldntCheck ? `Couldn't check for a new release just now (you run ${v.current}). It will try again within the hour.` : `You run ${v.current}, the newest ${v.channel === "beta" ? "beta " : ""}release.`}
        </p>
      )}
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
        <input type="checkbox" checked={v.enabled} disabled={act.busy} onChange={(e) => set({ enabled: e.target.checked })} />
        Tell me about new releases
      </label>
      {v.enabled && (
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
          <input type="checkbox" checked={v.ntfy} disabled={act.busy} onChange={(e) => set({ ntfy: e.target.checked })} />
          Also send it to my phone
        </label>
      )}
      {act.view}
    </div>
  );
}
