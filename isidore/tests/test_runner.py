import asyncio
import atexit
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from isidore.runner import PiRunner, build_command, summarise_event  # noqa: E402
from isidore.store import Task, TaskStore  # noqa: E402

# /tmp is often mounted noexec, so fake executables live next to the tests.
BIN_DIR = Path(tempfile.mkdtemp(prefix=".isidore-test-bin-", dir=Path(__file__).resolve().parents[1]))
atexit.register(shutil.rmtree, BIN_DIR, ignore_errors=True)
_counter = 0


def fake_pi(directory: str, body: str) -> str:
    global _counter
    _counter += 1
    path = BIN_DIR / f"fake-pi-{_counter}"
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(0o755)
    return str(path)


async def wait_done(task: Task, timeout: float = 5.0) -> None:
    for _ in range(int(timeout / 0.02)):
        if task.done:
            return
        await asyncio.sleep(0.02)
    raise AssertionError(f"task did not finish: {task.status}")


class BuildCommandTest(unittest.TestCase):
    def test_print_mode(self):
        cmd = build_command(Task(prompt="hello world"), pi_bin="pi", model="m")
        self.assertEqual(cmd[:3], ["pi", "--no-session", "--no-approve"])
        self.assertIn("--print", cmd)
        self.assertEqual(cmd[-2:], ["--", "hello world"])
        self.assertIn("--model", cmd)

    def test_session_id_replaces_no_session(self):
        cmd = build_command(Task(prompt="p"), session_id="t_abc123")
        self.assertIn("--session-id", cmd)
        self.assertIn("t_abc123", cmd)
        self.assertNotIn("--no-session", cmd)

    def test_json_mode_and_task_model_wins(self):
        task = Task(prompt="p", model="task-model")
        cmd = build_command(task, mode="json", model="default-model")
        self.assertIn("--mode", cmd)
        self.assertIn("json", cmd)
        self.assertIn("task-model", cmd)
        self.assertNotIn("default-model", cmd)


class SummariseEventTest(unittest.TestCase):
    def test_assistant_message(self):
        record = {"type": "message_end", "message": {"role": "assistant", "content": [{"type": "text", "text": "hi"}]}}
        self.assertIn("hi", summarise_event(record))

    def test_text_delta(self):
        record = {"type": "message_update", "assistantMessageEvent": {"type": "text_delta", "delta": "abc"}}
        self.assertEqual(summarise_event(record), "abc")

    def test_unknown_event(self):
        self.assertIsNone(summarise_event({"type": "something_new"}))


class RunnerTest(unittest.TestCase):
    def test_success(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                store = TaskStore(Path(tmp) / "tasks")
                runner = PiRunner(
                    store,
                    workspace_root=Path(tmp) / "ws",
                    pi_bin=fake_pi(tmp, 'echo "args: $*"\n'),
                )
                task = runner.create("hello")
                await wait_done(task)
                self.assertEqual(task.status, "succeeded")
                self.assertIn("hello", task.output)
                self.assertTrue(Path(task.workspace).is_dir())
                await runner.aclose()

        asyncio.run(scenario())

    def test_failure(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                store = TaskStore(Path(tmp) / "tasks")
                runner = PiRunner(
                    store,
                    workspace_root=Path(tmp) / "ws",
                    pi_bin=fake_pi(tmp, "echo boom >&2\nexit 3\n"),
                )
                task = runner.create("fail")
                await wait_done(task)
                self.assertEqual(task.status, "failed")
                self.assertEqual(task.exit_code, 3)
                self.assertIn("boom", task.error)
                await runner.aclose()

        asyncio.run(scenario())

    def test_timeout(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                store = TaskStore(Path(tmp) / "tasks")
                runner = PiRunner(
                    store,
                    workspace_root=Path(tmp) / "ws",
                    pi_bin=fake_pi(tmp, "sleep 5\n"),
                    timeout=0.2,
                )
                task = runner.create("slow")
                await wait_done(task)
                self.assertEqual(task.status, "timeout")
                await runner.aclose()

        asyncio.run(scenario())

    def test_cancel(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                store = TaskStore(Path(tmp) / "tasks")
                runner = PiRunner(
                    store,
                    workspace_root=Path(tmp) / "ws",
                    pi_bin=fake_pi(tmp, "sleep 5\n"),
                )
                task = runner.create("cancel me")
                for _ in range(100):
                    if task.status == "running":
                        break
                    await asyncio.sleep(0.02)
                self.assertTrue(await runner.cancel(task.id))
                await wait_done(task)
                self.assertEqual(task.status, "cancelled")
                await runner.aclose()

        asyncio.run(scenario())

    def test_json_mode_transcript(self):
        async def scenario():
            with tempfile.TemporaryDirectory() as tmp:
                store = TaskStore(Path(tmp) / "tasks")
                body = (
                    "printf '%s\\n' "
                    "'{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"Hel\"}}' "
                    "'{\"type\":\"message_update\",\"assistantMessageEvent\":{\"type\":\"text_delta\",\"delta\":\"lo\"}}'\n"
                )
                runner = PiRunner(
                    store,
                    workspace_root=Path(tmp) / "ws",
                    pi_bin=fake_pi(tmp, body),
                    mode="json",
                )
                task = runner.create("json")
                await wait_done(task)
                self.assertEqual(task.status, "succeeded")
                self.assertIn("Hello", task.output)
                await runner.aclose()

        asyncio.run(scenario())


if __name__ == "__main__":
    unittest.main()
