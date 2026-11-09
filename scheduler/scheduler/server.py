"""MCP tool server + REST API for the scheduler.

The MCP endpoint lives at ``/mcp`` (streamable HTTP) and is what Pi connects
to. The same process also serves a tiny REST API so isidore's web UI can
create and list schedules, and a background loop that fires due schedules by
calling isidore's ``POST /api/tasks``.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import Annotated

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from pydantic import Field
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response
from starlette.routing import Route

from .client import IsidoreClient
from .core import Schedule, ScheduleStore, Scheduler
from .ui import INDEX_HTML

log = logging.getLogger("scheduler")

STATE_DIR = os.environ.get("SCHEDULER_STATE", "/state")
ISIDORE_URL = os.environ.get("SCHEDULER_ISIDORE_URL", "http://isidore:8920")
TOKEN = os.environ.get("SCHEDULER_TOKEN") or None
ISIDORE_TOKEN = os.environ.get("SCHEDULER_ISIDORE_TOKEN") or None
TICK = float(os.environ.get("SCHEDULER_TICK", "1"))
RETRY_DELAY = float(os.environ.get("SCHEDULER_RETRY_DELAY", "30"))

store = ScheduleStore(STATE_DIR)
client = IsidoreClient(ISIDORE_URL, token=ISIDORE_TOKEN)
scheduler = Scheduler(store, client, tick=TICK, retry_delay=RETRY_DELAY)

INSTRUCTIONS = """\
Schedule tasks that isidore will run as isolated Pi agents.
Use schedule_task with either `at` (one-shot, ISO-8601) or `every`
(recurring, e.g. "30m", "2h", "1d"). list_schedules shows what is pending,
cancel_schedule removes one, and run_schedule_now fires it immediately.
"""

mcp = MCPServer(name="scheduler", instructions=INSTRUCTIONS)

READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
MUTATING = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False)


def _dump(schedule: Schedule) -> str:
    return json.dumps(schedule.public(), indent=2, sort_keys=True)


# ------------------------------------------------------------------- tools
@mcp.tool(annotations=MUTATING, structured_output=False)
async def schedule_task(
    prompt: Annotated[str, Field(description="Task prompt for the spawned Pi agent")],
    at: Annotated[
        str | None,
        Field(description="One-shot time: ISO-8601 (e.g. 2025-01-31T09:00:00Z) or '+30m'"),
    ] = None,
    every: Annotated[
        str | None,
        Field(description="Recurring interval, e.g. '30m', '2h', '1d' (mutually exclusive with at)"),
    ] = None,
    model: Annotated[str | None, Field(description="Optional model override for the task")] = None,
) -> str:
    """Schedule a task: one-shot at `at`, or recurring every `every`."""
    if not prompt.strip():
        raise ToolError("prompt is required")
    try:
        schedule = scheduler.add(prompt.strip(), at=at, every=every, model=model, origin="tool")
    except ValueError as exc:
        raise ToolError(str(exc)) from None
    return _dump(schedule)


@mcp.tool(annotations=READ_ONLY, structured_output=False)
async def list_schedules() -> str:
    """List every schedule, newest first."""
    return json.dumps([s.public() for s in scheduler.list()], indent=2, sort_keys=True)


@mcp.tool(annotations=READ_ONLY, structured_output=False)
async def get_schedule(
    schedule_id: Annotated[str, Field(description="Schedule id, e.g. 's_ab12cd34ef56'")],
) -> str:
    """Show one schedule."""
    schedule = scheduler.get(schedule_id)
    if schedule is None:
        raise ToolError(f"no schedule {schedule_id!r}")
    return _dump(schedule)


@mcp.tool(annotations=MUTATING, structured_output=False)
async def cancel_schedule(
    schedule_id: Annotated[str, Field(description="Schedule id to remove")],
) -> str:
    """Cancel and remove a schedule."""
    if not scheduler.cancel(schedule_id):
        raise ToolError(f"no schedule {schedule_id!r}")
    return f"cancelled {schedule_id}"


@mcp.tool(annotations=MUTATING, structured_output=False)
async def run_schedule_now(
    schedule_id: Annotated[str, Field(description="Schedule id to fire immediately")],
) -> str:
    """Fire a schedule immediately (a one-shot is then disabled)."""
    schedule = await scheduler.run_now(schedule_id)
    if schedule is None:
        raise ToolError(f"no schedule {schedule_id!r}")
    if schedule.last_error:
        raise ToolError(f"could not spawn task: {schedule.last_error}")
    return _dump(schedule)


# -------------------------------------------------------------------- REST
def _authorised(request: Request) -> bool:
    if not TOKEN:
        return True
    if request.headers.get("authorization") == f"Bearer {TOKEN}":
        return True
    return request.query_params.get("token") == TOKEN


def _deny() -> Response:
    return JSONResponse({"error": "unauthorised"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})


async def index(request: Request) -> Response:
    if not _authorised(request):
        return PlainTextResponse("unauthorised", status_code=401)
    return HTMLResponse(INDEX_HTML)


async def healthz(request: Request) -> Response:
    return JSONResponse({"ok": True, "schedules": len(store.list())})


async def api_schedules(request: Request) -> Response:
    if not _authorised(request):
        return _deny()
    if request.method == "GET":
        return JSONResponse({"schedules": [s.public() for s in scheduler.list()]})
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse({"error": "expected a JSON body"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "expected a JSON object"}, status_code=400)
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        return JSONResponse({"error": "prompt is required"}, status_code=400)
    try:
        schedule = scheduler.add(
            prompt,
            at=body.get("at") or None,
            every=body.get("every") or None,
            model=body.get("model") or None,
            origin=str(body.get("origin") or "isidore"),
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    return JSONResponse(schedule.public(), status_code=201)


async def api_schedule(request: Request) -> Response:
    if not _authorised(request):
        return _deny()
    schedule_id = request.path_params["schedule_id"]
    if request.method == "DELETE":
        if not scheduler.cancel(schedule_id):
            return JSONResponse({"error": "not found"}, status_code=404)
        return Response(status_code=204)
    schedule = scheduler.get(schedule_id)
    if schedule is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse(schedule.public())


async def api_run(request: Request) -> Response:
    if not _authorised(request):
        return _deny()
    schedule = await scheduler.run_now(request.path_params["schedule_id"])
    if schedule is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if schedule.last_error:
        return JSONResponse({"error": schedule.last_error}, status_code=502)
    return JSONResponse(schedule.public())


# --------------------------------------------------------------------- app
def create_app() -> Starlette:
    hosts = [h.strip() for h in os.environ.get(
        "SCHEDULER_ALLOWED_HOSTS", "scheduler:*,localhost:*,127.0.0.1:*"
    ).split(",") if h.strip()]
    security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=hosts,
        allowed_origins=[f"http://{h}" for h in hosts],
    )
    mcp_app = mcp.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        transport_security=security,
    )

    routes = list(mcp_app.routes) + [
        Route("/", index),
        Route("/healthz", healthz),
        Route("/api/schedules", api_schedules, methods=["GET", "POST"]),
        Route("/api/schedules/{schedule_id}", api_schedule, methods=["GET", "DELETE"]),
        Route("/api/schedules/{schedule_id}/run", api_run, methods=["POST"]),
    ]

    @asynccontextmanager
    async def lifespan(app: Starlette):
        # The MCP app owns the streamable-HTTP session manager; run its
        # lifespan ourselves because Starlette does not run mounted lifespans.
        async with mcp_app.router.lifespan_context(mcp_app):
            loop = asyncio.create_task(scheduler.run_forever(), name="scheduler:loop")
            log.info("scheduler ready: state=%s isidore=%s", STATE_DIR, ISIDORE_URL)
            try:
                yield
            finally:
                scheduler.stop()
                loop.cancel()
                await asyncio.gather(loop, return_exceptions=True)
                await client.aclose()

    return Starlette(routes=routes, lifespan=lifespan)


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    host = os.environ.get("SCHEDULER_HOST", "0.0.0.0")
    port = int(os.environ.get("SCHEDULER_PORT", "8940"))
    uvicorn.run(create_app(), host=host, port=port, log_level="info")


if __name__ == "__main__":
    main()
