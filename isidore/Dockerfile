# syntax=docker/dockerfile:1
# isidore: a small web service that spawns isolated Pi coding-agent tasks.
# It needs both Node (to run `pi`) and Python (to run the service).
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

# Bake a Pi config dir with pi-web-access pre-installed; the entrypoint seeds
# the writable state dir from it. Spawned tasks share this config.
RUN install -d -m 0755 /opt/pi-config \
 && HOME=/root PI_CODING_AGENT_DIR=/opt/pi-config pi install "npm:${PI_WEB_PACKAGE}" \
 && rm -rf /opt/pi-config/sessions /opt/pi-config/web-search-cache \
 && printf '%s %s' "${PI_VERSION}" "${PI_WEB_PACKAGE}" >/opt/pi-config/.seed

COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
WORKDIR /opt/isidore
# uv makes .venv/bin/python a symlink to the interpreter it manages. Its
# default location is $HOME/.local/share/uv/python, i.e. /root here, which is
# mode 0700: the runtime user (1000) could then not exec the console script
# (`exec: isidore: Permission denied`). Keep the interpreter in /opt.
ENV UV_PYTHON_INSTALL_DIR=/opt/python \
    UV_PYTHON_DOWNLOADS=automatic \
    UV_PYTHON=3.12 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/isidore/.venv
COPY pyproject.toml ./
RUN uv sync --no-dev --no-install-project
COPY isidore ./isidore
RUN uv sync --no-dev --no-editable

# Fail the build if the venv is not usable by the runtime user (rather than
# only at `docker compose up`).
RUN chmod -R a+rX /opt/python \
 && setpriv --reuid 1000 --regid 1000 --clear-groups \
      /opt/isidore/.venv/bin/python -c 'import isidore.app'

COPY --chmod=0755 entrypoint.sh /usr/local/bin/isidore-entry

ENV PATH=/opt/isidore/.venv/bin:$PATH \
    HOME=/state/home \
    PI_CODING_AGENT_DIR=/state/pi \
    ISIDORE_STATE=/state \
    ISIDORE_HOST=0.0.0.0 \
    ISIDORE_PORT=8920

EXPOSE 8920
USER 1000:1000
ENTRYPOINT ["/usr/local/bin/isidore-entry"]
CMD ["isidore"]
