#!/usr/bin/env bash
# The shell scripts' own tests (none needs Docker). CI and scripts/check-all.sh both run this; a new *.test.sh goes here.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
for t in scripts/deploy.test.sh scripts/host-deployer.test.sh scripts/update-runner.test.sh scripts/rebuild-live.test.sh scripts/backup-penpot.test.sh scripts/check-all.test.sh scripts/restore-test.test.sh skills/penpot/scripts/penpot.test.sh skills/penpot/scripts/penpot.write.test.sh apps/netguard/netguard.test.sh; do "$t"; done
