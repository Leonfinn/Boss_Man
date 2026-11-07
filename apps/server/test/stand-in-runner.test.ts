// The shared stand-in runner (BOS-663): a request it has no reply for fails at once with an error naming the
// command, instead of leaving the server waiting out the request's timeout. Uses the real runner hub; the
// hub's connect, request and reply paths never touch the database, so none is opened.
import { describe, expect, it } from "vitest";
import { runnersService } from "../src/services/runners.js";
import { standInRunner } from "./helpers/stand-in-runner.js";

const RUNNER = "00000000-0000-4000-8000-000000000001";
const hub = () => runnersService(null as never, null as never);

describe("stand-in runner", () => {
  it("refuses a request it has no reply for at once, naming the command, long before the timeout", async () => {
    const runners = hub();
    const refused = standInRunner(runners, RUNNER, {});
    const started = Date.now();
    await expect(runners.request(RUNNER, (requestId) => ({ type: "addons.check", requestId }), 60_000)).rejects.toThrow("The test's stand-in runner has no reply for addons.check.");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(refused).toEqual(["addons.check"]);
  });

  it("answers the requests it is given and accepts one-way commands without counting them as refused", async () => {
    const runners = hub();
    const refused = standInRunner(runners, RUNNER, { "credential.check": { ok: true } });
    await expect(runners.request(RUNNER, (requestId) => ({ type: "credential.check", requestId }))).resolves.toEqual({ ok: true });
    expect(runners.send(RUNNER, { type: "run.cancel", runId: "00000000-0000-4000-8000-000000000002" })).toBe(true);
    expect(runners.send(RUNNER, { type: "permission.decide", runId: "00000000-0000-4000-8000-000000000002", requestId: "perm-1", verdict: "allow" })).toBe(true);
    expect(refused).toEqual([]);
  });
});
