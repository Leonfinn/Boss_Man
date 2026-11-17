// Entry for plan-header-layout.test.ts: mounts the real Plan page against a stubbed fetch.
import { createRoot } from "react-dom/client";
import { Plan } from "../../src/pages/Plan";

const node = (id: string, ref: string, layer: number, blocked: boolean, causes: string[], holdingUp: number) => ({
  id, kind: "ticket", ref, title: `Task ${ref}`, state: blocked ? "blocked" : "in_progress", open: true, link: `#/ticket/${id}`, assignee: null, project: "App", layer, blocked, causes, holdingUp,
});
const plan = {
  nodes: [node("t1", "ACM-1", 0, false, [], 1), node("t2", "ACM-2", 1, true, ["t1"], 0)],
  edges: [{ id: "e1", from: "t1", to: "t2" }],
  columns: [["t1"], ["t2"]],
};
window.fetch = (async () => new Response(JSON.stringify(plan), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

const company = { id: "c1", name: "App Co", mission: null, paused: false, ticketPrefix: "ACM", agents: [] };
createRoot(document.getElementById("root")!).render(
  <div className="app"><main><Plan companies={[company] as never} companyId="c1" go={() => {}} /></main></div>,
);
