"""Durable task records for isidore.

Each task is a small JSON document under ``<root>/t_*.json``. Writes go
through a temporary file + :func:`os.replace`, so a crash never leaves a
half-written record behind. The store is deliberately synchronous and guarded
by a re-entrant lock: the web server only ever reads from it in request
handlers.
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

Status = Literal["queued", "running", "succeeded", "failed", "cancelled", "timeout"]

TERMINAL_STATUSES: frozenset[str] = frozenset({"succeeded", "failed", "cancelled", "timeout"})
VALID_STATUSES: frozenset[str] = frozenset({"queued", "running", *TERMINAL_STATUSES})


def utcnow() -> str:
    """Timestamp used in every record: ISO-8601, microsecond precision, UTC."""
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


def new_id(prefix: str = "t") -> str:
    return f"{prefix}_{os.urandom(6).hex()}"


@dataclass
class Task:
    """One prompt handed to a fresh, isolated ``pi`` process."""

    prompt: str
    id: str = field(default_factory=new_id)
    status: Status = "queued"
    created_at: str = field(default_factory=utcnow)
    started_at: str | None = None
    finished_at: str | None = None
    exit_code: int | None = None
    output: str = ""
    error: str | None = None
    origin: str = "web"
    model: str | None = None
    schedule_id: str | None = None
    # Conversation threading: a follow-up points at the task it answers and
    # carries the root task id, so every turn of one conversation shares a
    # workspace (and therefore a Pi session). Both are ``None`` for the root.
    parent_id: str | None = None
    thread_id: str | None = None
    workspace: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Task":
        known = cls.__dataclass_fields__
        return cls(**{k: v for k, v in data.items() if k in known})

    @property
    def root_id(self) -> str:
        """Id of the conversation this task belongs to (itself for a root task)."""
        return self.thread_id or self.id

    @property
    def done(self) -> bool:
        return self.status in TERMINAL_STATUSES

    def public(self) -> dict[str, Any]:
        data = self.to_dict()
        data["done"] = self.done
        return data


class TaskStore:
    """In-memory index over on-disk task records."""

    def __init__(self, root: str | os.PathLike[str], *, max_output: int = 200_000) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.max_output = max_output
        self._lock = threading.RLock()
        self._tasks: dict[str, Task] = {}
        self._load()

    # -- persistence ------------------------------------------------------
    def _path(self, task_id: str) -> Path:
        return self.root / f"{task_id}.json"

    def _load(self) -> None:
        for path in sorted(self.root.glob("t_*.json")):
            try:
                task = Task.from_dict(json.loads(path.read_text()))
            except (OSError, ValueError):
                continue  # unreadable/corrupt record: skip rather than fail startup
            self._tasks[task.id] = task

    def _write(self, task: Task) -> None:
        path = self._path(task.id)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(task.to_dict(), indent=2, sort_keys=True))
        os.replace(tmp, path)

    def _clip(self, text: str | None) -> str:
        text = text or ""
        if len(text) <= self.max_output:
            return text
        half = self.max_output // 2
        dropped = len(text) - self.max_output
        return f"{text[:half]}\n… ({dropped} chars truncated) …\n{text[-half:]}"

    # -- API --------------------------------------------------------------
    def add(self, task: Task) -> Task:
        with self._lock:
            self._tasks[task.id] = task
            self._write(task)
        return task

    def update(self, task: Task) -> Task:
        with self._lock:
            task.output = self._clip(task.output)
            self._tasks[task.id] = task
            self._write(task)
        return task

    def get(self, task_id: str) -> Task | None:
        with self._lock:
            return self._tasks.get(task_id)

    def remove(self, task_id: str) -> bool:
        """Drop a task record from memory and disk. Returns False if unknown."""
        with self._lock:
            if task_id not in self._tasks:
                return False
            del self._tasks[task_id]
        try:
            self._path(task_id).unlink()
        except FileNotFoundError:
            pass
        return True

    def list(self, *, limit: int = 100, status: str | None = None) -> list[Task]:
        with self._lock:
            tasks = list(self._tasks.values())
        if status:
            tasks = [t for t in tasks if t.status == status]
        tasks.sort(key=lambda t: (t.created_at, t.id), reverse=True)
        return tasks[:limit]

    def thread(self, root_id: str) -> list[Task]:
        """Every turn of one conversation, oldest first."""
        with self._lock:
            tasks = [t for t in self._tasks.values() if t.root_id == root_id]
        tasks.sort(key=lambda t: (t.created_at, t.id))
        return tasks

    def count(self) -> int:
        with self._lock:
            return len(self._tasks)
