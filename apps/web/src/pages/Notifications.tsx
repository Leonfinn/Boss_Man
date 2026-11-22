import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, apiOnce, type Company, type Notice, type NoticeCounts, type NoticeFeed, type NotifyLevel, type NotifySettings } from "../api";
import { raisedAgo } from "../age";
import { defaultLinkAddress, type LinkAddress } from "../link-address";
import type { HostFactsView } from "../host-facts-display";
import { useOlder, usePoll } from "../hooks";
import { ShowOlder } from "../components/ShowOlder";
import { away } from "../server-watch";
import { when } from "./Runs";
import { MoreText } from "./Decisions";
import { MoreAbout } from "../components/MoreAbout";
import { AlertDestinations } from "../components/AlertDestinations";
import { WeeklySummaryForm } from "../components/WeeklySummaryForm";
import { SaveButton, useSaveState } from "../components/SaveButton";
import { FeedItem, LevelTag, feedTitle } from "../components/FeedItem";

const LEVEL: Record<NotifyLevel, { label: string; tone: string; help: string }> = {
  note: { label: "Note", tone: "", help: "The feed only" },
  flag: { label: "Flag", tone: "blue", help: "A browser notification" },
  page: { label: "Page", tone: "red", help: "Also the phone: something urgent" },
  ask: { label: "Ask", tone: "amber", help: "Needs an answer" },
};

type LoginPoll =
  | { status: "pending" }
  | { status: "timeout"; message: string }
  | { status: "done"; result: "created" | "reset"; password: string; user: string }
  | { status: "done"; result: "setup"; message: string }
  | { status: "done"; result: "exists" | "missing" | "failed" | "rejected" | "unavailable"; message: string };
type LoginView =
  | { kind: "idle" }
  | { kind: "working"; action: "create" | "reset" }
  | { kind: "shown"; password: string; user: string; action: "create" | "reset" }
  | { kind: "msg"; ok: boolean; text: string; offer?: "create" | "reset" };

/**
 * "Create phone login" (BOS-1004): the host makes the phone's read-only ntfy user and the password comes back once.
 * It is held in this component's state only while the box is open: dismissing the box (or leaving the page) drops it.
 */
export function PhoneLoginButton({ available, why, pollMs = 3000 }: { available: boolean; why?: string; pollMs?: number }) {
  const [view, setView] = useState<LoginView>({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (action: "create" | "reset") => {
    setView({ kind: "working", action });
    try {
      // apiOnce, never api: the answer holds a password, and api shares and remembers reads.
      const { id } = await apiOnce<{ id: string }>("/api/notification-settings/phone-login", { method: "POST", body: { action } });
      for (let i = 0; i < 130 && alive.current; i++) {
        await new Promise((r) => setTimeout(r, pollMs));
        if (!alive.current) return;
        const r = await apiOnce<LoginPoll>(`/api/notification-settings/phone-login/${id}`);
        if (r.status === "pending") continue;
        if (r.status === "timeout") return setView({ kind: "msg", ok: false, text: r.message });
        if (!("message" in r)) return setView({ kind: "shown", password: r.password, user: r.user, action });
        if (r.result === "exists") return setView({ kind: "msg", ok: false, text: r.message, offer: "reset" });
        if (r.result === "missing") return setView({ kind: "msg", ok: false, text: r.message, offer: "create" });
        return setView({ kind: "msg", ok: false, text: r.message });
      }
      if (alive.current) setView({ kind: "msg", ok: false, text: "No answer from the host. Check the host deployer is running, then try again." });
    } catch (err) {
      if (alive.current) setView({ kind: "msg", ok: false, text: (err as Error).message });
    }
  };
  const copy = (text: string) => {
    if (navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => {});
  };
  if (!available) return <p className="muted" style={{ fontSize: 14 }}>Boss Man can't make the login for you here: {why ?? "the host has not reported yet."}</p>;
  return (
    <div data-testid="phone-login" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {view.kind === "shown" ? (
        <div role="alert" className="card" style={{ padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <p style={{ fontSize: 14, margin: 0 }}>
            {view.action === "create" ? "The phone login is ready." : "The password was changed."} In the ntfy app, use user <code>{view.user}</code> and this password:
          </p>
          <code data-testid="phone-login-password" style={{ fontSize: 16, wordBreak: "break-all", userSelect: "all" }}>
            {view.password}
          </code>
          <p className="error" style={{ fontSize: 13, margin: 0 }}>
            This is the only time it is shown. Copy it into the ntfy app now. If you lose it, press Reset password to get a new one.
          </p>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn" type="button" onClick={() => copy(view.password)}>
              Copy password
            </button>
            <button className="btn" type="button" onClick={() => setView({ kind: "idle" })}>
              I've saved it
            </button>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <button className="btn" type="button" disabled={view.kind === "working"} onClick={() => void run("create")}>
            {view.kind === "working" && view.action === "create" ? "Waiting for the host…" : "Create phone login"}
          </button>
          <button className="btn" type="button" disabled={view.kind === "working"} onClick={() => void run("reset")}>
            {view.kind === "working" && view.action === "reset" ? "Waiting for the host…" : "Reset password"}
          </button>
        </div>
      )}
      {view.kind === "working" && <p className="muted" style={{ fontSize: 13, margin: 0 }}>The host picks this up within a minute.</p>}
      {view.kind === "msg" && (
        <p className={view.ok ? "muted" : "error"} role="status" style={{ fontSize: 14, margin: 0 }}>
          {view.text}
          {view.offer && (
            <>
              {" "}
              <button className="btn" type="button" onClick={() => void run(view.offer!)}>
                {view.offer === "reset" ? "Reset password" : "Create phone login"}
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/**
 * "Set up ntfy for me" (BOS-1581): the host makes (or finds) the publish user, its write-only access and a token. The
 * server keeps the token in the encrypted secrets store; it never comes to this page, so there is nothing to copy.
 */
export function NtfySetupButton({ available, why, onDone, pollMs = 3000 }: { available: boolean; why?: string; onDone: () => void; pollMs?: number }) {
  const [view, setView] = useState<{ kind: "idle" | "working" } | { kind: "msg"; ok: boolean; text: string }>({ kind: "idle" });
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async () => {
    setView({ kind: "working" });
    try {
      const { id } = await apiOnce<{ id: string }>("/api/notification-settings/phone-login", { method: "POST", body: { action: "setup" } });
      for (let i = 0; i < 130 && alive.current; i++) {
        await new Promise((r) => setTimeout(r, pollMs));
        if (!alive.current) return;
        const r = await apiOnce<LoginPoll>(`/api/notification-settings/phone-login/${id}`);
        if (r.status === "pending") continue;
        if (r.status === "timeout") return setView({ kind: "msg", ok: false, text: r.message });
        if (!("message" in r)) return setView({ kind: "msg", ok: false, text: "The host sent an unexpected answer. Press the button again." });
        if (r.result === "setup") {
          setView({ kind: "msg", ok: true, text: `${r.message} Press "Send a test to my phone" to check it.` });
          return onDone();
        }
        return setView({ kind: "msg", ok: false, text: r.message });
      }
      if (alive.current) setView({ kind: "msg", ok: false, text: "No answer from the host. Check the host deployer is running, then try again." });
    } catch (err) {
      if (alive.current) setView({ kind: "msg", ok: false, text: (err as Error).message });
    }
  };
  if (!available) return <p className="muted" style={{ fontSize: 14 }}>Boss Man can't set ntfy up for you here: {why ?? "the host has not reported yet."}</p>;
  return (
    <div data-testid="ntfy-setup" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div>
        <button className="btn" type="button" disabled={view.kind === "working"} onClick={() => void run()}>
          {view.kind === "working" ? "Waiting for the host…" : "Set up ntfy for me"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>
        Makes the publish user and access token and picks a topic if you have none. Safe to press again: it changes nothing that is already there.
      </p>
      {view.kind === "msg" && (
        <p className={view.ok ? "muted" : "error"} role="status" style={{ fontSize: 14, margin: 0 }}>
          {view.text}
        </p>
      )}
    </div>
  );
}

type PhonePush = { id: string; title: string; body: string | null; link: string; company: string | null; pushedAt: string; reason: string | null; state: "open" | "with_ceo" | "settled" | "notice"; clearedAt: string | null; clearNote: string | null };
const PUSH_STATE: Record<PhonePush["state"], string> = { open: "Still open", with_ceo: "Back with the CEO", settled: "Settled", notice: "A notice" };

/** The last 20 phone pushes: when, which card, why it counted as urgent, and whether it is still open (BOS-1097). */
function RecentPhonePushes() {
  const pushes = usePoll((signal) => api<{ items: PhonePush[] }>("/api/notifications/pushes", { signal }), 30_000, "phone-pushes");
  const items = pushes.data?.items ?? [];
  const openCount = items.filter((p) => p.state === "open").length;
  const tooOld = items.some((p) => p.clearNote?.startsWith("unsupported"));
  return (
    <details className="pushes">
      <summary>
        <span>Recent phone pushes</span>
        {pushes.data && (
          <span className="muted">
            {" · "}
            {items.length ? `${items.length} · last ${raisedAgo(items[0]!.pushedAt)}` : "none yet"}
          </span>
        )}
        {openCount > 0 && <span className="pushes-open">{` · ${openCount} still open`}</span>}
      </summary>
      <p className="muted" style={{ fontSize: 13 }}>
        The last 20 messages sent to your phone, and why each counted as urgent. Plans, sign-offs and after-merge checks only push if the CEO marks them urgent.
      </p>
      {tooOld && (
        <p className="muted" role="note" style={{ fontSize: 13 }}>
          Your ntfy server is too old to take a settled card's message off your phone (it needs version 2.14 or newer), so those stay there until you swipe them away.
        </p>
      )}
      {pushes.data && !items.length && <p className="muted">Nothing has been sent to your phone yet.</p>}
      {items.length > 0 && (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          {items.map((p) => (
            <li key={p.id} className="card" style={{ padding: "10px 14px", display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong style={{ fontWeight: 600 }}>{p.body ?? p.title}</strong>
                <span className="muted" style={{ fontSize: 13, marginLeft: "auto" }}>
                  {p.company ? `${p.company} · ` : ""}
                  {when(p.pushedAt)}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
                <span className={`tag ${p.state === "open" ? "amber" : ""}`}>{PUSH_STATE[p.state]}</span>
                {p.clearedAt && <span className="muted">Cleared from your phone</span>}
                <span className="muted">Why: {p.reason ?? "not recorded"}</span>
                <a href={p.link}>See the evidence</a>
              </div>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

function Item({ n, onRead }: { n: Notice; onRead: (id: string) => void }) {
  // When the question became the title, show only what follows its first line (if anything) as the body.
  const headline = feedTitle(n.title, n.body);
  const rest = headline === n.title ? n.body : (n.body ?? "").trim().split(/\n/).slice(1).join("\n").trim();
  return (
    <li className="card" style={{ display: "flex", flexDirection: "column", gap: 6, padding: "12px 16px", opacity: n.readAt ? 0.7 : 1 }}>
      <FeedItem
        title={headline}
        lines={2}
        small={
          <>
            <LevelTag level={n.level} label={LEVEL[n.level].label} />
            {!n.readAt && <span className="tag">New</span>}
            <span className="muted">
              {n.company ? `${n.company} · ` : ""}
              {when(n.createdAt)}
            </span>
          </>
        }
      />
      {rest && <MoreText text={rest} lines={3} chars={300} />}
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 13 }}>
        <a href={n.link} onClick={() => !n.readAt && onRead(n.id)}>
          See the evidence
        </a>
        {n.demotedBy && (
          <span className="muted">
            Asked as a {n.requested}, sent as a {n.level}: {n.demotedBy === "cap" ? "the agent was over its hourly cap" : "quiet hours"}.
          </span>
        )}
        {n.pushedAt && <span className="muted">Accepted by ntfy at {new Date(n.pushedAt).toLocaleTimeString()}.</span>}
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
  phonePush: "urgent" | "all";
  publicUrl: string;
  approveButtons: boolean;
  /** "" = not said yet (shows both phones' steps). */
  phoneType: "" | "android" | "iphone" | "both";
};

const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

function toForm(s: NotifySettings, suggested = ""): Form {
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
    pushLevels: s.pushLevels ?? [],
    phonePush: s.phonePush === "all" ? "all" : "urgent",
    // BOS-1603: not the browser's own address (often a Tailscale name or LAN IP the phone can't open): a suggestion or nothing.
    publicUrl: s.publicUrl ?? suggested,
    approveButtons: s.approveButtons !== false,
    phoneType: s.phoneType ?? "",
  };
}

function SettingsForm() {
  const [saved, setSaved] = useState<NotifySettings | null>(null);
  const [form, setForm] = useState<Form | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const sv = useSaveState(form);
  const [guess, setGuess] = useState<LinkAddress | null>(null);
  useEffect(() => {
    void (async () => {
      // The host facts are only a hint: a failure here must not stop the settings loading.
      const facts = await api<HostFactsView>("/api/host-facts").then((h) => h.facts, () => undefined);
      const g = defaultLinkAddress({ origin: window.location.origin, facts, who: "phone" });
      setGuess(g);
      const s = await api<NotifySettings>("/api/notification-settings");
      setSaved(s);
      setForm(toForm(s, g.url));
    })().catch((err: Error) => setNote({ ok: false, text: err.message }));
  }, []);
  // After a test send, look for the phone's "Got it" tap every 5 seconds, for up to 15 minutes.
  const [watching, setWatching] = useState(false);
  useEffect(() => {
    if (!watching) return;
    const stop = setTimeout(() => setWatching(false), 15 * 60_000);
    const every = setInterval(() => {
      void api<NotifySettings>("/api/notification-settings").then((s) => {
        setSaved((prev) => (prev ? { ...prev, phoneTest: s.phoneTest } : prev));
        if (s.phoneTest?.confirmedAt) setWatching(false);
      }, () => {});
    }, 5000);
    return () => (clearTimeout(stop), clearInterval(every));
  }, [watching]);
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
          phonePush: form.phonePush,
          publicUrl: form.publicUrl.trim() || null,
          approveButtons: form.approveButtons,
          phoneType: form.phoneType || null,
        },
      });
      setSaved(s);
      setForm(toForm(s, guess?.url));
      sv.markSaved(toForm(s, guess?.url));
      return "Saved.";
    });
  };
  const phoneAddress = saved?.phoneAddress ? saved.phoneAddress.replace(/\/+$/, "") : null;
  const test = () =>
    act(async () => {
      await api("/api/notification-settings/test", { method: "POST" });
      const s = await api<NotifySettings>("/api/notification-settings");
      setSaved((prev) => (prev ? { ...prev, phoneTest: s.phoneTest } : prev));
      setWatching(true);
      return `Your ntfy server accepted it. If it doesn't appear on the phone within a few seconds, check the phone app is subscribed at ${phoneAddress ?? "the ntfy address (the NTFY_BASE_URL line in your .env file)"}.`;
    });
  const copyAddress = () => {
    if (!phoneAddress) return;
    const failed = () => setNote({ ok: false, text: "Couldn't copy. Select the address and copy it by hand." });
    // navigator.clipboard is missing on plain http and in some browsers.
    if (!navigator.clipboard) return failed();
    void navigator.clipboard.writeText(phoneAddress).then(() => setNote({ ok: true, text: "Address copied." }), failed);
  };
  const row = { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-end" } as const;
  const check = { display: "flex", gap: 6, alignItems: "center", minHeight: 32, fontSize: 14 } as const;

  return (
    <form className="card" onSubmit={save} style={{ display: "flex", flexDirection: "column", gap: 16 }} aria-labelledby="notify-settings-h">
      <h2 id="notify-settings-h" style={{ fontSize: 17, fontWeight: 600 }}>
        How you're told
      </h2>
      <MoreAbout lead="Choose how loudly Boss Man tells you about things, and whether it reaches your phone.">
        <li>Notes stay in this feed.</li>
        <li>Flags, pages and asks also show as browser notifications while Boss Man is open in a background tab. Turn these on with "Turn on browser notifications" at the top of this page.</li>
        <li>In quiet hours, each notification is one step quieter: pages and asks become flags, and flags become notes.</li>
        <li>Once an agent reaches its hourly number, the rest it sends that hour become notes.</li>
        <li>Nothing is dropped: every notification still lands in this feed.</li>
      </MoreAbout>

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
        {(saved?.phoneLogin?.available === true || form.phone) && <NtfySetupButton
          available={saved?.phoneLogin?.available === true}
          why={saved?.phoneLogin && !saved.phoneLogin.available ? saved.phoneLogin.why : undefined}
          onDone={() => {
            // The server has saved the address, topic and token. Take them in, and keep whatever else is being edited.
            void apiOnce<NotifySettings>("/api/notification-settings").then((s) => {
              setSaved(s);
              setForm((f) => (f ? { ...f, phone: !!s.ntfy, url: s.ntfy?.url ?? f.url, topic: s.ntfy?.topic ?? f.topic, token: "", clearToken: false } : f));
            }, () => {});
          }}
        />}
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
            <div className="field" style={{ maxWidth: 360 }}>
              <label htmlFor="phone-type">My phone</label>
              <select id="phone-type" value={form.phoneType} onChange={(e) => set({ phoneType: e.target.value === "android" || e.target.value === "iphone" || e.target.value === "both" ? e.target.value : "" })}>
                <option value="">Not said yet (show both)</option>
                <option value="android">Android</option>
                <option value="iphone">iPhone</option>
                <option value="both">Both</option>
              </select>
            </div>
            <div className="field" style={{ maxWidth: 360 }}>
              <label htmlFor="phone-push">Send to my phone</label>
              <select id="phone-push" value={form.phonePush} onChange={(e) => set({ phonePush: e.target.value === "all" ? "all" : "urgent" })}>
                <option value="urgent">Urgent only (default)</option>
                <option value="all">All decisions</option>
              </select>
            </div>
            <p className="muted" style={{ fontSize: 14, margin: 0 }}>
              Urgent means a deploy that carries the fix for a live problem, a page such as "server unusable", a card the CEO marked urgent because you must act now, or the test button. A card that only holds up a ticket does not push, and a settled card is cleared from your phone if your ntfy server is 2.14 or newer. Urgent pushes go at the top priority (5), which can break through Do Not Disturb on Android once you switch that on in ntfy (see the note by the test button). With All decisions, routine ones go at the normal priority (3). Everything stays on the Decisions and Notifications pages either way.
            </p>
            <label style={check}>
              <input type="checkbox" checked={form.pushLevels.includes("flag")} onChange={(e) => set({ pushLevels: e.target.checked ? [...form.pushLevels, "flag"] : form.pushLevels.filter((x) => x !== "flag") })} />
              Also send flags (normal priority)
            </label>
            <div className="field">
              <label htmlFor="public-url">Boss Man's address on your phone, so a tap opens the evidence</label>
              <input id="public-url" type="url" placeholder="https://bossman.your-tailnet.ts.net" value={form.publicUrl} onChange={(e) => set({ publicUrl: e.target.value })} spellCheck={false} />
              {guess && !saved?.publicUrl && (
                <span className="muted" style={{ fontSize: 13 }} data-testid="public-url-note">
                  {guess.note}
                </span>
              )}
            </div>
            <label style={check}>
              <input type="checkbox" checked={form.approveButtons} onChange={(e) => set({ approveButtons: e.target.checked })} />
              Offer an Approve button on simple agent questions
            </label>
            {saved?.approve && (
              <p className="muted" style={{ fontSize: 14 }} aria-live="polite">
                {saved.approve.on ? "Phone Approve: on. Simple agent questions get an Approve button that answers with the agent's recommendation." : `Phone Approve: off because ${saved.approve.why}. Every push still gets an Open in Boss Man button.`}
              </p>
            )}
          </>
        )}
      </fieldset>

      {saved?.ntfy && (
        <section aria-labelledby="phone-setup-h" style={{ border: "1px solid var(--border, #8884)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 8 }}>
          <h3 id="phone-setup-h" style={{ fontSize: 15, fontWeight: 600 }}>
            Set up your phone
          </h3>
          {phoneAddress ? (
            <>
              <p style={{ fontSize: 14 }}>In the ntfy app on your phone, the server address must be exactly:</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <code data-testid="phone-address" style={{ fontSize: 14, wordBreak: "break-all" }}>
                  {phoneAddress}
                </code>
                <button className="btn" type="button" onClick={copyAddress}>
                  Copy address
                </button>
              </div>
            </>
          ) : (
            <p className="error" style={{ fontSize: 14 }}>
              Boss Man can't work out the address your phone needs. Look for the NTFY_BASE_URL line in the .env file on your host: that https address is the one to use. (This page shows it once the host reports it, which can take a minute after the add-on is set up.)
            </p>
          )}
          <ol style={{ fontSize: 14, margin: 0, paddingLeft: 20 }}>
            <li>Tick "Use another server" in the ntfy app, and enter the address above. It is not Boss Man's own address: leaving off the port reaches Boss Man, not ntfy.</li>
            <li>Subscribe to the topic shown above: {form.topic ? <code>{form.topic}</code> : "the Topic"}.</li>
            <li>In the ntfy app, Settings → Users → Add user: Service URL is the address above, Username and Password are the phone's read-only ntfy user (not the publish access token Boss Man uses).</li>
            <li>
              No phone login yet? Let Boss Man make it: it creates a read-only ntfy user for the topic above and shows you the password once.
              <PhoneLoginButton available={saved?.phoneLogin?.available === true} why={saved?.phoneLogin && !saved.phoneLogin.available ? saved.phoneLogin.why : undefined} />
            </li>
            <li>
              Or do it by hand. Run these on the host that runs ntfy, in a terminal. They are fine as your normal user if it may use Docker; otherwise put <code>sudo</code> in front of each (on TrueNAS, Proxmox and most Linux hosts that means root).
              {!saved?.phoneContainer && <> Boss Man can't see the ntfy container's name, so replace <code>NTFY_CONTAINER</code> with the name that <code>docker ps</code> shows for ntfy.</>}
              <pre data-testid="phone-login-commands" style={{ fontSize: 13, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: "4px 0" }}>{
`docker exec -it ${saved?.phoneContainer ?? "NTFY_CONTAINER"} ntfy user add phone-read
docker exec ${saved?.phoneContainer ?? "NTFY_CONTAINER"} ntfy access phone-read ${form.topic || "YOUR_TOPIC"} read-only`}</pre>
              The first command asks you to type a password for the phone: use a long one, and use it in the ntfy app. To reset it later: <code>{`docker exec -it ${saved?.phoneContainer ?? "NTFY_CONTAINER"} ntfy user change-pass phone-read`}</code>
            </li>
          </ol>
          {phoneAddress && (
            <p style={{ fontSize: 14 }}>
              To check the phone can reach ntfy, open{" "}
              <a href={`${phoneAddress}/v1/health`} target="_blank" rel="noreferrer">
                {phoneAddress}/v1/health
              </a>{" "}
              in the phone's browser. It should show <code>{`{"healthy":true}`}</code>. If it doesn't load, the phone isn't on your tailnet.
            </p>
          )}
        </section>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <SaveButton {...sv} busy={busy} />
        {saved?.ntfy && (
          <button className="btn" type="button" disabled={busy} onClick={() => void test()}>
            Send a test to my phone
          </button>
        )}
      </div>
      {saved?.ntfy && form.phoneType !== "android" && (
        <p className="muted" data-testid="phone-iphone-note" style={{ fontSize: 14, margin: 0 }}>
          On an iPhone, turn on Time Sensitive Notifications for ntfy (Settings → Notifications → ntfy) and add ntfy to each Focus's allowed apps. Urgent pushes may still not ring through Focus or the silent switch, so test once with a Focus on.{" "}
          <a href="https://github.com/Leonfinn/Boss_Man/blob/main/apps/site/src/guides/phone-notifications.md#iphone" target="_blank" rel="noreferrer">
            Phone notifications guide: iPhone
          </a>
        </p>
      )}
      {saved?.ntfy && form.phoneType !== "iphone" && (
        <p className="muted" data-testid="phone-android-note" style={{ fontSize: 14, margin: 0 }}>
          On Android, urgent pushes only break through Do Not Disturb after you turn on "Override Do Not Disturb" once for ntfy's max-priority channel: ntfy app → Settings → Notifications → the max-priority channel → Override Do Not Disturb. Test once with Do Not Disturb on.
        </p>
      )}
      {saved?.ntfy && saved.phoneTest && (
        <p role="status" data-testid="phone-test-status" style={{ fontSize: 14 }}>
          {saved.phoneTest.confirmedAt
            ? `Phone confirmed at ${new Date(saved.phoneTest.confirmedAt).toLocaleString()}.`
            : `Last test: sent at ${new Date(saved.phoneTest.sentAt).toLocaleString()}, not confirmed on a phone. Tap "Got it" on the test notification to confirm.`}
        </p>
      )}
      {note && (
        <p role={note.ok ? "status" : "alert"} className={note.ok ? "muted" : "error"} style={{ fontSize: 14 }}>
          {note.text}
        </p>
      )}
    </form>
  );
}

type Status = "all" | "unread" | "read";
type Filters = { status: Status; level: NotifyLevel | "all"; company: string };
const NO_FILTERS: Filters = { status: "all", level: "all", company: "all" };
const FILTERS_KEY = "notifications-filters";
const NO_COMPANY = "none";
const LEVEL_PLURAL: Record<NotifyLevel, string> = { note: "Notes", flag: "Flags", page: "Pages", ask: "Asks" };

/** The choices kept for the browser session; anything unreadable falls back to All. */
function readFilters(): Filters {
  try {
    const s = JSON.parse(sessionStorage.getItem(FILTERS_KEY) ?? "null") as Partial<Filters> | null;
    if (s && typeof s === "object") {
      return {
        status: s.status === "unread" || s.status === "read" ? s.status : "all",
        level: s.level && s.level in LEVEL ? s.level : "all",
        company: typeof s.company === "string" && s.company ? s.company : "all",
      };
    }
  } catch {
    /* unreadable: use the default */
  }
  return NO_FILTERS;
}

const TYPE_TITLE: Record<NotifyLevel, string> = {
  ask: "Asks need your answer.",
  page: "Pages are urgent and also go to your phone.",
  flag: "Flags also show as a browser notification.",
  note: "Notes stay in this list.",
};
const LEGEND_ID = "nf-legend";
/** The server's default page, and the size "Show older" asks for. */
const NOTICE_PAGE = 50;

/** A chip's number: hidden at 0 or while the counts are unknown, "99+" above 99. */
function Count({ n, amber }: { n: number | undefined; amber?: boolean }) {
  if (!n) return null;
  return (
    <span className={`nf-count${amber ? " amber" : ""}`} aria-hidden="true">
      {n > 99 ? "99+" : n}
    </span>
  );
}

const unreadLabel = (name: string, n: number | undefined) => (n ? `${name}, ${n > 99 ? "more than 99" : n} unread` : name);

/** One row of toggle chips in three groups; a second press turns a chip off (BOS-1277). */
function FilterBar({ filters, companies, counts, unread, set }: { filters: Filters; companies: Company[]; counts: NoticeCounts | undefined; unread: number | undefined; set: (patch: Partial<Filters>) => void }) {
  const [help, setHelp] = useState(false);
  const sorted = [...companies].sort((a, b) => a.name.localeCompare(b.name));
  const showNone = filters.company === NO_COMPANY || (counts?.company[NO_COMPANY] ?? 0) > 0;
  const hideCompanies = sorted.length === 1 && !showNone;
  const many = sorted.length > 4;
  const reveal = (e: { currentTarget: HTMLElement }) => e.currentTarget.scrollIntoView?.({ inline: "nearest", block: "nearest" });
  const chip = (key: string, on: boolean, label: string, onClick: () => void, opts: { count?: number | undefined; amber?: boolean; title?: string; shown?: string } = {}) => (
    <button key={key} type="button" className="chip nf" aria-pressed={on} aria-label={unreadLabel(label, opts.count)} title={opts.title ?? (opts.shown && opts.shown !== label ? label : undefined)} onClick={onClick} onFocus={reveal}>
      {on && <span aria-hidden="true">✓ </span>}
      <span className="nf-name">{opts.shown ?? label}</span>
      <Count n={opts.count} amber={opts.amber} />
    </button>
  );
  const toggleStatus = (v: "unread" | "read") => set({ status: filters.status === v ? "all" : v });
  const toggleLevel = (v: NotifyLevel) => set({ level: filters.level === v ? "all" : v });
  const toggleCompany = (v: string) => set({ company: filters.company === v ? "all" : v });
  return (
    <div className="nf-wrap">
      <div className="nf-bar" role="search" aria-label="Filter notifications">
        <div className="nf-group" role="group" aria-label="Read or unread">
          {/* R43: the server's one unread figure, the sidebar badge's (notifications.unread), not a sum made here. */}
          {chip("unread", filters.status === "unread", "Unread", () => toggleStatus("unread"), { count: counts ? unread : undefined })}
          {chip("read", filters.status === "read", "Read", () => toggleStatus("read"))}
        </div>
        <div className="nf-group" role="group" aria-label="Type">
          {(["ask", "page", "flag", "note"] as const).map((v) => chip(v, filters.level === v, LEVEL_PLURAL[v], () => toggleLevel(v), { count: counts?.level[v], amber: v === "ask", title: TYPE_TITLE[v] }))}
          <button type="button" className="nf-help" aria-expanded={help} aria-controls={LEGEND_ID} aria-label="What the types mean" onClick={() => setHelp(!help)} onFocus={reveal}>
            ?
          </button>
        </div>
        {!hideCompanies && (
          <div className="nf-group" role="group" aria-label="Company">
            {many ? (
              <label className="chip nf nf-select" data-on={filters.company !== "all"}>
                <span className="nf-name">Company</span>
                <select aria-label="Company" value={filters.company} onChange={(e) => set({ company: e.target.value })}>
                  <option value="all">All companies</option>
                  {sorted.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                  <option disabled>──────────</option>
                  <option value={NO_COMPANY}>No company</option>
                </select>
              </label>
            ) : (
              <>
                {sorted.map((c) => chip(c.id, filters.company === c.id, c.name, () => toggleCompany(c.id), { count: counts?.company[c.id], title: c.name }))}
                {showNone && chip(NO_COMPANY, filters.company === NO_COMPANY, "No company", () => toggleCompany(NO_COMPANY), { count: counts?.company[NO_COMPANY] })}
              </>
            )}
          </div>
        )}
      </div>
      <p id={LEGEND_ID} className="nf-legend muted" hidden={!help}>
        <strong>Asks</strong> need your answer. <strong>Pages</strong> are urgent and also go to your phone. <strong>Flags</strong> also show as a browser notification. <strong>Notes</strong> stay in this list. The numbers count unread ones.
      </p>
    </div>
  );
}

export function Notifications({ feed, onChanged, companies = null, browserPermission, onEnableBrowser }: { feed: NoticeFeed | null; onChanged: () => void; companies?: Company[] | null; browserPermission?: NotificationPermission | "unsupported"; onEnableBrowser?: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(readFilters);
  // A remembered company that no longer exists goes back to All companies.
  const filters: Filters = companies && saved.company !== "all" && saved.company !== NO_COMPANY && !companies.some((c) => c.id === saved.company) ? { ...saved, company: "all" } : saved;
  const setFilters = (patch: Partial<Filters>) => {
    const next = { ...filters, ...patch };
    setSaved(next);
    try {
      sessionStorage.setItem(FILTERS_KEY, JSON.stringify(next));
    } catch {
      /* storage blocked: the choice lasts until the page reloads */
    }
  };
  const active = filters.status !== "all" || filters.level !== "all" || filters.company !== "all";

  const query = new URLSearchParams();
  if (filters.status !== "all") query.set("status", filters.status);
  if (filters.level !== "all") query.set("level", filters.level);
  if (filters.company !== "all") query.set("company", filters.company);
  const qs = query.toString();
  // With a filter on the page polls its own list, so older notices and new arrivals are matched by the server.
  const filtered = usePoll((signal) => (qs ? api<NoticeFeed>(`/api/notifications?${qs}`, { signal }) : Promise.resolve(null)), 10_000, `notifications-${qs}`);
  const last = useRef<Notice[]>([]);
  const loaded = active ? filtered.data?.items : feed?.items;
  if (loaded) last.current = loaded;
  const firstPage = loaded ?? (active ? last.current : []);
  // "Show older" (BOS-2276): the server pages by date, so look up the oldest shown row's time; a new filter starts again.
  const dates = useRef(new Map<string, string>());
  const older = useOlder(
    firstPage,
    NOTICE_PAGE,
    (id) => {
      const q = new URLSearchParams(qs);
      q.set("limit", String(NOTICE_PAGE));
      q.set("before", dates.current.get(id) ?? "");
      return api<NoticeFeed>(`/api/notifications?${q.toString()}`).then((r) => r.items);
    },
    qs,
  );
  const items = older.rows ?? firstPage;
  for (const n of items) dates.current.set(n.id, n.createdAt);
  const updating = active && !filtered.data && !filtered.error;

  const reload = () => {
    onChanged();
    filtered.reload();
  };
  const read = (body: { ids: string[] } | { all: true }) => void api("/api/notifications/read", { method: "POST", body }).then(reload, (err: Error) => setError(err.message));
  const unreadShown = items.filter((n) => !n.readAt);
  const clear = () => setFilters(NO_FILTERS);

  const summary = updating ? "Updating…" : `${older.canMore ? "Latest " : ""}${items.length} shown`;
  const neverAny = !active && feed && !items.length;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>Notifications</h1>
          <p className="sub">Everything Boss Man and the agents have told you, newest first, with where to look.</p>
        </div>
        {active
          ? unreadShown.length > 0 && (
              <button className="btn" type="button" onClick={() => read({ ids: unreadShown.map((n) => n.id) })}>
                Mark these read
              </button>
            )
          : (feed?.unread ?? 0) > 0 && (
              <button className="btn" type="button" onClick={() => read({ all: true })}>
                Mark all read
              </button>
            )}
      </header>
      {/* (BOS-1506) This button used to sit in the side menu; it shows here until the owner turns notifications on. */}
      {browserPermission === "default" && onEnableBrowser && (
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", margin: "0 0 12px" }}>
          <button className="btn" type="button" onClick={onEnableBrowser}>
            Turn on browser notifications
          </button>
          <span className="muted">Shows flags, pages and asks while Boss Man is open in a background tab.</span>
        </div>
      )}
      {browserPermission === "denied" && <p className="muted">Notifications are blocked in this browser.</p>}
      <RecentPhonePushes />
      {error && <p className="error">{error}</p>}
      {!neverAny && <FilterBar filters={filters} companies={companies ?? []} counts={feed?.counts} unread={feed?.unread} set={setFilters} />}
      {active && (
        <div role="status" className="nf-summary">
          <span className="muted">{summary}</span>
          <button type="button" className="btn small" onClick={clear}>
            Clear filters
          </button>
        </div>
      )}
      {active && filtered.error && !away(filtered.error) && (
        <p className="error" role="alert">
          Couldn't load notifications: {filtered.error.message}. Your filters are kept.{" "}
          <button type="button" className="btn small" onClick={filtered.reload}>
            Try again
          </button>
        </p>
      )}
      {neverAny && <p className="muted">Nothing yet. Decisions that need you, alerts and agents' notes will show here.</p>}
      {active && !updating && !filtered.error && !items.length && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start", margin: "16px 0" }}>
          <strong>No notifications match</strong>
          <span className="muted">Try another filter, or clear them to see everything.</span>
          <button type="button" className="btn" onClick={clear}>
            Clear filters
          </button>
        </div>
      )}
      {items.length > 0 && (
        <ul aria-busy={updating} style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
          {items.map((n) => (
            <Item key={n.id} n={n} onRead={(id) => read({ ids: [id] })} />
          ))}
        </ul>
      )}
      {!updating && <ShowOlder older={older} />}
      <SettingsForm />
      <AlertDestinations />
      <WeeklySummaryForm companies={companies} />
    </>
  );
}
