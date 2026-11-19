// Guards BOS-1894: every secret file docker-compose.yml names must be created in step 3 of docs/00-first-time-install.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { composeSecretFiles, missingFromGuide, stepThree } from "./check-compose-secrets-docs.mjs";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-compose-secrets-docs.mjs");

const compose = "secrets:\n  master_key:\n    file: ./secrets/master.key\n  runner_token:\n    file: ./secrets/runner-app-co.token\n";

test("finds the secret files compose names", () => {
  assert.deepEqual(composeSecretFiles(compose), ["master.key", "runner-app-co.token"]);
});

test("step three is cut at the next heading", () => {
  const guide = "## 2. a\nsecrets/other\n## 3. b\nsecrets/master.key\n## 4. c\nsecrets/late\n";
  assert.equal(stepThree(guide), "secrets/master.key\n");
});

test("reports a file the guide's step 3 leaves out, even if a later step names it", () => {
  const guide = "## 3. Make\nopenssl > secrets/master.key\n## 4. Write\ntouch secrets/runner-app-co.token\n";
  assert.deepEqual(missingFromGuide(compose, guide), ["runner-app-co.token"]);
  assert.deepEqual(missingFromGuide(compose, "## 3. Make\nsecrets/master.key secrets/runner-app-co.token\n## 4. x\n"), []);
});

test("this repo's compose file and install guide agree", () => {
  const r = spawnSync("node", [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});
