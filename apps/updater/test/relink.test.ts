// BOS-2717: a server made before the Install button existed (no updater link) is made again with the link by the updater itself.
import { afterEach, describe, expect, test } from "vitest";
import { relinkServer } from "../src/firststart.js";
import { NEW_COMMIT } from "./fake-daemon.js";
import { closeAll, setup } from "./swap-helpers.js";

afterEach(closeAll);

const writes = (calls: { method: string; path: string }[]) => calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${decodeURIComponent(c.path)}`);

describe("relinkServer", () => {
  test("a colour with no link is swapped for the same release with the link, no backup, no report", async () => {
    const s = await setup();
    const blue = s.daemon.containers.get("server-blue")!;
    blue.env = ["BOSSMAN_IMAGE_INSTALL=1"];
    blue.commit = NEW_COMMIT; // the same release: the fake gives a new colour NEW_COMMIT
    const notes = await relinkServer(s.deps, { done: false });
    expect(notes.join(" ")).toMatch(/Install button works/);
    expect(s.state.get().stage).toBe("done");
    expect(s.state.get().report).toBeNull();
    const green = s.daemon.containers.get("server-green")!;
    expect(green.env.some((e) => e.startsWith("BOSSMAN_UPDATER_URL=http://"))).toBe(true);
    expect(green.env.some((e) => e.startsWith("BOSSMAN_UPDATER_KEY_FILE="))).toBe(true);
    expect(green.labels["com.bossman.release"]).toBe("0.0.9");
    expect(writes(s.daemon.calls).some((x) => x.endsWith("/exec") || x.includes("-migrate"))).toBe(false);
  });

  test("a colour that already has the link is left alone", async () => {
    const s = await setup();
    s.daemon.containers.get("server-blue")!.env = ["BOSSMAN_IMAGE_INSTALL=1", "BOSSMAN_UPDATER_URL=http://updater:3200"];
    const before = s.daemon.calls.length;
    expect(await relinkServer(s.deps, { done: false })).toEqual([]);
    expect(writes(s.daemon.calls.slice(before))).toEqual([]);
  });

  test("a source install (no image-install flag) is left alone, and a failed try is not repeated in the same run", async () => {
    const s = await setup();
    expect(await relinkServer(s.deps, { done: false })).toEqual([]);
    s.daemon.containers.get("server-blue")!.env = ["BOSSMAN_IMAGE_INSTALL=1"];
    const tried = { done: true };
    expect(await relinkServer(s.deps, tried)).toEqual([]);
    expect(s.daemon.containers.has("server-green")).toBe(false);
  });
});
