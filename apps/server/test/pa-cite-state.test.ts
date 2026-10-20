import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { openPglite } from "../src/db/client.js";
import { citeStateSize, markSearched, paService, remember } from "../src/services/pa.js";

it("forgets a run's cite state when the run ends", async () => {
  const { db, close } = await openPglite();
  const pa = paService(db, { notify: async () => undefined });
  const runId = randomUUID();
  const before = citeStateSize();
  remember(runId, `ticket ${randomUUID()}`);
  markSearched(runId);
  expect(citeStateSize()).toBe(before + 2);
  await pa.onRunEnded(runId, null);
  expect(citeStateSize()).toBe(before);
  await close();
});
