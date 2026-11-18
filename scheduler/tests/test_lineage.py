"""Lineage tests (Phase 3): schedules fire children into their conversation.

- Scheduler.fire passes schedule.conversation_id to the spawner.
- Legacy schedules (conversation_id None) fire unchanged: the client payload
  is byte-identical to the pre-lineage shape.
- IsidoreClient.create_task forwards conversation_id only when truthy.
"""

import asyncio
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scheduler.client import IsidoreClient  # noqa: E402
from scheduler.core import Schedule, ScheduleStore, Scheduler, utcnow  # noqa: E402


class FakeSpawner:
    def __init__(self, fail: bool = False) -> None:
        self.calls: list[tuple[str, dict]] = []
        self.fail = fail

    async def create_task(self, prompt: str, **kwargs):
        if self.fail:
            raise RuntimeError("isidore down")
        self.calls.append((prompt, kwargs))
        return {"id": f"t_{len(self.calls)}"}


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self._payload = payload
        self.status_code = 202
        self.text = ""
        self.reason_phrase = "Accepted"

    def json(self) -> dict:
        return self._payload


class FireLineageTest(unittest.TestCase):
    def make(self, tmp, spawner):
        store = ScheduleStore(tmp)
        return store, Scheduler(store, spawner, tick=0.01, retry_delay=0.01)

    def test_fire_carries_conversation_id(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                spawner = FakeSpawner()
                _, scheduler = self.make(tmp, spawner)
                schedule = scheduler.add_once(
                    "p", utcnow() - timedelta(seconds=1), conversation_id="t_root", reply_to="telegram:42"
                )
                await scheduler.tick_once()
                self.assertEqual(len(spawner.calls), 1)
                prompt, kwargs = spawner.calls[0]
                self.assertEqual(prompt, "p")
                self.assertEqual(kwargs["conversation_id"], "t_root")
                self.assertEqual(kwargs["schedule_id"], schedule.id)
                self.assertEqual(kwargs["origin"], "telegram:42")

        asyncio.run(scenario())

    def test_legacy_schedule_fires_unchanged(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                spawner = FakeSpawner()
                _, scheduler = self.make(tmp, spawner)
                # Legacy record: no conversation_id key at all.
                store = ScheduleStore(tmp)
                legacy = Schedule.from_dict({"prompt": "p", "mode": "once", "next_run": "2000-01-01T00:00:00+00:00"})
                self.assertIsNone(legacy.conversation_id)
                store.add(legacy)
                scheduler = Scheduler(store, spawner, tick=0.01, retry_delay=0.01)
                await scheduler.tick_once()
                self.assertEqual(len(spawner.calls), 1)
                _, kwargs = spawner.calls[0]
                # The kwarg is present but None; the client drops falsy values,
                # so the HTTP payload stays exactly the pre-lineage shape.
                self.assertIsNone(kwargs.get("conversation_id"))
                self.assertEqual(kwargs["origin"], "scheduler")

        asyncio.run(scenario())

    def test_fire_through_client_forwards_conversation_id(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                client = IsidoreClient("http://isidore.test", token="admin")
                posted: list[dict] = []

                async def fake_post(url, json=None, headers=None):
                    posted.append(json)
                    return FakeResponse({"id": "t_child"})

                with mock.patch.object(client._client, "post", side_effect=fake_post):
                    store = ScheduleStore(tmp)
                    scheduler = Scheduler(store, client, tick=0.01, retry_delay=0.01)
                    scheduler.add_once("p", utcnow() - timedelta(seconds=1), conversation_id="t_root")
                    scheduler.add_once("legacy", utcnow() - timedelta(seconds=1))
                    await scheduler.tick_once()
                self.assertEqual(len(posted), 2)
                by_prompt = {payload["prompt"]: payload for payload in posted}
                self.assertEqual(by_prompt["p"]["conversation_id"], "t_root")
                # Legacy payload: no conversation_id key at all.
                self.assertNotIn("conversation_id", by_prompt["legacy"])
                self.assertEqual(set(by_prompt["legacy"]), {"prompt", "origin", "schedule_id"})
                await client.aclose()

        asyncio.run(scenario())


class ClientForwardingTest(unittest.TestCase):
    def run_create(self, **kwargs) -> dict:
        async def scenario():
            client = IsidoreClient("http://isidore.test", token="admin")
            posted: list[dict] = []

            async def fake_post(url, json=None, headers=None):
                posted.append(json)
                return FakeResponse({"id": "t_1"})

            with mock.patch.object(client._client, "post", side_effect=fake_post):
                await client.create_task("p", **kwargs)
            await client.aclose()
            return posted[0]

        return asyncio.run(scenario())

    def test_conversation_id_forwarded_when_truthy(self):
        payload = self.run_create(conversation_id="t_root", model="m", schedule_id="s_1")
        self.assertEqual(payload["conversation_id"], "t_root")
        self.assertEqual(payload["model"], "m")
        self.assertEqual(payload["schedule_id"], "s_1")

    def test_falsy_conversation_id_not_forwarded(self):
        for value in (None, ""):
            payload = self.run_create(conversation_id=value)
            self.assertNotIn("conversation_id", payload)
        payload = self.run_create()
        self.assertNotIn("conversation_id", payload)
        self.assertEqual(payload, {"prompt": "p", "origin": "scheduler"})


if __name__ == "__main__":
    unittest.main()
