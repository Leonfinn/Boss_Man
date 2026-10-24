// An agent's face: the owner's uploaded picture, else its template's portrait
// (assets/brand/agents, Boss Man himself for the CEO), else its initials.
import { art } from "../brand";

const PORTRAITS = import.meta.glob<string>("../../../../assets/brand/agents/*.svg", { eager: true, query: "?url", import: "default" });

export type Face = { id: string; name: string; role: string; template?: string | null; duty?: string | null; avatarAt?: string | null };

export function portraitOf(a: Face): string | null {
  if (a.avatarAt) return `/api/agents/${a.id}/avatar?v=${Date.parse(a.avatarAt)}`;
  if (a.role === "ceo") return art.mark64;
  // Built-in agents hired without a template are known by their duty.
  const key = a.template ?? a.duty;
  return key ? (PORTRAITS[`../../../../assets/brand/agents/${key}.svg`] ?? null) : null;
}

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

export function Avatar({ agent, className = "", title }: { agent: Face; className?: string; title?: string }) {
  const src = portraitOf(agent);
  return src ? <img className={`avatar pic ${className}`} src={src} alt="" title={title} /> : (
    <span className={`avatar ${className}`} title={title} aria-hidden="true">
      {initials(agent.name)}
    </span>
  );
}
