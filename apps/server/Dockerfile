# syntax=docker/dockerfile:1.7
# Boss Man server. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t boss-man-server .
# The web UI is built in its own stage; only its static files reach the server image.
# pnpm hard-links packages from its store: its default copy can fail with EAGAIN when
# Docker's layers sit on ZFS, as they do on TrueNAS SCALE.
FROM node:22-bookworm-slim AS web
RUN npm install -g --no-audit --no-fund pnpm@10.28.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi \
 && pnpm install --frozen-lockfile --package-import-method=hardlink --filter "@boss-man/web..."
COPY tsconfig.base.json ./
COPY apps/web apps/web
COPY packages/shared packages/shared
COPY assets/brand assets/brand
RUN pnpm --filter @boss-man/web build

# dist/migrate.js: the separate migration step (`node dist/migrate.js`). Bundled here so the runtime image needs no build tools.
FROM node:22-bookworm-slim AS migrate
RUN npm install -g --no-audit --no-fund esbuild@0.28.2
WORKDIR /app/apps/server
COPY apps/server/src/migrate.ts src/migrate.ts
COPY apps/server/src/db/migrate-lib.ts src/db/migrate-lib.ts
RUN esbuild src/migrate.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/migrate.js

FROM node:22-bookworm-slim

RUN npm install -g --no-audit --no-fund pnpm@10.28.0
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi \
 && pnpm install --frozen-lockfile --package-import-method=hardlink --prod --filter "@boss-man/server..."

COPY packages/shared/src packages/shared/src
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
COPY --from=web /app/apps/web/dist /app/web
COPY --from=migrate /app/apps/server/dist apps/server/dist

# Where the launcher's key volume is mounted (R55). Owned by uid 1000 here too, so the volume
# is created writable for the launcher whichever container starts first.
RUN mkdir -p /run/launcher && chown node:node /run/launcher

USER node
WORKDIR /app/apps/server
# The commit this image was built from, shown by /api/health (docker build --build-arg BOSSMAN_COMMIT=<sha>).
ARG BOSSMAN_COMMIT=dev
ENV NODE_ENV=production PORT=3100 BOSSMAN_WEB_DIR=/app/web BOSSMAN_COMMIT=$BOSSMAN_COMMIT
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node itself is PID 1, with tsx only as a loader: the tsx CLI runs the server as a child and forwards only
# SIGINT/SIGTERM, so the blue/green handover signals (SIGUSR1/SIGUSR2, leader.ts) would never arrive.
CMD ["node", "--import", "tsx", "src/main.ts"]
