import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type Company } from "../api";
import { describe, MAX_ITEMS, useTranscript } from "../transcript";
import { outcomeTag, usage, when } from "./Runs";

/** Steering (R37): a message after the current turn, or one that interrupts it, and stop. */
function Steer({ runId }: { runId: string }) {
  const [text, setText] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const send = async (interrupt: boolean) => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api(`/api/runs/${runId}/message`, { method: "POST", body: { text, interrupt } });
      setText("");
      setNote({ ok: true, text: interrupt ? "Sent. The current turn stops first." : "Sent. It goes in after the current turn." });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
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
        <label htmlFor="steer">Message the agent</label>
        <textarea id="steer" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button className="btn primary" type="submit" disabled={busy}>
          Send after this turn
        </button>
        <button className="btn" type="button" disabled={busy} onClick={() => void send(true)}>
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

  if (error && !run) return <p className="error" role="alert">{error.status === 404 ? "There's no such run." : error.message}</p>;
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
              <span className="mono" title={usage(run).title}>
                {usage(run).text}
              </span>
            </p>
          )}
        </div>
      </header>
      {run && !run.endedAt && <Steer runId={runId} />}
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
          <p className="muted" style={{ padding: 16 }}>
            {run ? "Nothing recorded yet." : "Loading…"}
          </p>
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
