#!/usr/bin/env node
// Fails when a secret file named in docker-compose.yml (`file: ./secrets/<name>`) is not created in step 3 of
// docs/00-first-time-install.md (BOS-1894). Compose refuses to start while such a file is missing, so a guide that
// leaves one out sends a newcomer into a compose error.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Files under ./secrets/ that the compose text names as a secret's `file:`. */
export function composeSecretFiles(compose) {
  return [...new Set([...compose.matchAll(/^\s*file:\s*\.\/secrets\/(\S+)\s*$/gm)].map((m) => m[1]))];
}

/** The text of step 3 of the install guide (from its "## 3." heading to the next "## " heading). */
export function stepThree(guide) {
  const m = /^## 3\.[^\n]*\n([\s\S]*?)(?=^## )/m.exec(guide + "\n## end\n");
  return m ? m[1] : "";
}

/** The secret files the guide's step 3 does not mention. */
export function missingFromGuide(compose, guide) {
  const step = stepThree(guide);
  return composeSecretFiles(compose).filter((f) => !step.includes(`secrets/${f}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = process.env.CHECK_COMPOSE_SECRETS_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const compose = readFileSync(path.join(repo, "docker-compose.yml"), "utf8");
  const guide = readFileSync(path.join(repo, "docs/00-first-time-install.md"), "utf8");
  const missing = missingFromGuide(compose, guide);
  if (missing.length) {
    console.error("check-compose-secrets-docs: docker-compose.yml names secret files that step 3 of docs/00-first-time-install.md does not create:");
    for (const f of missing) console.error(`  secrets/${f}`);
    process.exit(1);
  }
}
