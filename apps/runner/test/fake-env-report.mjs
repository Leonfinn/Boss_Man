#!/usr/bin/env node
// Reports, as one short line on stderr, which git-credential names it was started with (and one
// control name), so a test can see what a probe passes to the adapter without a huge env dump.
const CREDENTIAL = /^(GIT_TOKEN|GIT_USERNAME|GIT_PASSWORD|GIT_ASKPASS|GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG_COUNT|GIT_CONFIG_PARAMETERS|GIT_CONFIG_(GLOBAL|SYSTEM|KEY_\d+|VALUE_\d+)|GH_TOKEN|GITHUB_TOKEN|GITEA_TOKEN)$/;
process.stdin.once("data", () => {
  const found = Object.keys(process.env).filter((k) => CREDENTIAL.test(k));
  const control = process.env.ANTHROPIC_API_KEY ?? "missing";
  process.stderr.write(`gitnames=${found.sort().join(",")};control=${control}\n`);
  process.exit(1);
});
