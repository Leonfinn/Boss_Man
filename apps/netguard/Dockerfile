# syntax=docker/dockerfile:1.7
# Boss Man netguard (BOS-324): blocks a runner container's access to private networks.
# Started by the launcher inside the runner's network namespace; see netguard.sh. Build from the repository root:
#   docker build -f apps/netguard/Dockerfile -t boss-man-netguard:current .
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends nftables libc-bin gawk \
 && rm -rf /var/lib/apt/lists/*
COPY apps/netguard/netguard.sh /usr/local/bin/netguard.sh
# Root inside the container, but with only NET_ADMIN, no new privileges and a read-only filesystem (set by the launcher).
ENTRYPOINT ["/usr/local/bin/netguard.sh"]
