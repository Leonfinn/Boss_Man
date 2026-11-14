// The storyboard: one entry per recorded scene. `caption` is the one-line text laid over the scene by build.mjs.
// Each `run` drives the real app through the pointer helpers in lib.mjs. Scenes that need data the seed does
// not have yet are left out until it does (see README.md).
export const scenes = [
  {
    id: "01-board",
    caption: "Your whole project on one board: every card is a task an AI agent is working on.",
    async run(d) {
      const { page } = d;
      await d.goto("board", ".board, [data-board], h1");
      await d.waitFor("text=Search across the docs");
      await d.click(page.getByRole("button", { name: /collapse|«/i }).first()).catch(() => {});
      await d.hold(1800);
      await d.smoothScroll(0, 100);
      await d.moveTo(page.getByText("Compress the home page images").first());
      await d.hold(1500);
      await d.moveTo(page.getByText("New home page layout").first());
      await d.hold(2500);
    },
  },
  {
    id: "02-agents",
    caption: "Meet the team: a CEO, developers, a designer, QA and a writer. Each agent has a role and a job.",
    async run(d) {
      const { page } = d;
      await d.goto("agents", "text=Iris - Developer");
      await d.hold(1500);
      await d.moveTo(page.getByText("Working on").first());
      await d.hold(1200);
      await d.smoothScroll(500, 1800);
      await d.hold(1500);
    },
  },
  {
    id: "03-runs",
    caption: "Every agent run is listed: who, what for, which model, what it cost. Open one to read along.",
    async run(d) {
      const { page } = d;
      await d.goto("runs", "text=Running now");
      await d.hold(1800);
      await d.moveTo(page.getByText("Fix the sign-up form on phones").first());
      await d.hold(1200);
      await d.moveTo(page.getByText("Add a pricing page").first());
      await d.hold(2000);
    },
  },
  {
    id: "04-merge-queue",
    caption: "Approved work is checked and merged in order, on its own. Nothing lands until it passes.",
    async run(d) {
      const { page } = d;
      await d.goto("merge-queue", "text=Waiting to merge");
      await d.hold(1800);
      await d.moveTo(page.getByText("Keyboard focus on the menu").first());
      await d.hold(1500);
      await d.moveTo(page.getByText("Favicon and app icon").first());
      await d.hold(2200);
    },
  },
  {
    id: "05-decisions-phone",
    phone: true,
    caption: "When an agent needs you, it asks with a recommended answer. Approve from your phone.",
    async run(d) {
      const { page } = d;
      await d.goto("decisions", "text=Approve the new home page design?");
      await d.hold(1500);
      const dismiss = page.getByRole("button", { name: "Dismiss" }).first();
      if (await dismiss.isVisible().catch(() => false)) await dismiss.tap();
      await d.hold(800);
      await d.smoothScroll(500, 1200);
      await d.hold(1500);
      // This really answers the decision in the throwaway database, so a retake needs a freshly seeded one.
      await d.tap(page.locator("li.decision", { hasText: "Approve the new home page design?" }).getByRole("button", { name: /^Approve/ }));
      await d.hold(2000);
    },
  },
  {
    id: "07-roadmap",
    caption: "A roadmap ties the work to your goals: objectives, milestones and features.",
    async run(d) {
      const { page } = d;
      await d.goto("roadmap", "text=Twice as many sign-ups by spring");
      await d.hold(1500);
      await d.click(page.getByRole("button", { name: /Show milestones/ }).first());
      await d.hold(3500);
    },
  },
];
