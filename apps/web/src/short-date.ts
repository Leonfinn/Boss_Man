/** A calendar day ("2026-12-01") as UTC milliseconds. */
export const dayOf = (d: string) => Date.parse(`${d}T00:00:00Z`);
/** A calendar day as the owner reads it: "1 Dec". Shared by the Roadmap, Features and the ticket page. */
export const short = (d: string) => new Date(dayOf(d)).toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
