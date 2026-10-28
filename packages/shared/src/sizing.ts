// Task sizing (docs/19-workflow-retros.md part 6): a relative size set by whoever creates the task.
export const TASK_SIZES = [1, 2, 3, 5, 8] as const;
export type TaskSize = (typeof TASK_SIZES)[number];
export const isTaskSize = (n: unknown): n is TaskSize => TASK_SIZES.includes(n as TaskSize);
/** For error text: the scale, in words. */
export const SIZE_SCALE = "1, 2, 3, 5 or 8";
