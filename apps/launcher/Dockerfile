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
# The notice every published image carries (BOS-973).
COPY NOTICE /NOTICE
# The key folder is a volume shared with the server; owned by uid 1000 so a new volume is too.
RUN mkdir -p /run/launcher && chown 1000:1000 /run/launcher
# BOS-974: the image install keeps company data in a named volume mounted here; a new volume copies this folder's owner.
RUN mkdir -p /data /config && chown 1000:1000 /data
USER 1000:1000
# BOS-562: fail the build if the launcher could not read a file it was given.
RUN bad="$(find /app \( ! -type l ! -readable \) -o \( -type d ! -executable \) 2>/dev/null | head -10)"; [ -z "$bad" ] || { echo "Files uid 1000 cannot read (fix the checkout: chmod go+r on tracked files):"; echo "$bad"; exit 1; }
# BOS-974: on Docker Desktop the socket's group is 0, so the launcher runs as uid 1000 WITH group 0. Fail the build if group 0 could
# write any file the image ships (it would then be able to change the launcher's own code). /run/launcher, /data and /config are
# owned by uid 1000, not group 0, so they must not be group-0-writable either.
RUN bad="$(find /app /NOTICE /run/launcher /data /config ! -type l -group 0 -perm -g+w 2>/dev/null | head -10)"; [ -z "$bad" ] || { echo "Files group 0 could write (a Docker Desktop socket gives the launcher group 0):"; echo "$bad"; exit 1; }
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
