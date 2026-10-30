# syntax=docker/dockerfile:1
# Pi coding agent + pi-web-access. Runs read-only; writable state lives in the
# /state bind mount, seeded from /opt/pi-config by the entrypoint.
FROM node:24-bookworm-slim

ARG PI_VERSION
ARG PI_WEB_PACKAGE=pi-web-access

ENV DEBIAN_FRONTEND=noninteractive \
    PI_SKIP_VERSION_CHECK=1 \
    PI_TELEMETRY=0

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash ca-certificates curl git jq less procps ripgrep fd-find unzip python3 \
 && ln -sf "$(command -v fdfind)" /usr/local/bin/fd \
 && rm -rf /var/lib/apt/lists/*

RUN test -n "${PI_VERSION}" \
 && npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
 && npm cache clean --force

LABEL pi-sandbox.pi-version="${PI_VERSION}" \
      pi-sandbox.web-package="${PI_WEB_PACKAGE}"

# Bake a Pi config dir with pi-web-access pre-installed; .seed tells the
# entrypoint when the state dir needs re-seeding.
RUN install -d -m 0755 /opt/pi-config \
 && HOME=/root PI_CODING_AGENT_DIR=/opt/pi-config pi install "npm:${PI_WEB_PACKAGE}" \
 && HOME=/root PI_CODING_AGENT_DIR=/opt/pi-config pi list \
 && rm -rf /opt/pi-config/sessions /opt/pi-config/web-search-cache \
 && printf '%s %s' "${PI_VERSION}" "${PI_WEB_PACKAGE}" >/opt/pi-config/.seed

RUN install -d /state

COPY --chmod=0755 entrypoint.sh /usr/local/bin/pi-sandbox-entry

ENV PI_CODING_AGENT_DIR=/state \
    HOME=/tmp/home \
    NPM_CONFIG_UPDATE_NOTIFIER=false

USER 1000:1000
ENTRYPOINT ["/usr/local/bin/pi-sandbox-entry"]
CMD []
