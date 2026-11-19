import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isInfiniteModel } from "@boss-man/shared";
import { api, type Company } from "../api";
import { away } from "../server-watch";
import { useDraft } from "../drafts";
import { useImageAttach, withAttachments } from "../components/ImageAttach";
import { OwnerMessageBox, tooLongToSend } from "../components/OwnerMessageBox";
import { describe, MAX_ITEMS, useTranscript } from "../transcript";
import { failureReason, outcomeTag, usage, when } from "./Runs";
import { NotFoundBlock } from "../components/NotFoundBlock";
import { Loader } from "../components/Loader";

/** Steering (R37): a message after the current turn, or one that interrupts it, and stop. */
function Steer({ runId, companyId, ticketId }: { runId: string; companyId: string; ticketId?: string | null }) {
  // A message being typed to a run survives a freeze or a reload (BOS-637).
  const [text, setText, clearText] = useDraft(`run/${runId}/message`);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const img = useImageAttach(companyId, ticketId ?? undefined);
  const send = async (interrupt: boolean) => {
    const outgoing = withAttachments(text, img.attached);
    if (!outgoing.trim() || tooLongToSend(outgoing)) return;
    setBusy(true);
    try {
      await api(`/api/runs/${runId}/message`, { method: "POST", body: { text: outgoing, interrupt } });
      // Sent: the draft goes. A failed send keeps it, so Send can be pressed again (BOS-637).
      clearText();
      img.clear();
      setNote({ ok: true, text: interrupt ? "Sent. The current turn stops first." : "Sent. It goes in after the current turn." });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  // Too long for a message: attach it to the run's ticket as a .txt file, which the agent opens whole,
  // then send the run a short message pointing at it.
  const sendAsFile = async (long: string) => {
    if (!ticketId) return;
    try {
      const markdown = await img.uploadText(long, "message.txt");
      const outgoing = withAttachments("I've sent the text as a file (below); please read it before answering.", [markdown]);
      await api(`/api/tickets/${ticketId}/messages`, { method: "POST", body: { text: outgoing } });
      clearText();
      img.clear();
      setNote({ ok: true, text: "Sent as a .txt file on the ticket; the agent is woken to read it." });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    }
  };
  const stop = async () => {
    setBusy(true);
    try {
      const r = await api<{ endedHere?: boolean }>(`/api/runs/${runId}/cancel`, { method: "POST" });
      setNote({ ok: true, text: r.endedHere ? "The runner is offline, so Boss Man marked the run as stopped." : "Stopping the run." });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card" onSubmit={(e: FormEvent) => (e.preventDefault(), void send(false))} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div className="field">
        <OwnerMessageBox
          id="steer"
          label="Message the agent"
          rows={3}
          value={text}
          onChange={setText}
          onPaste={img.onPaste}
          onSendAsFile={ticketId ? sendAsFile : undefined}
          attaching={img.busy}
          error={img.error}
          placeholder={ticketId ? undefined : "This run isn't on a ticket, so a very long paste can't be sent as a file."}
        />
        {img.attached.length > 0 && <small className="muted">Attached files are sent with the message.</small>}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button className="btn primary" type="submit" disabled={busy || img.busy || tooLongToSend(text, img.attached)}>
          Send after this turn
        </button>
        <button className="btn" type="button" disabled={busy || img.busy || tooLongToSend(text, img.attached)} onClick={() => void send(true)}>
          Interrupt and send
        </button>
        <button className="btn" type="button" disabled={busy} onClick={() => void stop()} style={{ marginLeft: "auto", color: "var(--red-ink)" }}>
          Stop run
        </button>
      </div>
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"} style={{ fontSize: 14 }}>
          {note.text}
        </p>
      )}
    </form>
  );
}

export function Run({ runId, companies }: { runId: string; companies: Company[] }) {
  const { run, items, dropped, error } = useTranscript(runId);
  const scroller = useRef<HTMLDivElement>(null);
  // Follows the end of the transcript until the owner scrolls up; scrolling back down follows again.
  const follow = useRef(true);
  const userScrolled = useRef(0);
  // Only the rows in view are in the page, so a run of thousands of events stays light (R43).
  const rows = useVirtualizer({ count: items.length, getScrollElement: () => scroller.current, estimateSize: () => 56, overscan: 12 });

  useEffect(() => {
    if (!follow.current || !items.length) return;
    rows.scrollToIndex(items.length - 1, { align: "end" });
    // Rows are measured as they render, so settle on the true end a frame later.
    const frame = requestAnimationFrame(() => {
      const el = scroller.current;
      if (el && follow.current) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [items.length, rows]);

  if (error && !run && !away(error)) return error.status === 404 ? <NotFoundBlock title="Run not found" backHref="#/runs" backLabel="Back to Runs">This run doesn't exist any more, or the link is wrong.</NotFoundBlock> : <p className="error" role="alert">{error.message}</p>;
  const company = companies.find((c) => c.id === run?.companyId);
  return (
    <>
      <header className="page-head">
        <div>
          <p className="label">
            <a href="#/runs">Runs</a> · {company?.name ?? ""}
          </p>
          <h1>{run ? `${run.agent ?? "An agent"}${run.ticket ? `: ${run.ticket}` : ""}` : "Run"}</h1>
          {run && (
            <p className="sub" style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", alignItems: "center" }}>
              {outcomeTag(run.endedAt ? (run.outcome ?? "end_turn") : null)}
              <span>Started {when(run.startedAt)}</span>
              {run.endedAt && <span>Ended {when(run.endedAt)}</span>}
              <span className="mono">{run.model ?? "default model"}</span>
              {isInfiniteModel(run.model) && (
                <span className="tag" title="Synthetic Infinite mode: free (doesn't spend the plan's credits) and slow, in a background run slot.">
                  Infinite mode · free, slow
                </span>
              )}
              <span className="mono" title={usage(run).title}>
                {usage(run).text}
              </span>
            </p>
          )}
          {run?.endedAt && failureReason(run.outcome) && (
            <p role="status" className={run.outcome?.startsWith("error") ? "error" : "muted"} style={{ margin: "6px 0 0", overflowWrap: "anywhere" }}>
              {failureReason(run.outcome)}
            </p>
          )}
        </div>
      </header>
      {run && !run.endedAt && <Steer runId={runId} companyId={run.companyId} ticketId={run.ticketId} />}
      {dropped > 0 && (
        <p className="muted" style={{ fontSize: 13 }}>
          Showing the latest {MAX_ITEMS.toLocaleString()} events; {dropped.toLocaleString()} earlier ones aren't kept in this page.
        </p>
      )}
      <div
        ref={scroller}
        className="transcript"
        role="log"
        aria-label="Run transcript"
        aria-live="polite"
        onWheel={() => (userScrolled.current = Date.now())}
        onTouchMove={() => (userScrolled.current = Date.now())}
        onKeyDown={() => (userScrolled.current = Date.now())}
        onPointerDown={() => (userScrolled.current = Date.now())}
        tabIndex={0}
        onScroll={(e) => {
          // Only the owner's own scrolling changes whether it follows, never the page's.
          if (Date.now() - userScrolled.current > 1000) return;
          const el = e.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
      >
        {items.length === 0 ? (
          !run ? (
            <div style={{ padding: 16 }}><Loader label="Loading the run" /></div>
          ) : (
            <p className="muted" style={{ padding: 16 }}>
              {run.endedAt ? "No events are kept for this run: runner events older than the retention period (60 days unless the owner changed it) are deleted." : "Nothing recorded yet."}
            </p>
          )
        ) : (
          <div style={{ height: rows.getTotalSize(), position: "relative" }}>
            {rows.getVirtualItems().map((v) => {
              const item = items[v.index]!;
              const d = describe(item);
              return (
                <div key={item.seq} data-index={v.index} ref={rows.measureElement} className={`line ${d.tone}`} style={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${v.start}px)` }}>
                  <span className="mono muted at">{new Date(item.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
                  <div className="what">
                    <strong>{d.label}</strong>
                    {d.body && (d.tone === "tool" ? <span className="tag">{d.body.replace(/_/g, " ")}</span> : <p>{d.body}</p>)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
