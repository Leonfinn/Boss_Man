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

# dist/migrate.js: the separate migration step (`node dist/migrate.js`). dist/main.js: the server itself (BOS-410 step 3),
# plain JS so the running server carries no tsx loader thread or transform cache. Bundled here so the runtime image
# needs no build tools. npm packages stay external (loaded from node_modules); the workspace's shared package is TS
# source, so it is bundled in through the alias.
FROM node:22-bookworm-slim AS bundle
RUN npm install -g --no-audit --no-fund esbuild@0.28.2
WORKDIR /app
COPY packages/shared/src packages/shared/src
COPY apps/server/src apps/server/src
WORKDIR /app/apps/server
RUN esbuild src/migrate.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/migrate.js \
 && esbuild src/main.ts --bundle --platform=node --format=esm --packages=external \
      --alias:@boss-man/shared=../../packages/shared/src/index.ts --outfile=dist/main.js

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
COPY --from=bundle /app/apps/server/dist apps/server/dist
# The notice every published image carries (BOS-973).
COPY NOTICE /NOTICE

# Where the launcher's key volume is mounted (R55). Owned by uid 1000 here too, so the volume
# is created writable for the launcher whichever container starts first.
RUN mkdir -p /run/launcher && chown node:node /run/launcher

USER node
# BOS-562: the build fails if the server could not read a file it was given (a checkout made under umask 077 has mode 600 files).
RUN bad="$(find /app \( ! -type l ! -readable \) -o \( -type d ! -executable \) 2>/dev/null | head -10)"; [ -z "$bad" ] || { echo "Files user node cannot read (fix the checkout: chmod go+r on tracked files):"; echo "$bad"; exit 1; }
WORKDIR /app/apps/server
# The commit this image was built from, shown by /api/health (docker build --build-arg BOSSMAN_COMMIT=<sha>).
ARG BOSSMAN_COMMIT=dev
ENV NODE_ENV=production PORT=3100 BOSSMAN_WEB_DIR=/app/web BOSSMAN_COMMIT=$BOSSMAN_COMMIT
# BOS-410: the live server held 5-15 GiB in glibc's main [heap] (brk) while V8's heap and Buffers were ~100 MiB.
# glibc raises its mmap threshold up to 32 MiB after freeing big blocks, so later Buffer bursts land in brk, and
# brk only shrinks from the top: one small live block above them pins the lot. A fixed threshold keeps every
# block of 128 KiB or more in its own mapping, handed back on free (local repro: 1030 MiB -> 52 MiB rss).
# If memory is really held, it then shows as other anonymous maps in the memory log instead of [heap].
# Undo: redeploy the previous image (any explicit value also turns glibc's dynamic threshold off, so it can't be "unset" from compose).
ENV MALLOC_MMAP_THRESHOLD_=131072
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# node itself runs the server (never a wrapper CLI such as tsx's, which forwards only SIGINT/SIGTERM), so the
# blue/green handover signals (SIGUSR1/SIGUSR2, leader.ts) arrive.
# Undo without a rebuild (BOS-410): the source is still in the image, so a compose `command:` override of
# ["node", "--import", "tsx", "src/main.ts"] runs it the old way.
CMD ["node", "dist/main.js"]
