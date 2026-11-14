// Entry for board-compact-cards-layout.test.ts: mounts the real Board page against a stubbed fetch.
import { createRoot } from "react-dom/client";
import { Board } from "../../src/pages/Board";

const LONG = "A very long title that goes on and on about many things so that it will not fit on two lines of a narrow board column at all, however wide it is";
const base = { systemState: "ready", outcome: null, assigneeAgentId: null, assignedToOwner: false, dueDate: null, blockedBy: [], branch: null, risk: null, planFirst: false, plan: null, planApprovedAt: null };
const tickets = [
  { ...base, id: "long", number: 1, title: LONG },
  { ...base, id: "short", number: 2, title: "Short" },
  { ...base, id: "waits", number: 3, title: "Short too", blockedBy: [{ ticketId: "x", ticketNumber: 9, ticketTitle: LONG, until: "merged", engagementId: null, decisionId: null }] },
];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
window.fetch = (async (url: string) => {
  if (String(url).endsWith("/projects")) return json([{ id: "p1", companyId: "c1", name: "App", repoUrl: null }]);
  if (String(url).endsWith("/board")) return json({ project: { id: "p1", companyId: "c1", name: "App" }, columns: [
    { id: "col1", name: "Ready", systemState: "ready", wipLimit: null, tickets },
    // Empty neighbours, so the first column is as narrow as on a real board.
    ...(["in_progress", "review", "blocked", "done"] as const).map((s) => ({ id: `col-${s}`, name: s, systemState: s, wipLimit: null, tickets: [] })),
  ] });
  return json([]);
}) as typeof fetch;

const company = { id: "c1", name: "App Co", mission: null, paused: false, ticketPrefix: "ACM", agents: [] };
createRoot(document.getElementById("root")!).render(<Board companies={[company]} projectId="p1" go={() => {}} onCompaniesChanged={() => {}} />);
