# syntax=docker/dockerfile:1
# isidore: a small web service that runs isolated Pi coding-agent tasks.
# It runs the Pi TypeScript SDK in-process per task (no `pi` CLI subprocess).

# Build the Landlock launcher (isidore/sandbox) in a separate stage so the
# final image carries only the small static-ish binary, no toolchain.
FROM debian:trixie-slim AS sandbox-build
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends gcc make libc6-dev linux-libc-dev \
 && rm -rf /var/lib/apt/lists/*
COPY sandbox/ /src/sandbox/
RUN make -C /src/sandbox

FROM node:24-trixie-slim

ARG PI_WEB_PACKAGE=pi-web-access

ENV DEBIAN_FRONTEND=noninteractive \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq less procps ripgrep fd-find unzip \
 && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/isidore
# Copy the manifests first: the Pi SDK version is read from the lockfile, so the
# global CLI, the local SDK and the seeded config always match the pinned
# dependency — there is no separate version build arg to keep in sync.
COPY package.json package-lock.json ./

# The Pi CLI is still used by the entrypoint to bake/refresh the shared config
# (model catalog, pi-web-access); its version is whatever the lockfile pins.
RUN PI_VERSION="$(node -p 'require("./package-lock.json").packages["node_modules/@earendil-works/pi-coding-agent"].version')" \
 && test -n "$PI_VERSION" \
 && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force \
 && install -d -m 0755 /opt/pi-config \
 && HOME=/root PI_CODING_AGENT_DIR=/opt/pi-config pi install "npm:${PI_WEB_PACKAGE}" \
 && rm -rf /opt/pi-config/sessions /opt/pi-config/web-search-cache \
 && printf '%s %s' "${PI_VERSION}" "${PI_WEB_PACKAGE}" >/opt/pi-config/.seed

# npm ci installs exactly the lockfile, so the local SDK matches the global CLI.
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY templates ./templates
# Build stamp from launch.sh. Referencing it in the RUN below means a changed
# source tree always re-runs the build (even if COPY cache is stale), and the
# label lets the deploy verify the image it is about to run.
ARG ISIDORE_SOURCE=unknown
RUN echo "building isidore source ${ISIDORE_SOURCE}" \
 && npm run build \
 && npm prune --omit=dev
LABEL io.isidore.source="${ISIDORE_SOURCE}"

COPY --chmod=0755 entrypoint.sh /usr/local/bin/isidore-entry
COPY --from=sandbox-build /src/sandbox/isidore-sandbox /usr/local/bin/isidore-sandbox

# Pre-create the admin-token volume mountpoint owned by the runtime user so a
# fresh named volume (isidore-admin) inherits uid-1000 ownership.
RUN mkdir -p /state/shared && chown 1000:1000 /state/shared

ENV NODE_ENV=production \
    HOME=/state/home \
    PI_CODING_AGENT_DIR=/state/pi \
    ISIDORE_STATE=/state \
    ISIDORE_HOST=0.0.0.0 \
    ISIDORE_PORT=8920 \
    ISIDORE_SANDBOX_BIN=/usr/local/bin/isidore-sandbox \
    ISIDORE_WORKER_SCRIPT=/opt/isidore/dist/worker.js

EXPOSE 8920
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/isidore-entry"]
CMD ["node", "dist/index.js"]
