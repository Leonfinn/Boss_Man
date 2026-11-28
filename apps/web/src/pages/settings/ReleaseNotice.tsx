import type { ReactNode } from "react";
import { api } from "../../api";
import { usePoll } from "../../hooks";
import { useAction } from "./shared";

export type UpdaterProgress = { stage: string; version: string | null; error: { code: string; message: string } | null; report: { level: "info" | "problem"; text: string; acknowledged: boolean } | null };

export type ReleaseWatchView =
  | { active: false }
  | {
      active: true;
      current: string;
      channel: "beta" | "stable";
      enabled: boolean;
      ntfy: boolean;
      checkedAt: string | null;
      couldntCheck: boolean;
      available: { version: string; url: string; summary: string; publishedAt: string | null; prerelease: boolean } | null;
      /** BOS-2713: whether the server can ask the updater to install, and what the updater is doing. */
      install: { linked: boolean; updater: UpdaterProgress | null };
    };

/** What the updater is doing, in words for the owner. A stage not listed reads as "working". */
const STAGE_WORDS: Record<string, string> = {
  verifying: "Checking the release's signature",
  pulling: "Downloading the new version",
  "installing-pack": "Getting Claude Code ready",
  "backing-up": "Backing up the database",
  migrating: "Updating the database",
  "starting-colour": "Starting the new version beside the old one",
  "handing-over": "Handing over to the new version",
  flipping: "Switching over",
  soaking: "Watching the new version. It goes back to the old one by itself if anything looks wrong (about 15 minutes)",
  "stopping-old": "Stopping the old version",
  "updating-updater": "Finishing up",
};
const RUNNING = new Set(Object.keys(STAGE_WORDS));

/**
 * BOS-2663 and BOS-2713: a new release of an install from the published images, found by the server's daily check. Shows nothing on
 * a source install. The line names the version, says in plain words what is in it, links the release notes and has the Install
 * button; the two switches turn the daily check off, and the phone push on.
 */
export function ReleaseNotice() {
  const act = useAction();
  // Every 10 seconds: the server answers from its stored result and one call to the updater on its private network, so an install's
  // progress shows without a second poll.
  const w = usePoll((signal) => api<ReleaseWatchView>("/api/release-watch", { signal }), 10_000, "release-watch");
  const view = w.data;
  if (!view || !view.active) return null;
  const set = (patch: { enabled?: boolean; ntfy?: boolean }) =>
    act.run(async () => {
      await api("/api/release-watch", { method: "PUT", body: patch });
      w.reload();
    });
  const install = (version: string) =>
    act.run(async () => {
      await api("/api/release-watch/install", { method: "POST", body: { version } });
      w.reload();
    });
  const dismiss = () =>
    act.run(async () => {
      await api("/api/release-watch/ack", { method: "POST" });
      w.reload();
    });
  return <ReleaseNoticeBody v={view} busy={act.busy} set={set} install={install} dismiss={dismiss} extra={act.view} />;
}

/** The release line, its Install button and its two switches, apart from the polling so a browser test can render it with fixed data. */
export function ReleaseNoticeBody({ v, busy, set, install, dismiss, extra }: { v: Extract<ReleaseWatchView, { active: true }>; busy: boolean; set: (patch: { enabled?: boolean; ntfy?: boolean }) => void; install?: (version: string) => void; dismiss?: () => void; extra?: ReactNode }) {
  const act = { busy, view: extra };
  const up = v.install?.updater ?? null;
  const running = !!up && RUNNING.has(up.stage);
  // What the updater last did, until it is read: a finished install, a roll-back or a failure.
  const finished = up && !running && up.stage !== "idle" && (up.report || up.error) && !(up.report?.acknowledged ?? false) ? up : null;
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
      {running && up && (
        <p role="status" style={{ fontSize: 14 }}>
          Installing {up.version ?? "the new release"}: {STAGE_WORDS[up.stage]}. You can leave this page; the page may blink once when the new version takes over.
        </p>
      )}
      {v.available && !running && install && v.install?.linked && (
        <div>
          <button type="button" className="primary" disabled={act.busy} onClick={() => install(v.available!.version)}>
            Install {v.available.version}
          </button>
          <p className="muted" style={{ fontSize: 13, margin: "4px 0 0" }}>
            Backs up the database first, switches over without stopping the page, and goes back by itself if the new version misbehaves.
          </p>
        </div>
      )}
      {v.available && !running && v.install && !v.install.linked && (
        <p className="muted" style={{ fontSize: 14 }}>
          This server was made before the Install button existed, so install this release by hand (see the updating guide). The server that update makes will have the button.
        </p>
      )}
      {finished && (
        <p role={finished.report?.level === "problem" || finished.error ? "alert" : "status"} className={finished.report?.level === "problem" || finished.error ? "error" : "muted"} style={{ fontSize: 14 }}>
          {finished.report?.text ?? finished.error?.message}{" "}
          {dismiss && (
            <button type="button" disabled={act.busy} onClick={dismiss}>
              Got it
            </button>
          )}
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
