import { useState } from "react";
import { tallestReading } from "@boss-man/shared";
import { api, type DeviceProfile } from "../../api";
import { usePoll } from "../../hooks";
import { collect } from "../../devices";
import { Loader } from "../../components/Loader";
import { LoadError } from "../../components/LoadError";
import { Section, useAction } from "./shared";

export function Devices() {
  const list = usePoll((signal) => api<DeviceProfile[]>("/api/devices", { signal }), 60_000, "devices");
  const act = useAction();
  const [names, setNames] = useState<Record<string, string>>({});
  const record = () =>
    void act.run(async () => {
      const report = await collect(window, document, navigator);
      const saved = await api<DeviceProfile>("/api/devices", { method: "POST", body: report });
      list.reload();
      return `${saved.label} recorded. Layout tickets that name this device are checked at these figures.`;
    });
  const rename = (p: DeviceProfile) =>
    void act.run(async () => {
      const label = (names[p.id] ?? p.label).trim();
      if (!label || label === p.label) return "No change.";
      const saved = await api<DeviceProfile>(`/api/devices/${p.id}`, { method: "PATCH", body: { label } });
      list.reload();
      return `Renamed to ${saved.label}.`;
    });
  const remove = (p: DeviceProfile) =>
    window.confirm(`Forget "${p.label}"? A layout ticket that names it will fall back to the normal phone and desktop checks.`) &&
    void act.run(async () => {
      await api(`/api/devices/${p.id}`, { method: "DELETE" });
      list.reload();
      return `Forgot ${p.label}.`;
    });
  const rows = list.data ?? [];
  return (
    <Section id="devices-h" title="Your devices">
      <p className="muted" style={{ fontSize: 14 }}>
        This browser can measure its own screen so a layout fix is checked at the real thing, not a guessed size. Open this page on each device you use, press Record, and the figures are kept here: width and height, pixel ratio, touch, standalone mode, and the real 100vh, 100dvh, 100svh and 100lvh heights. Only screen facts are stored; your devices are listed on this page, under Devices and privacy.
      </p>
      <button type="button" className="btn primary" onClick={record} disabled={act.busy} style={{ alignSelf: "flex-start" }}>
        {act.busy ? "Measuring…" : "Record this device"}
      </button>
      {act.view}
      {!list.data && list.error ? (
        <LoadError what="your devices" message={list.error.message} onRetry={list.reload} />
      ) : !list.data ? (
        <Loader label="Loading devices" />
      ) : rows.length === 0 ? (
        <p className="muted" style={{ fontSize: 14 }}>No devices recorded yet. Record this one, then the others you use.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {rows.map((p) => {
            const t = tallestReading(p);
            return (
              <div key={p.id} style={{ border: "1px solid var(--line, #333)", borderRadius: 8, padding: 12, display: "flex", flexDirection: "column", gap: 6 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input value={names[p.id] ?? p.label} onChange={(e) => setNames((n) => ({ ...n, [p.id]: e.target.value }))} style={{ flex: "1 1 220px" }} aria-label={`Name for ${p.label}`} />
                  <button type="button" className="btn" onClick={() => rename(p)} disabled={act.busy}>Rename</button>
                  <button type="button" className="btn" onClick={() => remove(p)} disabled={act.busy}>Forget</button>
                </div>
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>
                  {p.browser} · {t.width}×{t.height} CSS px · pixel ratio {t.pixelRatio} · {t.coarsePointer ? "touch" : "mouse"} · {t.displayMode}. 100vh {t.units.vh}, 100dvh {t.units.dvh}, 100svh {t.units.svh}, 100lvh {t.units.lvh}, visual viewport {t.units.visual} px. Reported {new Date(p.reportedAt).toLocaleString()}.
                </p>
              </div>
            );
          })}
        </div>
      )}
    </Section>
  );
}
