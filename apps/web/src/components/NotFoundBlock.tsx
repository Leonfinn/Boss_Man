import type { ReactNode } from "react";

/** A missing item (old or wrong link): a heading, one plain sentence and a way back to the list (BOS-1125). */
export function NotFoundBlock({ title, children, backHref, backLabel, extra }: { title: string; children: ReactNode; backHref: string; backLabel: string; extra?: ReactNode }) {
  return (
    <section className="card not-found" role="alert" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12 }}>
      <h2 style={{ fontSize: 20, fontWeight: 600 }}>{title}</h2>
      <p className="muted">{children}</p>
      <a className="btn" href={backHref}>
        {backLabel}
      </a>
      {extra}
    </section>
  );
}
