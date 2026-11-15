// What the runner is running on (DR-049 point 1). The kernel is the runner's own (a container shares the host's);
// the Docker version and OS type come from the launcher, which asks the Docker daemon and passes them in the
// runner's environment. A runner started by hand (compose) has no launcher, so those two say "unknown": the
// fingerprint still changes with the kernel, and the owner's choice is asked again then.
import { release } from "node:os";
import type { PlatformReport } from "@boss-man/shared";

const clean = (v: string | undefined, max: number) => {
  const s = (v ?? "").replace(/[^\x20-\x7e]/g, "").trim().slice(0, max);
  return s || "unknown";
};

export function platformReport(env: NodeJS.ProcessEnv = process.env, kernel: string = release()): PlatformReport {
  return { kernel: clean(kernel, 100), dockerVersion: clean(env.BOSSMAN_HOST_DOCKER, 60), osType: clean(env.BOSSMAN_HOST_OS, 40) };
}
