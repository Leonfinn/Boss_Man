// Runner add-ons (docs/12): the image lists what it baked in as BOSSMAN_ADDONS="id@version,…".
// Each one's check proves it still runs; a failure only holds back the skills that need it.
import { execFile } from "node:child_process";
import { addonById, type AddonReport } from "@boss-man/shared";

export function installedAddons(list: string | undefined): Array<{ id: string; version: string }> {
  return (list ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const at = s.lastIndexOf("@");
      return at > 0 ? { id: s.slice(0, at), version: s.slice(at + 1) } : { id: s, version: "" };
    });
}

type Exec = (cmd: string, args: string[], timeoutMs: number) => Promise<void>;
const exec: Exec = (cmd, args, timeoutMs) => new Promise((resolve, reject) => execFile(cmd, args, { timeout: timeoutMs }, (err) => (err ? reject(err) : resolve())));

export async function checkAddons(list: string | undefined, run: Exec = exec): Promise<AddonReport[]> {
  return Promise.all(
    installedAddons(list).map(async ({ id, version }) => {
      const addon = addonById(id);
      if (!addon) return { id, version, ok: false, detail: "Boss Man doesn't know this add-on." };
      try {
        await run(addon.check[0]!, addon.check.slice(1), 30_000);
        return { id, version, ok: true };
      } catch (err) {
        return { id, version, ok: false, detail: String((err as Error).message ?? err).slice(0, 500) };
      }
    }),
  );
}
