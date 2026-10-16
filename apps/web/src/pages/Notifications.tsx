import { useEffect, useState, type FormEvent } from "react";
import { api, type Notice, type NoticeFeed, type NotifyLevel, type NotifySettings } from "../api";
import { usePoll } from "../hooks";
import { when } from "./Runs";

const LEVEL: Record<NotifyLevel, { label: string; tone: string; help: string }> = {
  note: { label: "Note", tone: "", help: "The feed only" },
  flag: { label: "Flag", tone: "blue", help: "A browser notification" },
  page: { label: "Page", tone: "red", help: "Also the phone: something urgent" },
  ask: { label: "Ask", tone: "amber", help: "Needs an answer" },
};

function Item({ n, onRead }: { n: Notice; onRead: (id: string) => void }) {
  return (
    <li className="card" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 16px", opacity: n.readAt ? 0.7 : 1 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span className={`tag ${LEVEL[n.level].tone}`}>{LEVEL[n.level].label}</span>
        {!n.readAt && <span className="tag green">New</span>}
        <strong style={{ fontWeight: 600 }}>{n.title}</strong>
        <span className="muted" style={{ fontSize: 13, marginLeft: "auto" }}>
          {n.company ? `${n.company} · ` : ""}
          {when(n.createdAt)}
        </span>
      </div>
      {n.body && <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{n.body}</p>}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
        <a href={n.link} onClick={() => !n.readAt && onRead(n.id)}>
          See the evidence
        </a>
        {n.demotedBy && (
          <span className="muted">
            Asked as a {n.requested}, sent as a {n.level}: {n.demotedBy === "cap" ? "the agent was over its hourly cap" : "quiet hours"}.
          </span>
        )}
        {n.pushedAt && <span className="muted">Sent to your phone.</span>}
        {n.pushError && <span className="error">Phone push failed: {n.pushError}</span>}
        {!n.readAt && (
          <button type="button" className="btn small" style={{ marginLeft: "auto" }} onClick={() => onRead(n.id)}>
            Mark read
          </button>
        )}
      </div>
    </li>
  );
}

type Form = {
  quiet: boolean;
  start: string;
  end: string;
  timeZone: string;
  cap: number;
  phone: boolean;
  url: string;
  topic: string;
  token: string;
  clearToken: boolean;
  pushLevels: NotifyLevel[];
  publicUrl: string;
};

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function toForm(s: NotifySettings): Form {
  return {
    quiet: !!s.quietHours,
    start: s.quietHours?.start ?? "22:00",
    end: s.quietHours?.end ?? "07:00",
    timeZone: s.quietHours?.timeZone ?? browserZone(),
    cap: s.agentHourlyCap,
    phone: !!s.ntfy,
    url: s.ntfy?.url ?? "",
    topic: s.ntfy?.topic ?? "",
    token: "",
    clearToken: false,
    pushLevels: s.pushLevels,
    publicUrl: s.publicUrl ?? (window.location.protocol === "https:" ? window.location.origin : ""),
  };
}

function SettingsForm() {
  const [saved, setSaved] = useState<NotifySettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void api<NotifySettings>("/api/notification-settings").then((s) => (setSaved(s), setForm(toForm(s))), (err: Error) => setNote({ ok: false, text: err.message }));
  }, []);
  if (!form) return note ? <p className="error">{note.text}</p> : null;
  const set = (patch: Partial<Form>) => setForm({ ...form, ...patch });
  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    try {
      setNote({ ok: true, text: await fn() });
    } catch (err) {
      setNote({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => {
      const s = await api<NotifySettings>("/api/notification-settings", {
        method: "PUT",
        body: {
          quietHours: form.quiet ? { start: form.start, end: form.end, timeZone: form.timeZone.trim() } : null,
          agentHourlyCap: form.cap,
          ntfy: form.phone ? { url: form.url.trim(), topic: form.topic.trim(), ...(form.token ? { token: form.token } : form.clearToken ? { token: null } : {}) } : null,
          pushLevels: form.pushLevels,
          publicUrl: form.publicUrl.trim() || null,
        },
      });
      setSaved(s);
      setForm(toForm(s));
      return "Saved.";
    });
  };
  const test = () => act(async () => (await api("/api/notification-settings/test", { method: "POST" }), "Test sent. Check your phone."));
  const row = { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" } as const;
  const check = { display: "flex", gap: 6, alignItems: "center", minHeight: 32, fontSize: 14 } as const;

  return (
    <form className="card" onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 16 }} aria-labelledby="notify-settings-h">
      <h2 id="notify-settings-h" style={{ fontSize: 17, fontWeight: 600 }}>
        How you're told
      </h2>
      <p className="muted" style={{ fontSize: 14 }}>
        Notes stay in this feed. Flags, pages and asks also show as browser notifications while Boss Man is open in a background tab. Quiet hours and each agent's hourly cap lower a notification's level instead of dropping it.
      </p>

      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={check}>
          <input type="checkbox" checked={form.quiet} onChange={(e) => set({ quiet: e.target.checked })} />
          Quiet hours: pages and asks become flags, flags become notes
        </label>
        {form.quiet && (
          <div style={row}>
            <div className="field">
              <label htmlFor="quiet-start">From</label>
              <input id="quiet-start" type="time" required value={form.start} onChange={(e) => set({ start: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="quiet-end">Until</label>
              <input id="quiet-end" type="time" required value={form.end} onChange={(e) => set({ end: e.target.value })} />
            </div>
            <div className="field" style={{ flex: "1 1 200px" }}>
              <label htmlFor="quiet-tz">Time zone</label>
              <input id="quiet-tz" required value={form.timeZone} onChange={(e) => set({ timeZone: e.target.value })} spellCheck={false} />
            </div>
          </div>
        )}
      </fieldset>

      <div className="field" style={{ maxWidth: 260 }}>
        <label htmlFor="agent-cap">Per agent, per hour, before the rest become notes</label>
        <input id="agent-cap" type="number" min={1} max={100} required value={form.cap} onChange={(e) => set({ cap: Number(e.target.value) })} />
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 10 }}>
        <label style={check}>
          <input type="checkbox" checked={form.phone} onChange={(e) => set({ phone: e.target.checked })} />
          Send to my phone through my own ntfy server
        </label>
        {form.phone && (
          <>
            <div style={row}>
              <div className="field" style={{ flex: "2 1 260px" }}>
                <label htmlFor="ntfy-url">ntfy server</label>
                <input id="ntfy-url" type="url" required placeholder="https://ntfy.your-tailnet.ts.net" value={form.url} onChange={(e) => set({ url: e.target.value })} spellCheck={false} />
              </div>
              <div className="field" style={{ flex: "1 1 160px" }}>
                <label htmlFor="ntfy-topic">Topic</label>
                <input id="ntfy-topic" required pattern="[A-Za-z0-9_\-]{1,64}" value={form.topic} onChange={(e) => set({ topic: e.target.value })} spellCheck={false} />
              </div>
            </div>
            <div style={row}>
              <div className="field" style={{ flex: "1 1 260px" }}>
                <label htmlFor="ntfy-token">Access token{saved?.ntfy?.hasToken ? " (one is saved; type a new one to replace it)" : ""}</label>
                <input id="ntfy-token" type="password" autoComplete="off" spellCheck={false} value={form.token} onChange={(e) => set({ token: e.target.value, clearToken: false })} />
              </div>
              {saved?.ntfy?.hasToken && (
                <label style={check}>
                  <input type="checkbox" checked={form.clearToken} onChange={(e) => set({ clearToken: e.target.checked, token: "" })} />
                  Remove the saved token
                </label>
              )}
            </div>
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }} role="group" aria-label="Levels sent to the phone">
              <span className="label" style={{ alignSelf: "center" }}>
                To the phone
              </span>
              {(["flag", "page", "ask"] as const).map((l) => (
                <label key={l} style={check}>
                  <input type="checkbox" checked={form.pushLevels.includes(l)} onChange={(e) => set({ pushLevels: e.target.checked ? [...form.pushLevels, l] : form.pushLevels.filter((x) => x !== l) })} />
                  {LEVEL[l].label}s
                </label>
              ))}
            </div>
            <div className="field">
              <label htmlFor="public-url">Boss Man's address on your phone, so a tap opens the evidence</label>
              <input id="public-url" type="url" placeholder="https://bossman.your-tailnet.ts.net" value={form.publicUrl} onChange={(e) => set({ publicUrl: e.target.value })} spellCheck={false} />
            </div>
          </>
        )}
      </fieldset>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <button className="btn primary" type="submit" disabled={busy}>
          Save
        </button>
        {saved?.ntfy && (
          <button className="btn" type="button" disabled={busy} onClick={() => void test()}>
            Send a test to my phone
          </button>
        )}
      </div>
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"} style={{ fontSize: 14 }}>
          {note.text}
        </p>
      )}
    </form>
  );
}

export function Notifications({ feed, onChanged }: { feed: NoticeFeed | null; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const read = (body: { ids: string[] } | { all: true }) =>
    void api("/api/notifications/read", { method: "POST", body }).then(onChanged, (err: Error) => setError(err.message));
  const items = feed?.items ?? [];
  return (
    <>
      <header className="page-head">
        <div>
          <h1>Notifications</h1>
          <p className="sub">Everything Boss Man and the agents have told you, newest first, with where to look.</p>
        </div>
        {(feed?.unread ?? 0) > 0 && (
          <button className="btn" type="button" onClick={() => read({ all: true })}>
            Mark all read
          </button>
        )}
      </header>
      {error && <p className="error">{error}</p>}
      {feed && !items.length && <p className="muted">Nothing yet. Decisions that need you, alerts and agents' notes will show here.</p>}
      {items.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((n) => (
            <Item key={n.id} n={n} onRead={(id) => read({ ids: [id] })} />
          ))}
        </ul>
      )}
      <SettingsForm />
    </>
  );
}
