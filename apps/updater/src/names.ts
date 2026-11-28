// BOS-2804: container names that follow the compose project. Kept apart from config.ts and spec.ts so both can use it.
/** `<project>-<base>` when a name project is set (UPDATER_NAME_PROJECT), else the bare, old fixed name. */
export const projectName = (project: string | null, base: string) => (project ? `${project}-${base}` : base);
