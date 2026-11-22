import { useCallback, useEffect, useState, type FormEvent } from "react";
import { apiOnce } from "../api";
import { MoreAbout } from "./MoreAbout";

// BOS-2199: the Notifications page, "Other places to send alerts". The address is a secret: it is typed here once,
// sent to the server and never shown again; the page only ever holds the last 4 characters the server returns.

type Kind = "decision_waiting" | "merge_stuck" | "spend_alert" | "run_failed" | "daily_summary";
type Dest = { id: string; type: "slack" | "discord" | "webhook"; name: string; kinds: Kind[]; allowPrivate: boolean; enabled: boolean; hint: string | null; lastFailureNote: string | null; lastFailedAt: string | null };

const KIND_LABEL: Record<Kind, string> = { decision_waiting: "A decision is waiting", merge_stuck: "Merging is stuck", spend_alert: "A spend alert", run_failed: "A run failed", daily_summary: "The daily summary" };
const KINDS = Object.keys(KIND_LABEL) as Kind[];
const DEFAULT_KINDS: Kind[] = ["decision_waiting", "merge_stuck"];
const TYPE_LABEL = { slack: "Slack", discord: "Discord", webhook: "Plain webhook" } as const;
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const errorText = (e: unknown) => (e instanceof Error ? e.message : "That didn't work.");

function KindBoxes({ value, onChange }: { value: Kind[]; onChange: (k: Kind[]) => void }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
      <legend className="muted" style={{ fontSize: 13 }}>
        Send these
      </legend>
      {KINDS.map((k) => (
        <label key={k} style={{ display: "flex", gap: 6, alignItems: "center", minHeight: 32, fontSize: 14 }}>
          <input type="checkbox" checked={value.includes(k)} onChange={(e) => onChange(e.target.checked ? [...value, k] : value.filter((x) => x !== k))} />
          {KIND_LABEL[k]}
        </label>
      ))}
    </fieldset>
  );
}

function Row({ d, onChanged }: { d: Dest; onChanged: () => void }) {
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [address, setAddress] = useState("");
  const [kinds, setKinds] = useState<Kind[]>(d.kinds);
  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setResult(null);
    try {
      await fn();
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  };
  const put = (body: object) => apiOnce(`/api/alert-destinations/${d.id}`, { method: "PUT", body });
  return (
    <li style={{ border: "1px solid var(--border, #8884)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <strong>{d.name}</strong>
        <span className="muted" style={{ fontSize: 14 }}>
          {TYPE_LABEL[d.type]} · address ending {d.hint ?? "(missing)"}
        </span>
      </div>
      <p className="muted" style={{ fontSize: 14, margin: 0 }}>
        {d.kinds.length ? d.kinds.map((k) => KIND_LABEL[k]).join(", ") : "Nothing ticked: nothing is sent"}
        {d.allowPrivate ? " · on your own network" : ""}
      </p>
      {!d.enabled && (
        <p role="alert" className="error" style={{ fontSize: 14, margin: 0 }}>
          Switched off after 3 days of failures{d.lastFailureNote ? ` (last answer: ${d.lastFailureNote})` : ""}. Check the address, then switch it back on.
        </p>
      )}
      {d.enabled && d.lastFailureNote && d.lastFailedAt && (
        <p role="status" className="error" style={{ fontSize: 14, margin: 0 }}>
          Last failed {clock(d.lastFailedAt)}: {d.lastFailureNote}
        </p>
      )}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            act(async () => {
              const r = await apiOnce<{ ok: boolean; message: string }>(`/api/alert-destinations/${d.id}/test`, { method: "POST", body: {} });
              setResult({ ok: r.ok, text: r.message });
            })
          }
        >
          Send a test message
        </button>
        <button type="button" disabled={busy} onClick={() => act(async () => (await put({ enabled: !d.enabled }), onChanged()))}>
          {d.enabled ? "Switch off" : "Switch on"}
        </button>
        <button type="button" disabled={busy} onClick={() => setEditing((v) => !v)}>
          {editing ? "Cancel" : "Change"}
        </button>
        <button type="button" disabled={busy} onClick={() => act(async () => (await apiOnce(`/api/alert-destinations/${d.id}`, { method: "DELETE" }), onChanged()))}>
          Remove
        </button>
      </div>
      {editing && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
            New address (leave empty to keep the one saved)
            <input type="password" autoComplete="off" value={address} onChange={(e) => setAddress(e.target.value)} style={{ minHeight: 36 }} />
          </label>
          <KindBoxes value={kinds} onChange={setKinds} />
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                act(async () => {
                  await put({ kinds, ...(address.trim() ? { address: address.trim() } : {}) });
                  setAddress("");
                  setEditing(false);
                  onChanged();
                })
              }
            >
              Save changes
            </button>
          </div>
        </div>
      )}
      {result && (
        <p role={result.ok ? "status" : "alert"} className={result.ok ? "muted" : "error"} style={{ fontSize: 14, margin: 0 }}>
          {result.text}
        </p>
      )}
    </li>
  );
}

export function AlertDestinations() {
  const [list, setList] = useState<Dest[]>([]);
  const [type, setType] = useState<Dest["type"]>("slack");
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [kinds, setKinds] = useState<Kind[]>(DEFAULT_KINDS);
  const [allowPrivate, setAllowPrivate] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await apiOnce<{ destinations?: Dest[] }>("/api/alert-destinations");
      setList(Array.isArray(r.destinations) ? r.destinations : []);
    } catch {
      // The list stays as it was; a failed read is not worth an error box.
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await apiOnce("/api/alert-destinations", { method: "POST", body: { type, name: name.trim(), address: address.trim(), kinds, allowPrivate } });
      setName("");
      setAddress("");
      setKinds(DEFAULT_KINDS);
      setAllowPrivate(false);
      await load();
    } catch (e2) {
      setErr(errorText(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="alert-destinations-h" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <h2 id="alert-destinations-h" style={{ fontSize: 17, fontWeight: 600 }}>
        Other places to send alerts
      </h2>
      <MoreAbout lead="Send alerts to Slack, Discord or any web address that takes a webhook. Off until you add one.">
        <li>The address is kept like a password: after you save it, only its last 4 characters show.</li>
        <li>It must start with https://. An address on your own network is refused unless you tick the box.</li>
        <li>A send that fails is tried once more a minute later. After 3 days of failures in a row the place switches itself off and Boss Man tells you once.</li>
      </MoreAbout>
      {list.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {list.map((d) => (
            <Row key={`${d.id}-${d.kinds.join()}-${d.enabled}`} d={d} onChanged={load} />
          ))}
        </ul>
      )}
      <form onSubmit={add} style={{ display: "flex", flexDirection: "column", gap: 10 }} aria-label="Add a place to send alerts">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
            Type
            <select value={type} onChange={(e) => setType(e.target.value as Dest["type"])} style={{ minHeight: 36 }}>
              {(Object.keys(TYPE_LABEL) as Dest["type"][]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
            Name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} style={{ minHeight: 36 }} />
          </label>
        </div>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 14 }}>
          Webhook address
          <input type="password" autoComplete="off" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="https://" style={{ minHeight: 36 }} />
        </label>
        <KindBoxes value={kinds} onChange={setKinds} />
        <label style={{ display: "flex", gap: 6, alignItems: "center", minHeight: 32, fontSize: 14 }}>
          <input type="checkbox" checked={allowPrivate} onChange={(e) => setAllowPrivate(e.target.checked)} />
          This is on my own network
        </label>
        <div>
          <button type="submit" disabled={busy || !name.trim() || !address.trim()}>
            Add
          </button>
        </div>
        {err && (
          <p role="alert" className="error" style={{ fontSize: 14, margin: 0 }}>
            {err}
          </p>
        )}
      </form>
    </section>
  );
}
