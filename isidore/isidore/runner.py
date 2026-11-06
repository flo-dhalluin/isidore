"""Run Pi as an isolated subprocess, one process per task.

isolation model
---------------
Every task gets its own directory below ``workspace_root`` and runs as a
separate ``pi`` process with that directory as its working directory and
``$HOME``. A conversation's turns share the root task's directory and Pi
session (``--session-id <root id>``), so follow-ups keep the earlier work;
standalone runs stay ephemeral (``--no-session``). The process never inherits
a shell: arguments are passed as a list, so a prompt cannot escape into the
host command line. Together with one process per task this is the "isolated
agent" isidore exposes.

The runner is intentionally a thin wrapper around the documented Pi CLI
(``pi --print`` / ``pi --mode json``); it does not reimplement any agent
behaviour. ``build_command`` and ``summarise_event`` are pure functions so
they can be unit-tested without spawning anything.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import signal
from collections.abc import Awaitable, Callable, Sequence
from pathlib import Path

from .store import Task, TaskStore, utcnow

OnChange = Callable[[Task], "None | Awaitable[None]"]
MAX_EVENT_TEXT = 4_000


def build_command(
    task: Task,
    *,
    pi_bin: str = "pi",
    mode: str = "print",
    model: str | None = None,
    session_id: str | None = None,
    extra_args: Sequence[str] = (),
) -> list[str]:
    """Build the argv for one task (no shell involved).

    A conversation keeps a real Pi session: every turn passes the same
    ``--session-id`` (the thread root id), so Pi reloads the prior branch and
    the follow-up sees the earlier work. Tasks without a session id stay
    ephemeral (``--no-session``).
    """
    cmd: list[str] = [pi_bin]
    if session_id:
        cmd += ["--session-id", session_id]
    else:
        cmd += ["--no-session"]
    cmd += ["--no-approve"]
    if mode == "json":
        cmd += ["--mode", "json"]
    else:
        cmd += ["--print"]
    chosen_model = task.model or model
    if chosen_model:
        cmd += ["--model", chosen_model]
    cmd += list(extra_args)
    cmd += ["--", task.prompt]
    return cmd


def _text_of(content: object) -> str:
    """Flatten a Pi message ``content`` value into plain text."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict):
            if block.get("type") == "text" and isinstance(block.get("text"), str):
                parts.append(block["text"])
        elif isinstance(block, str):
            parts.append(block)
    return "".join(parts)


def summarise_event(record: dict) -> str | None:
    """Turn one JSON-mode record into a line for the human-readable transcript.

    Returns ``None`` for records that carry no display value. Unknown event
    types are ignored, so a future Pi version cannot break the runner.
    """
    kind = record.get("type")
    if kind == "message_end":
        message = record.get("message") or {}
        if message.get("role") == "assistant":
            text = _text_of(message.get("content"))
            return f"\n{text}\n" if text else None
    if kind == "tool_execution_start":
        return f"\n> {record.get('toolName', 'tool')} {_short(record.get('args'))}\n"
    if kind == "tool_execution_end":
        marker = "!" if record.get("isError") else "✓"
        return f"{marker} {record.get('toolName', 'tool')}\n"
    if kind == "message_update":
        event = record.get("assistantMessageEvent") or {}
        if event.get("type") == "text_delta":
            return event.get("delta") or None
    return None


def _short(value: object) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False, sort_keys=True)
    except (TypeError, ValueError):
        text = str(value)
    if len(text) > 200:
        text = text[:200] + "…"
    return text


class PiRunner:
    """Queue, run and cancel isolated ``pi`` tasks."""

    def __init__(
        self,
        store: TaskStore,
        *,
        workspace_root: str | os.PathLike[str],
        pi_bin: str = "pi",
        max_workers: int = 2,
        timeout: float | None = None,
        model: str | None = None,
        mode: str = "print",
        extra_args: Sequence[str] = (),
        base_env: dict[str, str] | None = None,
        on_change: OnChange | None = None,
    ) -> None:
        self.store = store
        self.workspace_root = Path(workspace_root)
        self.workspace_root.mkdir(parents=True, exist_ok=True)
        self.pi_bin = pi_bin
        self.max_workers = max(1, max_workers)
        self.timeout = timeout
        self.model = model
        self.mode = mode
        self.extra_args = list(extra_args)
        self.base_env = dict(base_env if base_env is not None else os.environ)
        self.on_change = on_change
        self._sem = asyncio.Semaphore(self.max_workers)
        self._jobs: set[asyncio.Task] = set()
        self._procs: dict[str, asyncio.subprocess.Process] = {}
        self._closing = False

    # -- public API -------------------------------------------------------
    def submit(self, task: Task) -> Task:
        """Record a task and start running it in the background."""
        self.store.add(task)
        self._notify(task)
        job = asyncio.create_task(self._run(task), name=f"isidore:{task.id}")
        self._jobs.add(job)
        job.add_done_callback(self._jobs.discard)
        return task

    def create(self, prompt: str, **kwargs: object) -> Task:
        return self.submit(Task(prompt=prompt, **kwargs))  # type: ignore[arg-type]

    async def cancel(self, task_id: str) -> bool:
        """Cancel a queued/running task. Returns False if it already finished."""
        task = self.store.get(task_id)
        if task is None or task.done:
            return False
        task.status = "cancelled"
        task.finished_at = utcnow()
        self.store.update(task)
        self._notify(task)
        proc = self._procs.get(task_id)
        if proc is not None and proc.returncode is None:
            _kill(proc)
        return True

    async def aclose(self) -> None:
        """Stop accepting work and cancel everything still running."""
        self._closing = True
        for task_id in list(self._procs):
            await self.cancel(task_id)
        for job in list(self._jobs):
            job.cancel()
        if self._jobs:
            await asyncio.gather(*self._jobs, return_exceptions=True)

    # -- internals --------------------------------------------------------
    def _notify(self, task: Task) -> None:
        if self.on_change is None:
            return
        try:
            result = self.on_change(task)
        except Exception:  # noqa: BLE001 - a notifier must never break a task
            return
        if asyncio.iscoroutine(result):
            asyncio.create_task(result)

    def _task_workspace(self, task: Task) -> Path:
        # Every turn of a conversation shares the root task's workspace, so the
        # agent keeps its files and its Pi session (stored under $HOME) across
        # follow-ups.
        path = self.workspace_root / task.root_id
        path.mkdir(parents=True, exist_ok=True)
        return path

    def workspace_for(self, task: Task) -> Path:
        return self.workspace_root / task.root_id

    def _env(self, workspace: Path) -> dict[str, str]:
        env = dict(self.base_env)
        # Keep Pi's config/credentials, but isolate the process home and cwd.
        env["HOME"] = str(workspace)
        env["TMPDIR"] = str(workspace / "tmp")
        Path(env["TMPDIR"]).mkdir(parents=True, exist_ok=True)
        # Keep this conversation's Pi session inside its workspace, so deleting
        # the workspace (or the conversation) really removes all its state.
        env["PI_CODING_AGENT_SESSION_DIR"] = str(workspace / "sessions")
        Path(env["PI_CODING_AGENT_SESSION_DIR"]).mkdir(parents=True, exist_ok=True)
        # Do not hand the service's own credentials (web/Telegram/scheduler
        # tokens) to the agent. Pi only needs its provider key and config dir.
        for key in list(env):
            if key.startswith(("ISIDORE_", "SCHEDULER_", "PI_SANDBOX_")):
                env.pop(key, None)
        # The per-task HOME has no git config; mirror the author identity so
        # commits made by a task still work.
        for key in ("GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL"):
            if key in env:
                env.setdefault(key.replace("AUTHOR", "COMMITTER"), env[key])
        return env

    async def _run(self, task: Task) -> None:
        try:
            async with self._sem:
                if task.status == "cancelled" or self._closing:
                    return
                await self._execute(task)
        except asyncio.CancelledError:
            if not task.done:
                task.status = "cancelled"
                task.finished_at = utcnow()
                self.store.update(task)
                self._notify(task)
            raise
        except Exception as exc:  # noqa: BLE001 - a bad task must not kill the runner
            if not task.done:
                task.status = "failed"
                task.error = f"{type(exc).__name__}: {exc}"
                task.finished_at = utcnow()
                self.store.update(task)
                self._notify(task)

    async def _execute(self, task: Task) -> None:
        workspace = self._task_workspace(task)
        task.workspace = str(workspace)
        task.status = "running"
        task.started_at = utcnow()
        self.store.update(task)
        self._notify(task)

        cmd = build_command(
            task,
            pi_bin=self.pi_bin,
            mode=self.mode,
            model=self.model,
            session_id=task.root_id,
            extra_args=self.extra_args,
        )
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            cwd=str(workspace),
            env=self._env(workspace),
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            # Own process group: cancelling a task kills its whole tree.
            start_new_session=True,
        )
        self._procs[task.id] = proc
        timed_out = False

        try:
            if self.mode == "json":
                await asyncio.wait_for(self._consume_json(task, proc), self.timeout)
            else:
                await asyncio.wait_for(self._consume_print(task, proc), self.timeout)
        except asyncio.TimeoutError:
            timed_out = True
            task.error = f"timed out after {self.timeout:g}s"
            _kill(proc)
            await proc.wait()
        except asyncio.CancelledError:
            _kill(proc)
            await proc.wait()
            raise
        finally:
            self._procs.pop(task.id, None)
            self._finalise(task, proc.returncode, timed_out=timed_out)

    async def _consume_print(self, task: Task, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None and proc.stderr is not None
        out, err = await proc.communicate()
        task.output = out.decode(errors="replace")
        task.error = err.decode(errors="replace").strip() or None
        await proc.wait()

    async def _consume_json(self, task: Task, proc: asyncio.subprocess.Process) -> None:
        assert proc.stdout is not None and proc.stderr is not None
        loop = asyncio.get_running_loop()
        last_save = 0.0

        async def read_stdout() -> None:
            nonlocal last_save
            assert proc.stdout is not None
            while True:
                line = await proc.stdout.readline()
                if not line:
                    break
                text = line.decode(errors="replace").strip()
                if not text:
                    continue
                try:
                    record = json.loads(text)
                except ValueError:
                    task.output += text + "\n"
                    continue
                chunk = summarise_event(record)
                if chunk:
                    task.output += chunk
                    # Text deltas are frequent; persist them at most twice a
                    # second. Structural events are always persisted.
                    now = loop.time()
                    if record.get("type") != "message_update" or now - last_save >= 0.5:
                        self.store.update(task)
                        self._notify(task)
                        last_save = now

        async def read_stderr() -> None:
            assert proc.stderr is not None
            err = await proc.stderr.read()
            text = err.decode(errors="replace").strip()
            if text:
                task.error = text[-MAX_EVENT_TEXT:]

        await asyncio.gather(read_stdout(), read_stderr())
        await proc.wait()

    def _finalise(self, task: Task, returncode: int | None, *, timed_out: bool = False) -> None:
        task.exit_code = returncode
        if task.finished_at is None:
            task.finished_at = utcnow()
        if task.status == "cancelled":
            pass
        elif timed_out:
            task.status = "timeout"
        elif returncode == 0:
            task.status = "succeeded"
        else:
            task.status = "failed"
        self.store.update(task)
        self._notify(task)


def _kill(proc: asyncio.subprocess.Process) -> None:
    """Kill a task's whole process group (it was started in a new session)."""
    try:
        os.killpg(proc.pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def which_pi() -> str:
    """Resolve the ``pi`` executable, preferring an explicit env override."""
    return os.environ.get("ISIDORE_PI_BIN") or shutil.which("pi") or "pi"
