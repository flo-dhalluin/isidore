"""MCP tool server + REST API for the scheduler.

The MCP endpoint lives at ``/mcp`` (streamable HTTP) and is what Pi connects
to. The same process also serves a tiny REST API so isidore's web UI can
create and list schedules, and a background loop that fires due schedules by
calling isidore's ``POST /api/tasks``.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import secrets
import sys
from contextlib import asynccontextmanager
from typing import Annotated

from mcp.server.mcpserver import Context, MCPServer
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
from .scoping import CONVERSATION_HEADER, ConversationScope, Scope, ScopeError
from .ui import INDEX_HTML

log = logging.getLogger("scheduler")

STATE_DIR = os.environ.get("SCHEDULER_STATE", "/state")
ISIDORE_URL = os.environ.get("SCHEDULER_ISIDORE_URL", "http://isidore:8920")
# Named volume shared with isidore (compose: scheduler-auth); isidore reads
# <mount>/scheduler-token to authenticate its REST proxy calls.
SHARED_DIR = os.environ.get("SCHEDULER_SHARED_DIR", "/shared")
ISIDORE_TOKEN = os.environ.get("SCHEDULER_ISIDORE_TOKEN") or None
TICK = float(os.environ.get("SCHEDULER_TICK", "1"))
RETRY_DELAY = float(os.environ.get("SCHEDULER_RETRY_DELAY", "30"))
# Default on; "0" restores the legacy open behavior for standalone dev/tests.
SCOPING_ENABLED = os.environ.get("SCHEDULER_MCP_SCOPING", "1") != "0"


def ensure_admin_token(
    token: str | None,
    *,
    shared_dir: str = SHARED_DIR,
    state_dir: str = STATE_DIR,
) -> str:
    """Return the effective admin token, generating one when unset (fail closed).

    Mirrors isidore's admin-token bootstrap: the REST API and the ``/mcp`` admin
    bypass are NEVER unauthenticated. A generated token is logged loudly to
    stderr and written to ``<shared_dir>/scheduler-token`` (mode 0600) so
    isidore can read it from the shared volume. When the shared dir is not
    writable (standalone dev/tests), fall back to ``<state_dir>``; if neither
    is writable, skip the file with a warning — the log still carries it.
    """
    if token:
        return token
    generated = secrets.token_hex(32)
    path: str | None = None
    for directory in (shared_dir, state_dir):
        candidate = os.path.join(directory, "scheduler-token")
        try:
            os.makedirs(directory, exist_ok=True)
            fd = os.open(candidate, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as handle:
                handle.write(generated + "\n")
            os.chmod(candidate, 0o600)
            path = candidate
            break
        except OSError:
            continue
    print("======================================================================", file=sys.stderr)
    print("scheduler: SCHEDULER_TOKEN was unset — generated a new admin token.", file=sys.stderr)
    print(f"scheduler: admin token: {generated}", file=sys.stderr)
    if path:
        print(f"scheduler: also written to {path} (mode 0600).", file=sys.stderr)
    else:
        print(
            "scheduler: WARNING: no writable token dir — file not written; "
            "read the token from this log.",
            file=sys.stderr,
        )
    print("======================================================================", file=sys.stderr)
    return generated


# Always set at runtime: REST/MCP admin auth must never fall open just because
# SCHEDULER_TOKEN was unset in the environment (compose default).
TOKEN = ensure_admin_token(os.environ.get("SCHEDULER_TOKEN") or None)

store = ScheduleStore(STATE_DIR)
client = IsidoreClient(ISIDORE_URL, token=ISIDORE_TOKEN)
scheduler = Scheduler(store, client, tick=TICK, retry_delay=RETRY_DELAY)
scope_guard = ConversationScope(client.whoami, enabled=SCOPING_ENABLED)

INSTRUCTIONS = """\
Schedule tasks that isidore will run as isolated Pi agents.
Use schedule_task with either `at` (one-shot, ISO-8601) or `every`
(recurring, e.g. "30m", "2h", "1d"). list_schedules shows what is pending,
cancel_schedule removes one, and run_schedule_now fires it immediately.
"""

mcp = MCPServer(name="scheduler", instructions=INSTRUCTIONS)

READ_ONLY = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
MUTATING = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False)


# isidore's mcp.json sends each task's origin in this header (interpolated from
# the worker's ISIDORE_TASK_ORIGIN); schedules created from a Telegram task
# report back to that chat.
ORIGIN_HEADER = "x-isidore-origin"


def _telegram_reply_to(origin: str | None) -> str | None:
    """Only Telegram origins are valid reply targets for spawned tasks."""
    value = str(origin or "").strip()
    return value if value.startswith("telegram:") else None


def _reply_to(ctx: Context | None) -> str | None:
    headers = ctx.headers if ctx is not None else None
    return _telegram_reply_to((headers or {}).get(ORIGIN_HEADER, ""))


def _is_admin(ctx: Context | None) -> bool:
    """True when the MCP call carries the admin Bearer SCHEDULER_TOKEN."""
    headers = ctx.headers if ctx is not None else None
    auth = (headers or {}).get("authorization", "")
    return bool(TOKEN) and hmac.compare_digest(auth.encode("utf-8"), f"Bearer {TOKEN}".encode("utf-8"))


async def _scope(ctx: Context | None) -> Scope | None:
    """Resolve the caller's conversation scope, failing closed with ToolError."""
    headers = ctx.headers if ctx is not None else None
    try:
        return await scope_guard.resolve(headers, admin=_is_admin(ctx))
    except ScopeError as exc:
        raise ToolError(str(exc)) from None


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
    ctx: Context | None = None,
) -> str:
    """Schedule a task: one-shot at `at`, or recurring every `every`."""
    if not prompt.strip():
        raise ToolError("prompt is required")
    scope = await _scope(ctx)
    try:
        schedule = scheduler.add(
            prompt.strip(),
            at=at,
            every=every,
            model=model,
            origin="tool",
            reply_to=_reply_to(ctx),
            conversation_id=scope.root_id if scope else None,
        )
    except ValueError as exc:
        raise ToolError(str(exc)) from None
    return _dump(schedule)


@mcp.tool(annotations=READ_ONLY, structured_output=False)
async def list_schedules(ctx: Context | None = None) -> str:
    """List schedules, newest first (scoped to the caller's conversation)."""
    scope = await _scope(ctx)
    schedules = scheduler.list()
    if scope is not None:
        schedules = [s for s in schedules if s.conversation_id == scope.root_id]
    return json.dumps([s.public() for s in schedules], indent=2, sort_keys=True)


@mcp.tool(annotations=READ_ONLY, structured_output=False)
async def get_schedule(
    schedule_id: Annotated[str, Field(description="Schedule id, e.g. 's_ab12cd34ef56'")],
    ctx: Context | None = None,
) -> str:
    """Show one schedule."""
    scope = await _scope(ctx)
    schedule = scheduler.get(schedule_id)
    if schedule is None or (scope is not None and schedule.conversation_id != scope.root_id):
        raise ToolError(f"no schedule {schedule_id!r}")
    return _dump(schedule)


@mcp.tool(annotations=MUTATING, structured_output=False)
async def cancel_schedule(
    schedule_id: Annotated[str, Field(description="Schedule id to remove")],
    ctx: Context | None = None,
) -> str:
    """Cancel and remove a schedule."""
    scope = await _scope(ctx)
    schedule = scheduler.get(schedule_id)
    if schedule is None or (scope is not None and schedule.conversation_id != scope.root_id):
        raise ToolError(f"no schedule {schedule_id!r}")
    if not scheduler.cancel(schedule_id):
        raise ToolError(f"no schedule {schedule_id!r}")
    return f"cancelled {schedule_id}"


@mcp.tool(annotations=MUTATING, structured_output=False)
async def run_schedule_now(
    schedule_id: Annotated[str, Field(description="Schedule id to fire immediately")],
    ctx: Context | None = None,
) -> str:
    """Fire a schedule immediately (a one-shot is then disabled)."""
    scope = await _scope(ctx)
    schedule = scheduler.get(schedule_id)
    if schedule is None or (scope is not None and schedule.conversation_id != scope.root_id):
        raise ToolError(f"no schedule {schedule_id!r}")
    schedule = await scheduler.run_now(schedule_id)
    if schedule is None:
        raise ToolError(f"no schedule {schedule_id!r}")
    if schedule.last_error:
        raise ToolError(f"could not spawn task: {schedule.last_error}")
    return _dump(schedule)


# -------------------------------------------------------------------- REST
def _authorised(request: Request) -> bool:
    # Fail closed: ensure_admin_token() always sets TOKEN at runtime, so an
    # unset token here (programmatic misuse) must deny, never allow.
    if not TOKEN:
        return False
    auth = request.headers.get("authorization", "")
    if hmac.compare_digest(auth.encode("utf-8"), f"Bearer {TOKEN}".encode("utf-8")):
        return True
    return hmac.compare_digest(request.query_params.get("token", "").encode("utf-8"), TOKEN.encode("utf-8"))


def _deny() -> Response:
    return JSONResponse({"error": "unauthorised"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})


def _conversation_id(request: Request) -> str | None:
    """Conversation scope for an admin-authenticated REST request (contract #6).

    Read only after ``_authorised`` passes. isidore's proxy sends this header
    alongside the admin Bearer when the original caller used a task token; a
    plain admin request omits it and sees everything.
    """
    return request.headers.get(CONVERSATION_HEADER) or None


def _in_conversation(schedule: Schedule | None, conversation_id: str | None) -> bool:
    if schedule is None:
        return False
    return conversation_id is None or schedule.conversation_id == conversation_id


async def index(request: Request) -> Response:
    if not _authorised(request):
        return PlainTextResponse("unauthorised", status_code=401)
    return HTMLResponse(INDEX_HTML)


async def healthz(request: Request) -> Response:
    return JSONResponse({"ok": True, "schedules": len(store.list())})


async def api_schedules(request: Request) -> Response:
    if not _authorised(request):
        return _deny()
    conversation_id = _conversation_id(request)
    if request.method == "GET":
        schedules = scheduler.list()
        if conversation_id is not None:
            schedules = [s for s in schedules if s.conversation_id == conversation_id]
        return JSONResponse({"schedules": [s.public() for s in schedules]})
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
            # REST-created schedules route results back to the caller's origin
            # (e.g. a Telegram chat) exactly like the MCP schedule_task path.
            reply_to=_telegram_reply_to(body.get("reply_to")),
            conversation_id=conversation_id,
        )
    except ValueError as exc:
        return JSONResponse({"error": str(exc)}, status_code=400)
    return JSONResponse(schedule.public(), status_code=201)


async def api_schedule(request: Request) -> Response:
    if not _authorised(request):
        return _deny()
    conversation_id = _conversation_id(request)
    schedule_id = request.path_params["schedule_id"]
    if not _in_conversation(scheduler.get(schedule_id), conversation_id):
        return JSONResponse({"error": "not found"}, status_code=404)
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
    conversation_id = _conversation_id(request)
    schedule_id = request.path_params["schedule_id"]
    if not _in_conversation(scheduler.get(schedule_id), conversation_id):
        return JSONResponse({"error": "not found"}, status_code=404)
    schedule = await scheduler.run_now(schedule_id)
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
