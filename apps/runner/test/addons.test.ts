import { describe, expect, it } from "vitest";
import { checkAddons, installedAddons } from "../src/addons.js";

describe("runner add-ons (docs/12)", () => {
  it("reads the image's list and reports each add-on's check", async () => {
    expect(installedAddons(undefined)).toEqual([]);
    expect(installedAddons(" agent-browser@0.39.0 , mystery ")).toEqual([{ id: "agent-browser", version: "0.39.0" }, { id: "mystery", version: "" }]);
    const ran: string[] = [];
    const ok = await checkAddons("agent-browser@0.39.0,mystery", async (cmd, args) => void ran.push([cmd, ...args].join(" ")));
    expect(ran).toEqual(["agent-browser --version"]);
    expect(ok).toEqual([
      { id: "agent-browser", version: "0.39.0", ok: true },
      { id: "mystery", version: "", ok: false, detail: "Boss Man doesn't know this add-on." },
    ]);
    const broken = await checkAddons("agent-browser@0.39.0", async () => {
      throw new Error("spawn agent-browser ENOENT");
    });
    expect(broken).toEqual([{ id: "agent-browser", version: "0.39.0", ok: false, detail: "spawn agent-browser ENOENT" }]);
  });
});
