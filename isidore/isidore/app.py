"""Starlette application: REST API, minimalist UI and Telegram bot wiring."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response
from starlette.routing import Route

from .runner import PiRunner, which_pi
from .scheduler_client import SchedulerClient, SchedulerError
from .store import Task, TaskStore
from .telegram import TelegramBot
from .ui import INDEX_HTML, TASK_HTML

log = logging.getLogger("isidore")

MAX_PROMPT = 100_000


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


def _env_float(name: str, default: float | None) -> float | None:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    try:
        return float(value)
    except ValueError:
        return default


@dataclass
class Settings:
    state_dir: str = field(default_factory=lambda: os.environ.get("ISIDORE_STATE", "/state"))
    host: str = field(default_factory=lambda: os.environ.get("ISIDORE_HOST", "0.0.0.0"))
    port: int = field(default_factory=lambda: _env_int("ISIDORE_PORT", 8920))
    token: str | None = field(default_factory=lambda: os.environ.get("ISIDORE_TOKEN") or None)
    model: str | None = field(default_factory=lambda: os.environ.get("ISIDORE_MODEL") or None)
    pi_bin: str = field(default_factory=which_pi)
    pi_mode: str = field(default_factory=lambda: os.environ.get("ISIDORE_PI_MODE", "print"))
    max_workers: int = field(default_factory=lambda: _env_int("ISIDORE_MAX_WORKERS", 2))
    timeout: float | None = field(default_factory=lambda: _env_float("ISIDORE_TASK_TIMEOUT", None))
    max_output: int = field(default_factory=lambda: _env_int("ISIDORE_MAX_OUTPUT", 200_000))
    scheduler_url: str | None = field(default_factory=lambda: os.environ.get("ISIDORE_SCHEDULER_URL") or None)
    scheduler_token: str | None = field(default_factory=lambda: os.environ.get("ISIDORE_SCHEDULER_TOKEN") or None)
    telegram_token: str | None = field(default_factory=lambda: os.environ.get("ISIDORE_TELEGRAM_TOKEN") or None)
    telegram_chats: set[str] = field(
        default_factory=lambda: {
            c.strip() for c in os.environ.get("ISIDORE_TELEGRAM_CHATS", "").split(",") if c.strip()
        }
    )

    @property
    def tasks_dir(self) -> str:
        return os.path.join(self.state_dir, "tasks")

    @property
    def workspaces_dir(self) -> str:
        return os.path.join(self.state_dir, "workspaces")


# --------------------------------------------------------------------- auth
def _authorised(request: Request) -> bool:
    token: str | None = request.app.state.settings.token
    if not token:
        return True
    header = request.headers.get("authorization", "")
    if header == f"Bearer {token}":
        return True
    return request.query_params.get("token") == token


def _deny() -> Response:
    return JSONResponse({"error": "unauthorised"}, status_code=401, headers={"WWW-Authenticate": "Bearer"})


# ------------------------------------------------------------------- routes
async def index(request: Request) -> Response:
    if not _authorised(request):
        return PlainTextResponse("unauthorised", status_code=401)
    return HTMLResponse(INDEX_HTML)


async def task_page(request: Request) -> Response:
    """Full-screen conversation view; the data is fetched from the API."""
    if not _authorised(request):
        return PlainTextResponse("unauthorised", status_code=401)
    return HTMLResponse(TASK_HTML)


async def healthz(request: Request) -> Response:
    return JSONResponse({"ok": True, "tasks": request.app.state.store.count()})


async def info(request: Request) -> Response:
    if not _authorised(request):
        return _deny()
    settings: Settings = request.app.state.settings
    return JSONResponse(
        {
            "scheduler": request.app.state.scheduler.enabled,
            "model": settings.model,
            "max_workers": settings.max_workers,
            "telegram": bool(settings.telegram_token),
        }
    )


async def tasks(request: Request) -> Response:
    if not _authorised(request):
        return _deny()
    store: TaskStore = request.app.state.store
    if request.method == "GET":
        try:
            limit = min(max(int(request.query_params.get("limit", 100)), 1), 500)
        except ValueError:
            limit = 100
        status = request.query_params.get("status")
        return JSONResponse([t.public() for t in store.list(limit=limit, status=status)])

    try:
        body = await request.json()
    except ValueError:
        return JSONResponse({"error": "expected a JSON body"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "expected a JSON object"}, status_code=400)
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        return JSONResponse({"error": "prompt is required"}, status_code=400)
    if len(prompt) > MAX_PROMPT:
        return JSONResponse({"error": f"prompt is longer than {MAX_PROMPT} characters"}, status_code=413)
    model = body.get("model") or None
    task = request.app.state.runner.create(
        prompt,
        model=str(model) if model else None,
        origin=str(body.get("origin") or "web"),
        schedule_id=body.get("schedule_id"),
    )
    return JSONResponse(task.public(), status_code=202)


async def task_detail(request: Request) -> Response:
    if not _authorised(request):
        return _deny()
    task = request.app.state.store.get(request.path_params["task_id"])
    if task is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if request.method == "DELETE":
        return await _delete_thread(request, task)
    return JSONResponse(task.public())


async def task_thread(request: Request) -> Response:
    """Every turn of one conversation, oldest first."""
    if not _authorised(request):
        return _deny()
    store: TaskStore = request.app.state.store
    task = store.get(request.path_params["task_id"])
    if task is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    turns = store.thread(task.root_id)
    return JSONResponse(
        {
            "id": task.root_id,
            "running": any(not t.done for t in turns),
            "turns": [t.public() for t in turns],
        }
    )


async def task_followup(request: Request) -> Response:
    """Add a turn to a finished conversation, reusing its workspace/session."""
    if not _authorised(request):
        return _deny()
    store: TaskStore = request.app.state.store
    parent = store.get(request.path_params["task_id"])
    if parent is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    if not parent.done:
        return JSONResponse({"error": "the previous turn is still running"}, status_code=409)
    try:
        body = await request.json()
    except ValueError:
        return JSONResponse({"error": "expected a JSON body"}, status_code=400)
    if not isinstance(body, dict):
        return JSONResponse({"error": "expected a JSON object"}, status_code=400)
    prompt = str(body.get("prompt") or "").strip()
    if not prompt:
        return JSONResponse({"error": "prompt is required"}, status_code=400)
    if len(prompt) > MAX_PROMPT:
        return JSONResponse({"error": f"prompt is longer than {MAX_PROMPT} characters"}, status_code=413)
    model = body.get("model") or parent.model
    task = request.app.state.runner.create(
        prompt,
        parent_id=parent.id,
        thread_id=parent.root_id,
        model=str(model) if model else None,
        origin=parent.origin,
    )
    return JSONResponse(task.public(), status_code=202)


async def _delete_thread(request: Request, task: Task) -> Response:
    """Remove a finished conversation: every record plus its shared workspace."""
    store: TaskStore = request.app.state.store
    turns = store.thread(task.root_id)
    if any(not t.done for t in turns):
        return JSONResponse({"error": "cannot delete a conversation while a turn is running"}, status_code=409)
    for turn in turns:
        store.remove(turn.id)
    shutil.rmtree(request.app.state.runner.workspace_for(task), ignore_errors=True)
    return Response(status_code=204)


async def task_cancel(request: Request) -> Response:
    if not _authorised(request):
        return _deny()
    task_id = request.path_params["task_id"]
    if await request.app.state.runner.cancel(task_id):
        return JSONResponse({"cancelled": task_id})
    task = request.app.state.store.get(task_id)
    if task is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse({"error": f"task is already {task.status}"}, status_code=409)


async def schedules(request: Request) -> Response:
    if not _authorised(request):
        return _deny()
    client: SchedulerClient = request.app.state.scheduler
    if not client.enabled:
        return JSONResponse({"error": "scheduler is not configured"}, status_code=503)
    try:
        if request.method == "GET":
            return JSONResponse({"schedules": await client.list()})
        body = await request.json()
        if not isinstance(body, dict):
            return JSONResponse({"error": "expected a JSON object"}, status_code=400)
        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            return JSONResponse({"error": "prompt is required"}, status_code=400)
        schedule = await client.create(
            prompt,
            at=body.get("at") or None,
            every=body.get("every") or None,
            model=body.get("model") or None,
        )
        return JSONResponse(schedule, status_code=201)
    except SchedulerError as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)


async def schedule_detail(request: Request) -> Response:
    if not _authorised(request):
        return _deny()
    client: SchedulerClient = request.app.state.scheduler
    if not client.enabled:
        return JSONResponse({"error": "scheduler is not configured"}, status_code=503)
    try:
        await client.cancel(request.path_params["schedule_id"])
    except SchedulerError as exc:
        return JSONResponse({"error": str(exc)}, status_code=502)
    return Response(status_code=204)


# --------------------------------------------------------------------- app
def create_app(settings: Settings | None = None) -> Starlette:
    settings = settings or Settings()

    @asynccontextmanager
    async def lifespan(app: Starlette):
        store = TaskStore(settings.tasks_dir, max_output=settings.max_output)
        scheduler = SchedulerClient(settings.scheduler_url, token=settings.scheduler_token)
        bot: TelegramBot | None = None

        async def on_change(task: Task) -> None:
            if bot is not None:
                await bot.notify(task)

        runner = PiRunner(
            store,
            workspace_root=settings.workspaces_dir,
            pi_bin=settings.pi_bin,
            max_workers=settings.max_workers,
            timeout=settings.timeout,
            model=settings.model,
            mode=settings.pi_mode,
            on_change=on_change,
        )
        app.state.settings = settings
        app.state.store = store
        app.state.runner = runner
        app.state.scheduler = scheduler

        bot_task: asyncio.Task | None = None
        if settings.telegram_token:
            bot = TelegramBot(
                settings.telegram_token,
                runner,
                store,
                allowed_chats=settings.telegram_chats,
            )
            bot_task = asyncio.create_task(bot.run(), name="isidore:telegram")

        log.info(
            "isidore ready: state=%s workers=%d scheduler=%s telegram=%s",
            settings.state_dir,
            settings.max_workers,
            "on" if scheduler.enabled else "off",
            "on" if bot else "off",
        )
        try:
            yield
        finally:
            if bot_task is not None:
                bot_task.cancel()
                await asyncio.gather(bot_task, return_exceptions=True)
            if bot is not None:
                await bot.stop()
            await runner.aclose()
            await scheduler.aclose()

    routes = [
        Route("/", index),
        Route("/tasks/{task_id}", task_page),
        Route("/healthz", healthz),
        Route("/api/info", info),
        Route("/api/tasks", tasks, methods=["GET", "POST"]),
        Route("/api/tasks/{task_id}", task_detail, methods=["GET", "DELETE"]),
        Route("/api/tasks/{task_id}/thread", task_thread, methods=["GET"]),
        Route("/api/tasks/{task_id}/followup", task_followup, methods=["POST"]),
        Route("/api/tasks/{task_id}/cancel", task_cancel, methods=["POST"]),
        Route("/api/schedules", schedules, methods=["GET", "POST"]),
        Route("/api/schedules/{schedule_id}", schedule_detail, methods=["DELETE"]),
    ]
    return Starlette(routes=routes, lifespan=lifespan)


def main() -> None:
    import uvicorn

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    settings = Settings()
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, log_level="info")


if __name__ == "__main__":
    main()
