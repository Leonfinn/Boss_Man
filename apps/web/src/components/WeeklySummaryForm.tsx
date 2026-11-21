import { useEffect, useState, type FormEvent } from "react";
import { api, type Company } from "../api";

type Weekly = { enabled: boolean; to: string | null; lastSentAt: string | null; configured: boolean };

function One({ company }: { company: Company }) {
  const [w, setW] = useState<Weekly | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [to, setTo] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<Weekly>(`/api/companies/${company.id}/weekly-summary`).then(
      (s) => {
        setW(s);
        setEnabled(s.enabled);
        setTo(s.to ?? "");
      },
      (e: Error) => setMsg(e.message),
    );
  }, [company.id]);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const s = await api<Weekly>(`/api/companies/${company.id}/weekly-summary`, { method: "PUT", body: { enabled, to: to.trim() || null } });
      setW(s);
      setMsg("Saved.");
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!w) return msg ? <p role="alert">{msg}</p> : null;
  return (
    <form onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-label={`Weekly summary for ${company.name}`}>
      <label style={{ display: "flex", gap: 6, alignItems: "center", minHeight: 32, fontSize: 14 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Weekly summary by email{" "}
        {company.name}
      </label>
      {enabled && (
        <div className="field">
          <label htmlFor={`weekly-to-${company.id}`}>Send it to</label>
          <input id={`weekly-to-${company.id}`} type="email" required value={to} onChange={(e) => setTo(e.target.value)} placeholder="you@example.com" />
        </div>
      )}
      {enabled && !w.configured && <p style={{ fontSize: 13 }}>Outgoing email isn't set up yet, so nothing will be sent. Add the mail server in Settings → Server and runner → Email.</p>}
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button className="btn" type="submit" disabled={busy}>
          Save
        </button>
        {msg && <span role="status">{msg}</span>}
        {w.lastSentAt && <span style={{ fontSize: 13 }}>Last sent {new Date(w.lastSentAt).toLocaleDateString()}</span>}
      </div>
    </form>
  );
}

/** Settings → Notifications: the optional Monday-morning email (BOS-2195). Off until switched on. */
export function WeeklySummaryForm({ companies }: { companies: Company[] | null }) {
  if (!companies?.length) return null;
  return (
    <section className="card" style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-labelledby="weekly-summary-h">
      <h2 id="weekly-summary-h" style={{ fontSize: 17, fontWeight: 600 }}>
        Weekly summary
      </h2>
      <p style={{ fontSize: 14 }}>On Monday at 8am your time, one email: what merged this week, what it cost against the week before, features released and cards still waiting for you. Off by default.</p>
      {companies.map((c) => (
        <One key={c.id} company={c} />
      ))}
    </section>
  );
}
