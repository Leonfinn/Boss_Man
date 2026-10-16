import type { ReactNode } from "react";

/** An empty or status state: one illustration, a heading that says what it means, and what to do. */
export function State({ img, alt, title, children }: { img: string; alt: string; title: string; children?: ReactNode }) {
  return (
    <section className="state">
      <img src={img} alt={alt} />
      <h2>{title}</h2>
      {children}
    </section>
  );
}
