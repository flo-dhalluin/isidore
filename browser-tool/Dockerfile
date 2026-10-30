# syntax=docker/dockerfile:1.7
# Headless Firefox + geckodriver, driven by the browser-mcp server.
# Only the MCP endpoint (8931) is reachable from outside; geckodriver and
# Marionette stay on the container's loopback.
FROM ubuntu:resolute

ARG GECKODRIVER_VERSION=0.37.1
ARG GECKODRIVER_SHA256=e815130ea95983e162ae91843b48d3a3ce991735635fce83a647afde21e09f7e

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --chmod=0644 packages.mozilla.org.asc /etc/apt/keyrings/packages.mozilla.org.asc

COPY <<EOF /etc/apt/sources.list.d/mozilla.sources
Types: deb
URIs: https://packages.mozilla.org/apt
Suites: mozilla
Components: main
Signed-By: /etc/apt/keyrings/packages.mozilla.org.asc
EOF

COPY <<EOF /etc/apt/preferences.d/mozilla
Package: *
Pin: origin packages.mozilla.org
Pin-Priority: 1000
EOF

# Fonts matter for screenshots; python3 runs the MCP server.
RUN apt-get update && apt-get install -y --no-install-recommends \
      firefox python3 \
      fonts-dejavu-core fonts-liberation fonts-noto-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

ADD --checksum=sha256:${GECKODRIVER_SHA256} \
    https://github.com/mozilla/geckodriver/releases/download/v${GECKODRIVER_VERSION}/geckodriver-v${GECKODRIVER_VERSION}-linux64.tar.gz \
    /tmp/geckodriver.tar.gz
RUN tar -xzf /tmp/geckodriver.tar.gz -C /usr/local/bin geckodriver && rm /tmp/geckodriver.tar.gz

COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
WORKDIR /opt/browser-mcp
ENV UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/browser-mcp/.venv
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY browser_mcp ./browser_mcp
RUN uv sync --frozen --no-dev --no-editable

ENV PATH=/opt/browser-mcp/.venv/bin:$PATH \
    HOME=/tmp \
    TMPDIR=/tmp \
    BROWSER_MCP_HOST=0.0.0.0 \
    BROWSER_MCP_PORT=8931

EXPOSE 8931
USER ubuntu
CMD ["browser-mcp"]
