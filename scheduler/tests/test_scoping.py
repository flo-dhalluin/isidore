import asyncio
import atexit
import contextlib
import io
import json
import logging
import os
import secrets
import shutil
import sys
import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Keep TestClient's per-request httpx logs out of the test output.
logging.getLogger("httpx").setLevel(logging.WARNING)

# Importing scheduler.server builds a ScheduleStore at SCHEDULER_STATE and
# bootstraps the admin token into SCHEDULER_SHARED_DIR; point both at throwaway
# dirs so the test run never creates /state or /shared on the host.
_STATE_TMP = tempfile.mkdtemp(prefix="scheduler-scoping-import-")
_SHARED_TMP = tempfile.mkdtemp(prefix="scheduler-scoping-shared-")
os.environ["SCHEDULER_STATE"] = _STATE_TMP
os.environ["SCHEDULER_SHARED_DIR"] = _SHARED_TMP
atexit.register(shutil.rmtree, _STATE_TMP, ignore_errors=True)
atexit.register(shutil.rmtree, _SHARED_TMP, ignore_errors=True)

from mcp.server.mcpserver.exceptions import ToolError  # noqa: E402
from starlette.applications import Starlette  # noqa: E402
from starlette.routing import Route  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

import scheduler.server as server  # noqa: E402
from scheduler.core import Schedule, ScheduleStore, Scheduler, utcnow  # noqa: E402
from scheduler.scoping import (  # noqa: E402
    CONVERSATION_HEADER,
    TASK_TOKEN_HEADER,
    ConversationScope,
    Scope,
    ScopeError,
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


class FakeWhoami:
    """Async whoami stub mapping token -> scope dict (None for unknown)."""

    def __init__(self, mapping: dict | None = None) -> None:
        self.mapping = mapping or {}
        self.calls: list[str] = []

    async def __call__(self, token: str):
        self.calls.append(token)
        return self.mapping.get(token)


def make_scheduler(tmp, spawner=None) -> Scheduler:
    store = ScheduleStore(tmp)
    return Scheduler(store, spawner or FakeSpawner(), tick=0.01, retry_delay=0.01)


def ctx(token=None, admin=False, origin=None) -> SimpleNamespace:
    """A fake MCP Context exposing only .headers (lowercase keys)."""
    headers = {}
    if token:
        headers[TASK_TOKEN_HEADER] = token
    if admin:
        headers["authorization"] = "Bearer admin-secret"
    if origin:
        headers["x-isidore-origin"] = origin
    return SimpleNamespace(headers=headers)


class ConversationScopeTest(unittest.TestCase):
    def test_valid_token_returns_scope(self):
        async def scenario():
            whoami = FakeWhoami({"tok": {"task_id": "t_1", "root_id": "t_1", "origin": "web"}})
            guard = ConversationScope(whoami, enabled=True)
            scope = await guard.resolve({TASK_TOKEN_HEADER: "tok"})
            self.assertEqual(scope, Scope("t_1", "t_1", "web"))

        asyncio.run(scenario())

    def test_missing_token_denied(self):
        async def scenario():
            guard = ConversationScope(FakeWhoami(), enabled=True)
            with self.assertRaises(ScopeError):
                await guard.resolve({})
            with self.assertRaises(ScopeError):
                await guard.resolve(None)

        asyncio.run(scenario())

    def test_invalid_token_denied(self):
        async def scenario():
            guard = ConversationScope(FakeWhoami({}), enabled=True)
            with self.assertRaises(ScopeError):
                await guard.resolve({TASK_TOKEN_HEADER: "bad"})

        asyncio.run(scenario())

    def test_unreachable_denied(self):
        async def scenario():
            async def whoami(token):
                return None  # isidore unreachable -> None -> fail closed

            guard = ConversationScope(whoami, enabled=True)
            with self.assertRaises(ScopeError):
                await guard.resolve({TASK_TOKEN_HEADER: "tok"})

        asyncio.run(scenario())

    def test_scoping_off_is_open(self):
        async def scenario():
            whoami = FakeWhoami()
            guard = ConversationScope(whoami, enabled=False)
            self.assertIsNone(await guard.resolve({}))
            self.assertIsNone(await guard.resolve({TASK_TOKEN_HEADER: "tok"}))
            self.assertEqual(whoami.calls, [])  # never introspects

        asyncio.run(scenario())

    def test_admin_bypasses_scoping(self):
        async def scenario():
            whoami = FakeWhoami()
            guard = ConversationScope(whoami, enabled=True)
            self.assertIsNone(await guard.resolve({}, admin=True))
            self.assertEqual(whoami.calls, [])

        asyncio.run(scenario())

    def test_cache_hit_avoids_second_introspection(self):
        async def scenario():
            whoami = FakeWhoami({"tok": {"task_id": "t_1", "root_id": "t_1", "origin": "web"}})
            guard = ConversationScope(whoami, enabled=True, ttl=30)
            first = await guard.resolve({TASK_TOKEN_HEADER: "tok"})
            second = await guard.resolve({TASK_TOKEN_HEADER: "tok"})
            self.assertEqual(first, second)
            self.assertEqual(len(whoami.calls), 1)

        asyncio.run(scenario())

    def test_cache_expires_after_ttl(self):
        async def scenario():
            now = [0.0]
            whoami = FakeWhoami({"tok": {"task_id": "t_1", "root_id": "t_1", "origin": "web"}})
            guard = ConversationScope(whoami, enabled=True, ttl=30, clock=lambda: now[0])
            await guard.resolve({TASK_TOKEN_HEADER: "tok"})
            now[0] = 31.0
            await guard.resolve({TASK_TOKEN_HEADER: "tok"})
            self.assertEqual(len(whoami.calls), 2)

        asyncio.run(scenario())

    def test_distinct_tokens_introspect_separately(self):
        async def scenario():
            whoami = FakeWhoami({"a": {"root_id": "r1"}, "b": {"root_id": "r2"}})
            guard = ConversationScope(whoami, enabled=True)
            self.assertEqual((await guard.resolve({TASK_TOKEN_HEADER: "a"})).root_id, "r1")
            self.assertEqual((await guard.resolve({TASK_TOKEN_HEADER: "b"})).root_id, "r2")
            self.assertEqual(len(whoami.calls), 2)

        asyncio.run(scenario())

    def test_expired_entries_evicted_on_lookup(self):
        async def scenario():
            now = [0.0]
            whoami = FakeWhoami({"a": {"root_id": "r1"}, "b": {"root_id": "r2"}})
            guard = ConversationScope(whoami, enabled=True, ttl=30, clock=lambda: now[0])
            await guard.resolve({TASK_TOKEN_HEADER: "a"})
            self.assertEqual(len(guard._cache), 1)
            now[0] = 31.0
            # Looking up a DIFFERENT token still evicts the expired entry.
            await guard.resolve({TASK_TOKEN_HEADER: "b"})
            self.assertEqual(len(guard._cache), 1)

        asyncio.run(scenario())


class ConversationPersistenceTest(unittest.TestCase):
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = ScheduleStore(tmp)
            schedule = store.add(Schedule(prompt="p", conversation_id="t_root"))
            reloaded = ScheduleStore(tmp).get(schedule.id)
            self.assertEqual(reloaded.conversation_id, "t_root")

    def test_legacy_record_defaults_to_none(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = ScheduleStore(tmp)
            schedule = store.add(Schedule(prompt="p"))
            data = schedule.to_dict()
            del data["conversation_id"]  # simulate a pre-scoping record
            (Path(tmp) / "schedules.json").write_text(json.dumps({"schedules": [data]}))
            reloaded = ScheduleStore(tmp).get(schedule.id)
            self.assertIsNone(reloaded.conversation_id)


class ToolScopingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.spawner = FakeSpawner()
        self.scheduler = make_scheduler(self.tmp, self.spawner)
        self.whoami = FakeWhoami(
            {
                "tokA": {"task_id": "t_A", "root_id": "t_A", "origin": "web"},
                "tokB": {"task_id": "t_B", "root_id": "t_B", "origin": "web"},
            }
        )
        self.guard = ConversationScope(self.whoami, enabled=True)
        self._patches = [
            mock.patch.object(server, "scheduler", self.scheduler),
            mock.patch.object(server, "scope_guard", self.guard),
            mock.patch.object(server, "TOKEN", "admin-secret"),
        ]
        for patch in self._patches:
            patch.start()

    def tearDown(self):
        for patch in self._patches:
            patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_schedule_task_stamps_conversation(self):
        async def scenario():
            data = json.loads(await server.schedule_task("p", at="+1h", ctx=ctx("tokA")))
            self.assertEqual(data["conversation_id"], "t_A")

        asyncio.run(scenario())

    def test_list_is_scoped_admin_sees_all(self):
        async def scenario():
            await server.schedule_task("a", at="+1h", ctx=ctx("tokA"))
            await server.schedule_task("b", at="+1h", ctx=ctx("tokB"))
            scoped = json.loads(await server.list_schedules(ctx=ctx("tokA")))
            self.assertEqual([s["prompt"] for s in scoped], ["a"])
            everything = json.loads(await server.list_schedules(ctx=ctx(admin=True)))
            self.assertEqual(len(everything), 2)

        asyncio.run(scenario())

    def test_get_cross_conversation_denied(self):
        async def scenario():
            sid = json.loads(await server.schedule_task("a", at="+1h", ctx=ctx("tokA")))["id"]
            await server.get_schedule(sid, ctx=ctx("tokA"))  # own: ok
            with self.assertRaises(ToolError):
                await server.get_schedule(sid, ctx=ctx("tokB"))

        asyncio.run(scenario())

    def test_cancel_is_scoped(self):
        async def scenario():
            sid = json.loads(await server.schedule_task("a", at="+1h", ctx=ctx("tokA")))["id"]
            with self.assertRaises(ToolError):
                await server.cancel_schedule(sid, ctx=ctx("tokB"))
            self.assertIsNotNone(self.scheduler.get(sid))  # untouched
            message = await server.cancel_schedule(sid, ctx=ctx("tokA"))
            self.assertIn(sid, message)
            self.assertIsNone(self.scheduler.get(sid))

        asyncio.run(scenario())

    def test_run_is_scoped(self):
        async def scenario():
            sid = json.loads(await server.schedule_task("a", at="+1h", ctx=ctx("tokA")))["id"]
            with self.assertRaises(ToolError):
                await server.run_schedule_now(sid, ctx=ctx("tokB"))
            data = json.loads(await server.run_schedule_now(sid, ctx=ctx("tokA")))
            self.assertEqual(data["runs"], 1)

        asyncio.run(scenario())

    def test_missing_token_fails_closed(self):
        async def scenario():
            with self.assertRaises(ToolError):
                await server.list_schedules(ctx=ctx())
            with self.assertRaises(ToolError):
                await server.schedule_task("p", at="+1h", ctx=ctx())

        asyncio.run(scenario())

    def test_invalid_token_fails_closed(self):
        async def scenario():
            with self.assertRaises(ToolError):
                await server.list_schedules(ctx=ctx("bogus"))

        asyncio.run(scenario())

    def test_legacy_schedule_invisible_to_task_token(self):
        async def scenario():
            legacy = self.scheduler.add_once("legacy", "+1h")  # conversation_id None
            self.assertEqual(json.loads(await server.list_schedules(ctx=ctx("tokA"))), [])
            with self.assertRaises(ToolError):
                await server.get_schedule(legacy.id, ctx=ctx("tokA"))

        asyncio.run(scenario())

    def test_reply_to_routing_preserved(self):
        async def scenario():
            data = json.loads(
                await server.schedule_task("p", at="+1h", ctx=ctx("tokA", origin="telegram:42"))
            )
            self.assertEqual(data["reply_to"], "telegram:42")
            self.assertEqual(data["conversation_id"], "t_A")

        asyncio.run(scenario())


class RestScopingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.scheduler = make_scheduler(self.tmp)
        self._patches = [
            mock.patch.object(server, "scheduler", self.scheduler),
            mock.patch.object(server, "TOKEN", "admin-secret"),
        ]
        for patch in self._patches:
            patch.start()
        app = Starlette(
            routes=[
                Route("/api/schedules", server.api_schedules, methods=["GET", "POST"]),
                Route("/api/schedules/{schedule_id}", server.api_schedule, methods=["GET", "DELETE"]),
                Route("/api/schedules/{schedule_id}/run", server.api_run, methods=["POST"]),
            ]
        )
        self.client = TestClient(app)
        self.admin = {"Authorization": "Bearer admin-secret"}

    def tearDown(self):
        for patch in self._patches:
            patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _create(self, prompt, conversation=None):
        headers = dict(self.admin)
        if conversation:
            headers[CONVERSATION_HEADER] = conversation
        response = self.client.post("/api/schedules", json={"prompt": prompt, "at": "+1h"}, headers=headers)
        self.assertEqual(response.status_code, 201)
        return response.json()

    def test_post_stamps_and_get_filters(self):
        self._create("a", "t_A")
        self._create("b", "t_B")
        scoped = self.client.get("/api/schedules", headers={**self.admin, CONVERSATION_HEADER: "t_A"})
        self.assertEqual([s["prompt"] for s in scoped.json()["schedules"]], ["a"])
        everything = self.client.get("/api/schedules", headers=self.admin)
        self.assertEqual(len(everything.json()["schedules"]), 2)

    def test_cross_conversation_404(self):
        sid = self._create("a", "t_A")["id"]
        other = {**self.admin, CONVERSATION_HEADER: "t_B"}
        self.assertEqual(self.client.get(f"/api/schedules/{sid}", headers=other).status_code, 404)
        self.assertEqual(self.client.delete(f"/api/schedules/{sid}", headers=other).status_code, 404)
        self.assertEqual(self.client.post(f"/api/schedules/{sid}/run", headers=other).status_code, 404)
        own = {**self.admin, CONVERSATION_HEADER: "t_A"}
        self.assertEqual(self.client.get(f"/api/schedules/{sid}", headers=own).status_code, 200)

    def test_requires_admin_auth(self):
        self.assertEqual(self.client.get("/api/schedules").status_code, 401)
        # A conversation header alone never bypasses admin auth.
        self.assertEqual(
            self.client.get("/api/schedules", headers={CONVERSATION_HEADER: "t_A"}).status_code, 401
        )

    def test_plain_admin_full_access(self):
        sid = self._create("a")["id"]
        self.assertEqual(self.client.get(f"/api/schedules/{sid}", headers=self.admin).status_code, 200)
        self.assertEqual(self.client.post(f"/api/schedules/{sid}/run", headers=self.admin).status_code, 200)
        self.assertEqual(self.client.delete(f"/api/schedules/{sid}", headers=self.admin).status_code, 204)


class AdminTokenBootstrapTest(unittest.TestCase):
    """ensure_admin_token: fail-closed generation, 0600 file, dev fallbacks."""

    def _generate(self, **kwargs):
        # Keep the loud startup banner out of the test output.
        with contextlib.redirect_stderr(io.StringIO()):
            return server.ensure_admin_token(None, **kwargs)

    def test_generated_token_persisted_0600(self):
        with tempfile.TemporaryDirectory() as tmp:
            token = self._generate(shared_dir=tmp, state_dir=tmp)
            self.assertRegex(token, r"^[0-9a-f]{64}$")
            path = Path(tmp) / "scheduler-token"
            self.assertEqual(path.read_text().strip(), token)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_explicit_token_passthrough_no_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.assertEqual(server.ensure_admin_token("explicit", shared_dir=tmp, state_dir=tmp), "explicit")
            self.assertFalse((Path(tmp) / "scheduler-token").exists())

    def test_falls_back_to_state_dir_when_shared_unwritable(self):
        with tempfile.TemporaryDirectory() as tmp:
            blocker = Path(tmp) / "not-a-dir"
            blocker.write_text("x")  # makedirs/open under it raises OSError
            token = self._generate(shared_dir=str(blocker), state_dir=tmp)
            self.assertEqual((Path(tmp) / "scheduler-token").read_text().strip(), token)

    def test_no_writable_dir_still_returns_token(self):
        with tempfile.TemporaryDirectory() as tmp:
            blocker = Path(tmp) / "not-a-dir"
            blocker.write_text("x")
            token = self._generate(shared_dir=str(blocker), state_dir=str(blocker))
            self.assertRegex(token, r"^[0-9a-f]{64}$")
            self.assertFalse((Path(tmp) / "scheduler-token").exists())

    def test_import_time_bootstrap_left_a_token_file(self):
        # The module-level bootstrap ran against the throwaway shared dir.
        self.assertRegex(server.TOKEN, r"^[0-9a-f]{64}$")
        self.assertEqual((Path(_SHARED_TMP) / "scheduler-token").read_text().strip(), server.TOKEN)


class RestAuthGeneratedTokenTest(unittest.TestCase):
    """REST is never unauthenticated, including with a generated token."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.scheduler = make_scheduler(self.tmp)
        with contextlib.redirect_stderr(io.StringIO()):
            self.token = server.ensure_admin_token(None, shared_dir=self.tmp, state_dir=self.tmp)
        self._patches = [
            mock.patch.object(server, "scheduler", self.scheduler),
            mock.patch.object(server, "TOKEN", self.token),
        ]
        for patch in self._patches:
            patch.start()
        app = Starlette(
            routes=[
                Route("/api/schedules", server.api_schedules, methods=["GET", "POST"]),
                Route("/api/schedules/{schedule_id}", server.api_schedule, methods=["GET", "DELETE"]),
                Route("/api/schedules/{schedule_id}/run", server.api_run, methods=["POST"]),
            ]
        )
        self.client = TestClient(app)

    def tearDown(self):
        for patch in self._patches:
            patch.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_unauthenticated_and_wrong_tokens_rejected(self):
        self.assertEqual(self.client.get("/api/schedules").status_code, 401)
        self.assertEqual(self.client.post("/api/schedules", json={"prompt": "p", "at": "+1h"}).status_code, 401)
        wrong = {"Authorization": f"Bearer {secrets.token_hex(32)}"}
        self.assertEqual(self.client.get("/api/schedules", headers=wrong).status_code, 401)
        self.assertEqual(self.client.get("/api/schedules?token=wrong").status_code, 401)
        # A conversation header alone never bypasses auth.
        self.assertEqual(
            self.client.get("/api/schedules", headers={CONVERSATION_HEADER: "t_A"}).status_code, 401
        )

    def test_generated_token_accepted_bearer_and_query(self):
        self.assertEqual(
            self.client.get("/api/schedules", headers={"Authorization": f"Bearer {self.token}"}).status_code,
            200,
        )
        self.assertEqual(self.client.get(f"/api/schedules?token={self.token}").status_code, 200)

    def test_unset_token_fails_closed(self):
        # Defense in depth: even if TOKEN were somehow unset, deny — never open.
        with mock.patch.object(server, "TOKEN", None):
            self.assertEqual(self.client.get("/api/schedules").status_code, 401)
            self.assertEqual(self.client.get("/api/schedules?token=").status_code, 401)


class McpAdminGeneratedTokenTest(unittest.TestCase):
    """The /mcp admin bypass works with the generated token."""

    def test_admin_bearer_generated_token_unscoped(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                scheduler = make_scheduler(tmp)
                scheduler.add_once("a", "+1h", conversation_id="t_A")
                scheduler.add_once("b", "+1h", conversation_id="t_B")
                with contextlib.redirect_stderr(io.StringIO()):
                    token = server.ensure_admin_token(None, shared_dir=tmp, state_dir=tmp)
                guard = ConversationScope(FakeWhoami(), enabled=True)
                admin_ctx = SimpleNamespace(headers={"authorization": f"Bearer {token}"})
                with (
                    mock.patch.object(server, "scheduler", scheduler),
                    mock.patch.object(server, "scope_guard", guard),
                    mock.patch.object(server, "TOKEN", token),
                ):
                    everything = json.loads(await server.list_schedules(ctx=admin_ctx))
                    self.assertEqual(len(everything), 2)
                    # A task token still fails closed (whoami knows nothing).
                    with self.assertRaises(ToolError):
                        await server.list_schedules(ctx=ctx("unknown-task-token"))

        asyncio.run(scenario())


class FireLineageKwargsTest(unittest.TestCase):
    def test_fire_passes_origin_model_schedule_id_and_conversation(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                spawner = FakeSpawner()
                store = ScheduleStore(tmp)
                scheduler = Scheduler(store, spawner, tick=0.01, retry_delay=0.01)
                schedule = scheduler.add_once(
                    "p",
                    utcnow() - timedelta(seconds=1),
                    conversation_id="t_root",
                    reply_to="telegram:42",
                )
                await scheduler.tick_once()
                _, kwargs = spawner.calls[0]
                self.assertEqual(kwargs["origin"], "telegram:42")
                self.assertEqual(kwargs["schedule_id"], schedule.id)
                # Lineage (Phase 3): the conversation id travels to isidore so
                # the child inherits the conversation's tools pinned at spawn.
                self.assertEqual(kwargs["conversation_id"], "t_root")
                # parent/thread stay server-derived: the child is a NEW root.
                self.assertNotIn("parent_id", kwargs)
                self.assertNotIn("thread_id", kwargs)

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
