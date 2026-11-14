import { when } from "../Runs";

export type UpdateRow = { at: string; title: string; body: string; state: "ok" | "resolved" | "problem"; todo: string | null };
export type LiveRow = { slug: string; name: string; registered: boolean; connected: boolean; at: string | null; imageVersion: string | null; fault: string | null; swap?: { retryAt: string | null; tries: number } | null; swapFailed?: string | null; guard?: { reason: string; since: string | null } | null };
export type Report = { live: LiveRow[]; update: UpdateRow | null };
export type LastUpdate = { at: string; startedAt: string | null; ok: boolean; title: string; body: string } | null;
export type MaintenanceView = ({ on: false } | { on: true; kind?: "update" | "settings" | "wrapup"; deadline: string; runs: number; companies: number; blocking?: boolean }) & { last?: LastUpdate };
/** `gotMessage` and `step` (BOS-1016) are absent from an older server. */
export type WrapUpRun = { runId: string; agent: string | null; ticket: string | null; ticketTitle: string | null; runningForMinutes: number; sinceWrapUpMinutes: number; waitingOn: { question: string; tier: string | null } | null; gotMessage?: boolean; step?: { title: string; sinceMinutes: number } | null };
/** The owner's wrap-up ask is on: its own hold, or asked while an update waits (BOS-988), which keeps the update's kind. */
export type WrapUpStatus = MaintenanceView & { on: true; wrapAsked?: boolean; minutes?: number; notRespondingAfter: number; runsList: WrapUpRun[] };

/** The last update as history: grey and "Resolved" once the runner has come back on its image, red only for something wrong now (BOS-465). */
export function UpdateHistory({ r }: { r: UpdateRow }) {
  if (r.state === "ok")
    return (
      <p style={{ fontSize: 14 }} data-testid="update-history">
        <span className="tag">OK</span> Last update {when(r.at)}: {r.title}. {r.body}
      </p>
    );
  if (r.state === "resolved")
    return (
      <p style={{ fontSize: 14 }} data-testid="update-history">
        <span className="tag grey">Resolved</span> Last update {when(r.at)}: it finished with problems ({r.body}), but the runner has since reconnected on the new image.
      </p>
    );
  return (
    <p style={{ fontSize: 14 }} data-testid="update-history">
      <span className="tag red">PROBLEM</span> Last update {when(r.at)}: {r.title}. {r.body} <strong>{r.todo}</strong>
    </p>
  );
}

/** The live state of one company's runner, leading the panel: connected or not, and since when. */
export function LiveState({ r }: { r: LiveRow }) {
  const connected = r.registered && r.connected;
  return (
    <li style={{ listStyle: "none" }}>
      <strong>{r.name}</strong>{" "}
      {connected ? (
        <span className="tag green">Connected</span>
      ) : r.swap ? (
        <span className="tag amber">Updating</span>
      ) : r.swapFailed ? (
        <span className="tag red">Update failed</span>
      ) : r.guard ? (
        <span className="tag red">Paused: network guard</span>
      ) : (
        <span className="tag red">Not connected</span>
      )}{" "}
      <span className="muted">
        {connected ? "since" : r.at ? "last seen" : ""} {r.at ? when(r.at) : ""}
        {connected && r.imageVersion ? ` · image ${r.imageVersion}` : ""}
        {r.fault ? ` · ${r.fault}` : ""}
        {!connected && r.swapFailed ? ` · ${r.swapFailed}` : ""}
        {!connected && !r.swap && !r.swapFailed && r.guard ? ` · ${r.guard.reason}` : ""}
      </span>
    </li>
  );
}
