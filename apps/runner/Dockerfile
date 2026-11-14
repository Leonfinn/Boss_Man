# syntax=docker/dockerfile:1.7
# Boss Man runner: one per company. Build from the repository root:
#   docker build -f apps/runner/Dockerfile -t boss-man-runner .
#
# Ships the official, unmodified Claude Code from Anthropic's npm package, which installs
# the same native binary as the standalone installer
# (https://code.claude.com/docs/en/setup#install-with-npm). The Claude ACP adapter is
# pointed at it with CLAUDE_CODE_EXECUTABLE (R6). Codex comes with the codex-acp adapter.
# OpenCode (MIT) is the official opencode-ai npm package, unmodified, run as `opencode acp`.
# Updates inside the container are off: new versions arrive by rebuilding (R9), e.g. weekly,
# with scripts/update-runner.sh, which promotes a build only once its canary passes (R52):
#   docker run --rm --network none boss-man-runner:candidate node_modules/.bin/tsx src/canary-main.ts
#
# Licence note: Claude Code is "© Anthropic PBC. All rights reserved." Build this image
# yourself; don't publish images that contain it.
#
# Optional build secret "extra_ca": a CA bundle for networks with a TLS-inspecting proxy.
FROM node:22-bookworm-slim

# Tools agents expect in a workspace: git for code, ssh for SSH deploy targets, shellcheck for the checks CI runs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git openssh-client ca-certificates ripgrep curl jq shellcheck \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g --no-audit --no-fund pnpm@10.28.0

# Validation tools for compose files and CI workflows (BOS-1036), used by scripts/check-compose.sh from check-quick:
# the Docker CLI and the compose plugin, which only read files (`docker compose config -q`), and actionlint.
# NO daemon (dockerd, containerd and runc are not unpacked: only the `docker` client binary) and NO socket: nothing in
# this image can start a container, and no Docker socket is mounted into the runner. Exact versions, each download checked
# against a pinned SHA-256 (taken from the vendor's release on 9 Nov 2026) so a rebuild never changes them silently.
# To update: change the version and both hashes of the new release, rebuild with Build and update runners.
ARG DOCKER_CLI_VERSION=29.9.3
ARG COMPOSE_VERSION=5.7.0
ARG ACTIONLINT_VERSION=1.7.12
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) da=x86_64; aa=amd64; \
             docker_sha=3fb5d1f13014c18cc54945bc177c58a9056a482dada031e17d12cf2e6922c973; \
             compose_sha=7758048ad38e580f22559603312874fec8bb638d021a9e64182385fc17cc12a2; \
             actionlint_sha=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8;; \
      arm64) da=aarch64; aa=arm64; \
             docker_sha=1b27fd739378ef938401e81ce5afb73b7ad7432d4f598814a9ff5f826bb464d2; \
             compose_sha=15861535d14e26555736b49376c95e14bfd94285366c8446bfac7156a972e76f; \
             actionlint_sha=325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6;; \
      *) echo "unsupported architecture" >&2; exit 1;; \
    esac; \
    t="$(mktemp -d)"; \
    curl -fsSL --retry 3 -o "$t/docker.tgz" "https://download.docker.com/linux/static/stable/$da/docker-${DOCKER_CLI_VERSION}.tgz"; \
    curl -fsSL --retry 3 -o "$t/compose" "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-$da"; \
    curl -fsSL --retry 3 -o "$t/actionlint.tgz" "https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}/actionlint_${ACTIONLINT_VERSION}_linux_$aa.tar.gz"; \
    printf '%s  %s\n' "$docker_sha" "$t/docker.tgz" "$compose_sha" "$t/compose" "$actionlint_sha" "$t/actionlint.tgz" | sha256sum -c -; \
    tar -xzf "$t/docker.tgz" -C /usr/local/bin --strip-components=1 docker/docker; \
    tar -xzf "$t/actionlint.tgz" -C /usr/local/bin actionlint; \
    mkdir -p /usr/local/lib/docker/cli-plugins; \
    install -m 0755 "$t/compose" /usr/local/lib/docker/cli-plugins/docker-compose; \
    rm -rf "$t"; \
    docker --version; docker compose version; actionlint -version; \
    ! test -e /var/run/docker.sock

# Optional add-ons (docs/12), off unless asked for: --build-arg RUNNER_ADDONS=agent-browser,webkit.
# Boss Man works the same without them; a skill that needs one is only given to runs once the
# runner reports it healthy. The image lists what it holds in /etc/bossman-addons.
# agent-browser drives Debian's chromium (security updates via apt) instead of downloading one;
# the pin must match packages/shared/src/addons.ts (checked by a test).
ARG RUNNER_ADDONS=""
ARG AGENT_BROWSER_VERSION=0.39.0
# webkit: Playwright's WebKit build (Safari's engine) and the libraries it needs, in a shared folder the
# node user can read. It is Playwright's own download; Debian has no WebKit package Playwright can drive.
ARG PLAYWRIGHT_VERSION=1.64.1
RUN --mount=type=secret,id=extra_ca,required=false \
    set -e; : > /etc/bossman-addons; \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi; \
    case ",$RUNNER_ADDONS," in *,agent-browser,*) \
      apt-get update && apt-get install -y --no-install-recommends chromium fonts-liberation && rm -rf /var/lib/apt/lists/*; \
      npm install -g --no-audit --no-fund "agent-browser@${AGENT_BROWSER_VERSION}"; \
      agent-browser --version; \
      echo "agent-browser@${AGENT_BROWSER_VERSION}" >> /etc/bossman-addons;; \
    esac; \
    case ",$RUNNER_ADDONS," in *,webkit,*) \
      npm install -g --no-audit --no-fund "playwright@${PLAYWRIGHT_VERSION}"; \
      PLAYWRIGHT_BROWSERS_PATH=/ms-playwright playwright install --with-deps webkit; \
      chmod -R a+rX /ms-playwright; \
      playwright --version; \
      echo "webkit@${PLAYWRIGHT_VERSION}" >> /etc/bossman-addons;; \
    esac
# The container is the sandbox (agents already run shell commands in it); Chromium's own sandbox
# needs privileges the runner doesn't have. Both are ignored when the add-on isn't installed.
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    AGENT_BROWSER_ARGS=--no-sandbox \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_PATH=/usr/local/lib/node_modules

# Harness versions are pinned to exact versions so a rebuild never silently changes
# behaviour. To update: check the new version (npm view <package> version), change the
# number here, rebuild with Settings > Server and runner > Updates > Build and update runners,
# and confirm it in server_status (runners show their harness versions).
ARG CLAUDE_CODE_VERSION=2.1.316
ARG OPENCODE_VERSION=1.19.3
# Check worker image (DR-060): build with --build-arg WITH_HARNESS=0 to leave out Claude Code and OpenCode. A worker only
# runs checks, never an agent, so it needs neither, and the image then holds no Anthropic code (it can be published, DR-050).
# The default (1) builds the runner exactly as before. The CLAUDE_CODE_EXECUTABLE path below then points at nothing, which is harmless: no agent run starts on a worker.
ARG WITH_HARNESS=1
USER node
ENV HOME=/home/node \
    NPM_CONFIG_PREFIX=/home/node/.npm-global \
    PATH=/home/node/.npm-global/bin:$PATH
RUN --mount=type=secret,id=extra_ca,uid=1000,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi \
 && if [ "$WITH_HARNESS" = 1 ]; then \
      npm install -g --no-audit --no-fund "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
   && npm install -g --no-audit --no-fund "opencode-ai@${OPENCODE_VERSION}" \
   && claude --version && opencode --version; \
    else ! command -v claude && ! command -v opencode; fi
# Claude Code keeps its session transcripts here; it's a volume so a recovery run can reopen
# an interrupted session after the container is recreated (R42).
ENV CLAUDE_CODE_EXECUTABLE=/home/node/.npm-global/bin/claude \
    CLAUDE_CONFIG_DIR=/home/node/.claude \
    DISABLE_UPDATES=1 \
    DISABLE_AUTOUPDATER=1 \
    OPENCODE_DISABLE_AUTOUPDATE=1

WORKDIR /home/node/app
COPY --chown=node pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY --chown=node packages/shared/package.json packages/shared/
COPY --chown=node apps/runner/package.json apps/runner/
# Hard links, not copies: pnpm's copy can fail with EAGAIN on ZFS-backed Docker (TrueNAS).
RUN --mount=type=secret,id=extra_ca,uid=1000,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi \
 && pnpm install --frozen-lockfile --package-import-method=hardlink --prod --filter "@boss-man/runner..."
COPY --chown=node packages/shared/src packages/shared/src
COPY --chown=node apps/runner/src apps/runner/src
# The check line's one copy of the queue rules (BOS-614): agents' checks and the merge gate wait for a check slot through
# this file, not through the copy in the branch being checked. Root-owned, so no session can change it; a new copy goes
# live with "Build and update runners".
COPY --chmod=0755 scripts/check-slot.sh /usr/local/lib/bossman/check-slot.sh
ENV BOSSMAN_CHECK_SLOT=/usr/local/lib/bossman/check-slot.sh
# The merge line's secrets and private-details scan (BOS-979): the runner runs this copy, and its allow-list, over a branch's
# added lines before the branch's own check command starts, so a branch can't remove or weaken it. The owner's list is
# handed to it in a private file the branch never sees. Same rule as above: a new copy goes live with "Build and update runners".
COPY --chmod=0755 scripts/scan-added-lines.mjs /usr/local/lib/bossman/scan-added-lines.mjs
COPY --chmod=0644 scripts/scan-allow.txt /usr/local/lib/bossman/scan-allow.txt
ENV BOSSMAN_SCAN_SCRIPT=/usr/local/lib/bossman/scan-added-lines.mjs

# The notice every published image carries (BOS-973).
COPY NOTICE /NOTICE

# Workspaces (one directory per ticket) and the event journal live on volumes, so a
# restart replays unacknowledged events and keeps work in progress (R31).
RUN mkdir -p /home/node/workspaces /home/node/runner-data /home/node/.claude /home/node/.local/share/opencode
VOLUME ["/home/node/workspaces", "/home/node/runner-data", "/home/node/.claude", "/home/node/.local/share/opencode"]

WORKDIR /home/node/app/apps/runner
ARG BOSSMAN_IMAGE_VERSION=dev
# The git commit the image is built from (BOS-764), so Boss Man can tell whether it already has a change.
# Empty when built outside a git checkout; the runner then reports none.
ARG BOSSMAN_IMAGE_COMMIT=
ENV NODE_ENV=production BOSSMAN_IMAGE_VERSION=${BOSSMAN_IMAGE_VERSION} BOSSMAN_IMAGE_COMMIT=${BOSSMAN_IMAGE_COMMIT}
# Healthy while the runner holds a live connection to the server.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD test -f /home/node/runner-data/connected && test $(( $(date +%s) - $(stat -c %Y /home/node/runner-data/connected) )) -lt 90
CMD ["node_modules/.bin/tsx", "src/main.ts"]
