import asyncio
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scheduler.core import (  # noqa: E402
    Schedule,
    ScheduleStore,
    Scheduler,
    iso,
    parse_dt,
    parse_duration,
    utcnow,
)


class FakeSpawner:
    def __init__(self, fail: bool = False) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.fail = fail

    async def create_task(self, prompt: str, **kwargs):
        if self.fail:
            raise RuntimeError("isidore down")
        self.calls.append((prompt, kwargs))
        return {"id": f"t_{len(self.calls)}"}


class DurationTest(unittest.TestCase):
    def test_plain_seconds(self):
        self.assertEqual(parse_duration(90), 90)
        self.assertEqual(parse_duration("90"), 90)

    def test_units_and_combinations(self):
        self.assertEqual(parse_duration("30s"), 30)
        self.assertEqual(parse_duration("5m"), 300)
        self.assertEqual(parse_duration("2h"), 7200)
        self.assertEqual(parse_duration("1d"), 86400)
        self.assertEqual(parse_duration("1h30m"), 5400)

    def test_invalid(self):
        for value in ("", "0", "-5", "5minutes", "abc"):
            with self.assertRaises(ValueError):
                parse_duration(value)


class ParseTimeTest(unittest.TestCase):
    def test_iso_with_z(self):
        parsed = parse_dt("2025-01-31T09:00:00Z")
        self.assertEqual(parsed, datetime(2025, 1, 31, 9, tzinfo=timezone.utc))

    def test_naive_is_utc(self):
        self.assertEqual(parse_dt("2025-01-31T09:00:00").tzinfo, timezone.utc)

    def test_relative(self):
        before = utcnow()
        parsed = parse_dt("+30m")
        self.assertGreaterEqual(parsed, before + timedelta(minutes=29))


class SchedulerTest(unittest.TestCase):
    def make(self, tmp, spawner=None):
        store = ScheduleStore(tmp)
        return store, Scheduler(store, spawner or FakeSpawner(), tick=0.01, retry_delay=0.01)

    def test_add_requires_exactly_one_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, scheduler = self.make(tmp)
            with self.assertRaises(ValueError):
                scheduler.add("p")
            with self.assertRaises(ValueError):
                scheduler.add("p", at="+1h", every="1h")

    def test_add_once(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, scheduler = self.make(tmp)
            schedule = scheduler.add_once("p", "+1h")
            self.assertEqual(schedule.mode, "once")
            self.assertEqual(schedule.next_run, schedule.at)
            self.assertTrue(schedule.enabled)

    def test_add_interval(self):
        with tempfile.TemporaryDirectory() as tmp:
            _, scheduler = self.make(tmp)
            schedule = scheduler.add_interval("p", "30m")
            self.assertEqual(schedule.mode, "interval")
            self.assertEqual(schedule.every, 1800)
            self.assertGreater(parse_dt(schedule.next_run), utcnow())

    def test_once_fires_and_disables(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                spawner = FakeSpawner()
                store, scheduler = self.make(tmp, spawner)
                schedule = scheduler.add_once("p", utcnow() - timedelta(seconds=1))
                fired = await scheduler.tick_once()
                self.assertEqual(fired, 1)
                self.assertEqual(len(spawner.calls), 1)
                self.assertEqual(spawner.calls[0][1]["schedule_id"], schedule.id)
                updated = store.get(schedule.id)
                self.assertFalse(updated.enabled)
                self.assertIsNone(updated.next_run)
                self.assertEqual(updated.runs, 1)
                self.assertEqual(updated.last_task_id, "t_1")

        asyncio.run(scenario())

    def test_reply_to_becomes_task_origin(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                spawner = FakeSpawner()
                store, scheduler = self.make(tmp, spawner)
                past = utcnow() - timedelta(seconds=1)
                scheduler.add_once("p", past, reply_to="telegram:42")
                scheduler.add_once("q", past)
                await scheduler.tick_once()
                origins = {prompt: kwargs["origin"] for prompt, kwargs in spawner.calls}
                self.assertEqual(origins, {"p": "telegram:42", "q": "scheduler"})

        asyncio.run(scenario())

    def test_interval_advances(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                spawner = FakeSpawner()
                store, scheduler = self.make(tmp, spawner)
                schedule = scheduler.add_interval("p", "1h")
                schedule.next_run = iso(utcnow() - timedelta(seconds=1))
                store.update(schedule)
                await scheduler.tick_once()
                updated = store.get(schedule.id)
                self.assertTrue(updated.enabled)
                self.assertGreater(parse_dt(updated.next_run), utcnow())
                self.assertEqual(updated.runs, 1)

        asyncio.run(scenario())

    def test_failure_keeps_schedule_and_records_error(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                store, scheduler = self.make(tmp, FakeSpawner(fail=True))
                schedule = scheduler.add_once("p", utcnow() - timedelta(seconds=1))
                await scheduler.tick_once()
                updated = store.get(schedule.id)
                self.assertTrue(updated.enabled)
                self.assertIn("isidore down", updated.last_error)
                self.assertIsNotNone(updated.next_run)

        asyncio.run(scenario())

    def test_run_now(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                spawner = FakeSpawner()
                store, scheduler = self.make(tmp, spawner)
                schedule = scheduler.add_once("p", "+1h")
                updated = await scheduler.run_now(schedule.id)
                self.assertEqual(updated.runs, 1)
                self.assertFalse(updated.enabled)
                self.assertEqual(len(spawner.calls), 1)

        asyncio.run(scenario())

    def test_persistence_and_cancel(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, scheduler = self.make(tmp)
            schedule = scheduler.add_interval("p", "1h")
            reloaded = ScheduleStore(tmp)
            self.assertEqual(reloaded.get(schedule.id).prompt, "p")
            self.assertTrue(scheduler.cancel(schedule.id))
            self.assertIsNone(ScheduleStore(tmp).get(schedule.id))

    def test_due_ignores_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            store, scheduler = self.make(tmp)
            schedule = scheduler.add_once("p", utcnow() - timedelta(seconds=1))
            schedule.enabled = False
            store.update(schedule)
            self.assertEqual(store.due(), [])


if __name__ == "__main__":
    unittest.main()
