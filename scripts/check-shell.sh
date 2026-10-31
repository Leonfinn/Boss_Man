#!/usr/bin/env bash
# ShellCheck for every shell script CI checks. CI runs this; run it yourself before handing work in.
# A new script under scripts/ or skills/ goes on this list.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
shellcheck scripts/deploy.sh scripts/deploy.test.sh scripts/host-deployer.sh scripts/host-deployer.test.sh scripts/update-runner.sh scripts/update-runner.test.sh scripts/rebuild-live.sh scripts/rebuild-live.test.sh scripts/caddy-edge.test.sh scripts/backup-penpot.sh scripts/backup-penpot.test.sh scripts/restore-test.sh scripts/restore-test.test.sh skills/penpot/scripts/penpot.sh skills/penpot/scripts/penpot.test.sh skills/penpot/scripts/penpot.write.test.sh scripts/check-all.sh scripts/check-all.test.sh scripts/test-shell.sh
