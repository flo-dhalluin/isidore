# syntax=docker/dockerfile:1
# isidore: a small web service that runs isolated Pi coding-agent tasks.
# It runs the Pi TypeScript SDK in-process per task (no `pi` CLI subprocess).
FROM node:24-bookworm-slim

ARG PI_VERSION
ARG PI_WEB_PACKAGE=pi-web-access

ENV DEBIAN_FRONTEND=noninteractive \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq less procps ripgrep fd-find unzip \
 && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

# The Pi CLI is still used by the entrypoint to bake/refresh the shared config
# (model catalog, pi-web-access).
RUN test -n "${PI_VERSION}" \
 && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force

# Bake a Pi config dir with pi-web-access pre-installed; the entrypoint seeds
# the writable state dir from it. Spawned tasks share this config.
RUN install -d -m 0755 /opt/pi-config \
 && HOME=/root PI_CODING_AGENT_DIR=/opt/pi-config pi install "npm:${PI_WEB_PACKAGE}" \
 && rm -rf /opt/pi-config/sessions /opt/pi-config/web-search-cache \
 && printf '%s %s' "${PI_VERSION}" "${PI_WEB_PACKAGE}" >/opt/pi-config/.seed

WORKDIR /opt/isidore
COPY package.json package-lock.json tsconfig.json ./
# Pin the SDK to the same release the image ships; install deps, then build.
RUN npm install --no-audit --no-fund \
 && npm install --no-audit --no-fund "@earendil-works/pi-coding-agent@${PI_VERSION}"
COPY src ./src
COPY templates ./templates
RUN npm run build && npm prune --omit=dev

COPY --chmod=0755 entrypoint.sh /usr/local/bin/isidore-entry

ENV NODE_ENV=production \
    HOME=/state/home \
    PI_CODING_AGENT_DIR=/state/pi \
    ISIDORE_STATE=/state \
    ISIDORE_HOST=0.0.0.0 \
    ISIDORE_PORT=8920 \
    ISIDORE_WORKER_SCRIPT=/opt/isidore/dist/worker.js

EXPOSE 8920
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/isidore-entry"]
CMD ["node", "dist/index.js"]
