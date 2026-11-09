# syntax=docker/dockerfile:1
# scheduler: MCP tool server + REST API + firing loop. No browser, no Node.
FROM python:3.12-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 app

COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /usr/local/bin/uv
WORKDIR /opt/scheduler
ENV UV_PYTHON_DOWNLOADS=never \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/scheduler/.venv
COPY pyproject.toml ./
RUN uv sync --no-dev --no-install-project
COPY scheduler ./scheduler
RUN uv sync --no-dev --no-editable

ENV PATH=/opt/scheduler/.venv/bin:$PATH \
    SCHEDULER_STATE=/state \
    SCHEDULER_HOST=0.0.0.0 \
    SCHEDULER_PORT=8940

EXPOSE 8940
USER app
CMD ["scheduler"]
