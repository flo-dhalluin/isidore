"""Schedule model, persistence and the firing loop.

A schedule is either:

* ``once``     - fire at an absolute time (``at``), then disable itself;
* ``interval`` - fire every ``every`` seconds, starting one interval from now.

Times are stored as ISO-8601 UTC strings so the JSON file is readable and
stable across restarts.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Literal, Protocol

log = logging.getLogger("scheduler")

Mode = Literal["once", "interval"]

_UNITS = {"s": 1, "m": 60, "h": 3_600, "d": 86_400, "w": 604_800}
_DURATION_RE = re.compile(r"(\d+(?:\.\d+)?)\s*([smhdw])", re.IGNORECASE)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def iso(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="seconds")


def parse_dt(value: str | int | float | datetime) -> datetime:
    """Parse an absolute time. Naive values are interpreted as UTC."""
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, tz=timezone.utc)
    text = str(value).strip()
    if not text:
        raise ValueError("empty time")
    if text.startswith("+"):
        return utcnow() + timedelta(seconds=parse_duration(text[1:]))
    if text.lower().startswith("in "):
        return utcnow() + timedelta(seconds=parse_duration(text[3:]))
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"invalid time {value!r}; use ISO-8601, e.g. 2025-01-31T09:00:00Z") from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def parse_duration(value: str | int | float) -> int:
    """Parse a duration into whole seconds.

    Accepts plain seconds (``90``) and compact units (``30s``, ``5m``,
    ``2h``, ``1d``, ``1w``, and combinations such as ``1h30m``).
    """
    if isinstance(value, (int, float)):
        seconds = int(value)
        if seconds <= 0:
            raise ValueError("duration must be positive")
        return seconds
    text = str(value).strip().lower()
    if not text:
        raise ValueError("empty duration")
    if text.isdigit():
        seconds = int(text)
        if seconds <= 0:
            raise ValueError("duration must be positive")
        return seconds
    matches = list(_DURATION_RE.finditer(text))
    if not matches:
        raise ValueError(f"invalid duration {value!r}; use e.g. 30m, 2h, 1d")
    # Reject trailing garbage such as "5minutes" or "1h!".
    consumed = "".join(m.group(0) for m in matches)
    if re.sub(r"\s+", "", consumed) != re.sub(r"\s+", "", text):
        raise ValueError(f"invalid duration {value!r}; use e.g. 30m, 2h, 1d")
    total = sum(float(m.group(1)) * _UNITS[m.group(2).lower()] for m in matches)
    seconds = int(total)
    if seconds <= 0:
        raise ValueError("duration must be positive")
    return seconds


def new_id() -> str:
    return "s_" + os.urandom(6).hex()


@dataclass
class Schedule:
    prompt: str
    id: str = field(default_factory=new_id)
    mode: Mode = "once"
    at: str | None = None
    every: int | None = None
    next_run: str | None = None
    created_at: str = field(default_factory=lambda: iso(utcnow()))
    last_run: str | None = None
    runs: int = 0
    enabled: bool = True
    model: str | None = None
    origin: str = "tool"
    last_task_id: str | None = None
    last_error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Schedule":
        known = cls.__dataclass_fields__
        return cls(**{k: v for k, v in data.items() if k in known})

    def public(self) -> dict[str, Any]:
        return self.to_dict()


class ScheduleStore:
    """A single JSON file holding every schedule."""

    def __init__(self, root: str | os.PathLike[str]) -> None:
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / "schedules.json"
        self._lock = threading.RLock()
        self._schedules: dict[str, Schedule] = {}
        self._load()

    def _load(self) -> None:
        if not self.path.exists():
            return
        try:
            data = json.loads(self.path.read_text())
        except (OSError, ValueError):
            log.exception("could not read %s; starting empty", self.path)
            return
        for item in data.get("schedules", []):
            try:
                schedule = Schedule.from_dict(item)
            except (TypeError, ValueError):
                continue
            self._schedules[schedule.id] = schedule

    def _save(self) -> None:
        payload = {"schedules": [s.to_dict() for s in self._schedules.values()]}
        tmp = self.path.with_name(self.path.name + ".tmp")
        tmp.write_text(json.dumps(payload, indent=2, sort_keys=True))
        os.replace(tmp, self.path)

    def add(self, schedule: Schedule) -> Schedule:
        with self._lock:
            self._schedules[schedule.id] = schedule
            self._save()
        return schedule

    def update(self, schedule: Schedule) -> Schedule:
        with self._lock:
            self._schedules[schedule.id] = schedule
            self._save()
        return schedule

    def get(self, schedule_id: str) -> Schedule | None:
        with self._lock:
            return self._schedules.get(schedule_id)

    def list(self) -> list[Schedule]:
        with self._lock:
            return sorted(self._schedules.values(), key=lambda s: s.created_at, reverse=True)

    def remove(self, schedule_id: str) -> bool:
        with self._lock:
            if schedule_id not in self._schedules:
                return False
            del self._schedules[schedule_id]
            self._save()
            return True

    def due(self, now: datetime | None = None) -> list[Schedule]:
        now = now or utcnow()
        with self._lock:
            result = []
            for schedule in self._schedules.values():
                if not schedule.enabled or not schedule.next_run:
                    continue
                try:
                    if parse_dt(schedule.next_run) <= now:
                        result.append(schedule)
                except ValueError:
                    continue
            return result


class TaskSpawner(Protocol):
    async def create_task(self, prompt: str, **kwargs: Any) -> dict[str, Any]: ...


class Scheduler:
    def __init__(
        self,
        store: ScheduleStore,
        spawner: TaskSpawner,
        *,
        tick: float = 1.0,
        retry_delay: float = 30.0,
    ) -> None:
        self.store = store
        self.spawner = spawner
        self.tick = tick
        self.retry_delay = retry_delay
        self._stopped = asyncio.Event()

    # -- creation ---------------------------------------------------------
    def add_once(self, prompt: str, at: str | int | float | datetime, **kwargs: Any) -> Schedule:
        when = parse_dt(at)
        schedule = Schedule(
            prompt=prompt,
            mode="once",
            at=iso(when),
            next_run=iso(when),
            **kwargs,
        )
        return self.store.add(schedule)

    def add_interval(self, prompt: str, every: str | int | float, **kwargs: Any) -> Schedule:
        seconds = parse_duration(every)
        schedule = Schedule(
            prompt=prompt,
            mode="interval",
            every=seconds,
            next_run=iso(utcnow() + timedelta(seconds=seconds)),
            **kwargs,
        )
        return self.store.add(schedule)

    def add(
        self,
        prompt: str,
        *,
        at: str | int | float | datetime | None = None,
        every: str | int | float | None = None,
        **kwargs: Any,
    ) -> Schedule:
        if bool(at) == bool(every):
            raise ValueError("provide exactly one of 'at' (one-shot) or 'every' (recurring)")
        if at is not None:
            return self.add_once(prompt, at, **kwargs)
        return self.add_interval(prompt, every, **kwargs)  # type: ignore[arg-type]

    # -- queries ----------------------------------------------------------
    def get(self, schedule_id: str) -> Schedule | None:
        return self.store.get(schedule_id)

    def list(self) -> list[Schedule]:
        return self.store.list()

    def cancel(self, schedule_id: str) -> bool:
        return self.store.remove(schedule_id)

    # -- firing -----------------------------------------------------------
    async def fire(self, schedule: Schedule, *, now: datetime | None = None) -> Schedule:
        now = now or utcnow()
        try:
            result = await self.spawner.create_task(
                schedule.prompt,
                model=schedule.model,
                schedule_id=schedule.id,
                origin="scheduler",
            )
        except Exception as exc:  # noqa: BLE001 - keep the scheduler alive
            schedule.last_error = str(exc)
            schedule.next_run = iso(now + timedelta(seconds=self.retry_delay))
            log.warning("schedule %s failed to spawn: %s", schedule.id, exc)
            return self.store.update(schedule)

        schedule.last_error = None
        schedule.last_run = iso(now)
        schedule.runs += 1
        schedule.last_task_id = (result or {}).get("id")
        if schedule.mode == "once":
            schedule.enabled = False
            schedule.next_run = None
        else:
            assert schedule.every
            next_run = parse_dt(schedule.next_run or iso(now)) + timedelta(seconds=schedule.every)
            while next_run <= now:
                next_run += timedelta(seconds=schedule.every)
            schedule.next_run = iso(next_run)
        return self.store.update(schedule)

    async def run_now(self, schedule_id: str) -> Schedule | None:
        schedule = self.store.get(schedule_id)
        if schedule is None:
            return None
        return await self.fire(schedule)

    async def tick_once(self, now: datetime | None = None) -> int:
        """Fire every due schedule once. Returns how many were fired."""
        fired = 0
        for schedule in self.store.due(now):
            await self.fire(schedule, now=now)
            fired += 1
        return fired

    async def run_forever(self) -> None:
        log.info("scheduler loop started (tick=%.1fs)", self.tick)
        while not self._stopped.is_set():
            try:
                await self.tick_once()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("scheduler tick failed")
            try:
                await asyncio.wait_for(self._stopped.wait(), timeout=self.tick)
            except asyncio.TimeoutError:
                pass

    def stop(self) -> None:
        self._stopped.set()
