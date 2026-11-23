# syntax=docker/dockerfile:1.7
# Boss Man updater (BOS-941, plan: engineering/architecture/bos-941-updater-container-design): checks a signed release,
# downloads its images by digest and installs the new Claude pack. It talks to the Docker socket through a short allow-list
# (src/docker.ts) and answers one instruction on a private network. TypeScript is compiled in the first stage; the image runs
# only Node, the sigstore package and the compiled code. Build from the repository root:
#   docker build -f apps/updater/Dockerfile -t boss-man-updater .
FROM node:22-bookworm-slim AS build
RUN npm install -g --no-audit --no-fund pnpm@10.28.0
WORKDIR /app
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/updater/package.json apps/updater/
# Hard links, not copies: pnpm's copy can fail with EAGAIN on ZFS-backed Docker (TrueNAS).
RUN --mount=type=secret,id=extra_ca,required=false \
    if [ -s /run/secrets/extra_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/extra_ca npm_config_cafile=/run/secrets/extra_ca; fi \
 && pnpm install --frozen-lockfile --package-import-method=hardlink --filter "@boss-man/updater"
COPY tsconfig.base.json ./
COPY apps/updater/tsconfig.json apps/updater/tsconfig.build.json apps/updater/
COPY apps/updater/src apps/updater/src
RUN pnpm --filter @boss-man/updater build \
 # The run image needs only the production dependencies, in a plain node_modules folder (no pnpm store, no workspace links).
 && pnpm --filter @boss-man/updater deploy --prod --legacy /out

FROM node:22-bookworm-slim
WORKDIR /app
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/apps/updater/dist ./dist
COPY apps/updater/package.json ./
# The notice every published image carries (BOS-973).
COPY NOTICE /NOTICE
# The key folder is a volume the server reads; the state folder keeps the move's progress and the cached Sigstore root.
# Both are owned by uid 1000 so a new named volume copies that owner.
RUN mkdir -p /run/updater /state && chown 1000:1000 /run/updater /state
# Starts as root with only SETUID and SETGID (the compose file, 941b) so it can learn the Docker socket's group, then drops to
# uid 1000 itself (src/startup.ts) and stops if it cannot. A build that is run as uid 1000 directly also works.
# BOS-562: fail the build if the updater could not read a file it was given.
RUN bad="$(find /app \( ! -type l ! -readable \) -o \( -type d ! -executable \) 2>/dev/null | head -10)"; [ -z "$bad" ] || { echo "Files uid 1000 cannot read (fix the checkout: chmod go+r on tracked files):"; echo "$bad"; exit 1; }
# On Docker Desktop the socket's group is 0, so the updater runs as uid 1000 WITH group 0. Fail the build if group 0 could write
# any file the image ships (it would then be able to change the updater's own code).
RUN bad="$(find /app /NOTICE /run/updater /state ! -type l -group 0 -perm -g+w 2>/dev/null | head -10)"; [ -z "$bad" ] || { echo "Files group 0 could write (a Docker Desktop socket gives the updater group 0):"; echo "$bad"; exit 1; }
ENV NODE_ENV=production
CMD ["node", "dist/main.js"]
