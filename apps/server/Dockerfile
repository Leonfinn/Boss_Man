# syntax=docker/dockerfile:1.7
# Boss Man server. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t boss-man-server .
# The web UI is built in its own stage; only its static files reach the server image.
FROM node:22-bookworm-slim AS web
RUN npm install -g --no-audit --no-fund pnpm@10.28.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi \
 && pnpm install --frozen-lockfile --filter "@boss-man/web..."
COPY apps/web apps/web
COPY assets/brand assets/brand
RUN pnpm --filter @boss-man/web build

FROM node:22-bookworm-slim

RUN npm install -g --no-audit --no-fund pnpm@10.28.0
WORKDIR /app

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi \
 && pnpm install --frozen-lockfile --prod --filter "@boss-man/server..."

COPY packages/shared/src packages/shared/src
COPY apps/server/src apps/server/src
COPY apps/server/drizzle apps/server/drizzle
COPY --from=web /app/apps/web/dist /app/web

USER node
WORKDIR /app/apps/server
ENV NODE_ENV=production PORT=3100 BOSSMAN_WEB_DIR=/app/web
EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:3100/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/main.ts"]
