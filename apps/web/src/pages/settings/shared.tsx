import { useState, type ReactNode } from "react";

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="card" aria-labelledby={id} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <h2 id={id} style={{ fontSize: 17, fontWeight: 600 }}>
        {title}
      </h2>
      {children}
    </section>
  );
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    try {
      const msg = await fn();
      setNote(msg ? { ok: true, text: msg } : null);
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const view = note && (
    <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"} style={{ fontSize: 14 }}>
      {note.text}
    </p>
  );
  return { busy, run, view };
}
