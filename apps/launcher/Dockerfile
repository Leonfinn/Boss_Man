# syntax=docker/dockerfile:1.7
# Boss Man runner launcher (R55): starts and stops company runners with a fixed, locked-down
# spec. TypeScript is compiled in the first stage; the image runs only Node and its standard
# library. Build from the repository root:
#   docker build -f apps/launcher/Dockerfile -t boss-man-launcher .
FROM node:22-bookworm-slim AS build
RUN npm install -g --no-audit --no-fund pnpm@10.28.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/launcher/package.json apps/launcher/
# Hard links, not copies: pnpm's copy can fail with EAGAIN on ZFS-backed Docker (TrueNAS).
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi \
 && pnpm install --frozen-lockfile --package-import-method=hardlink --filter "@boss-man/launcher"
COPY tsconfig.base.json ./
COPY apps/launcher/tsconfig.json apps/launcher/tsconfig.build.json apps/launcher/
COPY apps/launcher/src apps/launcher/src
RUN pnpm --filter @boss-man/launcher build

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /app/apps/launcher/dist ./dist
COPY apps/launcher/package.json ./
# The key folder is a volume shared with the server; owned by uid 1000 so a new volume is too.
RUN mkdir -p /run/launcher && chown 1000:1000 /run/launcher
USER 1000:1000
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
