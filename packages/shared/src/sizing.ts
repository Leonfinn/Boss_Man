// Task sizing (docs/19-workflow-retros.md part 6): a relative size set by whoever creates the task.
export const TASK_SIZES = [1, 2, 3, 5, 8] as const;
export type TaskSize = (typeof TASK_SIZES)[number];
export const isTaskSize = (n: unknown): n is TaskSize => TASK_SIZES.includes(n as TaskSize);
/** For error text: the scale, in words. */
export const SIZE_SCALE = "1, 2, 3, 5 or 8";
/**
 * What a "point" is, in the owner's words (BOS-2708). One sentence pair so the Roadmap legend, the ticket's Size help,
 * the board card's Size tag and the docs (docs/19 part 6) say the same thing.
 */
export const POINTS_EXPLAINED =
  `Each ticket is sized ${SIZE_SCALE} points by how much work it is (1 is a small fix, 8 is the largest we allow in one ticket). ` +
  "A milestone's or project's points are the sizes of its tickets added up. A ticket with no size isn't counted yet; the CEO sizes it when planning.";
