import type { ReactNode } from "react";

/** Shown on a page that needs a company when there is none yet; the create form is on the Board page (BOS-1972). */
export function NoCompany({ children }: { children?: ReactNode }) {
  return (
    <p>
      You don't have a company yet. <a href="#/board">Create your first company</a>
      {children ?? "."}
    </p>
  );
}
