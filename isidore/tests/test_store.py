import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from isidore.store import Task, TaskStore  # noqa: E402


class TaskStoreTest(unittest.TestCase):
    def test_add_get_list_and_reload(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = TaskStore(tmp)
            first = store.add(Task(prompt="one"))
            second = store.add(Task(prompt="two"))
            self.assertEqual(store.get(first.id).prompt, "one")
            self.assertEqual([t.id for t in store.list()], [second.id, first.id])

            reloaded = TaskStore(tmp)
            self.assertEqual(reloaded.count(), 2)
            self.assertEqual(reloaded.get(first.id).prompt, "one")

    def test_update_persists(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = TaskStore(tmp)
            task = store.add(Task(prompt="x"))
            task.status = "succeeded"
            task.output = "done"
            store.update(task)
            self.assertEqual(TaskStore(tmp).get(task.id).output, "done")

    def test_output_is_clipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = TaskStore(tmp, max_output=20)
            task = store.add(Task(prompt="x"))
            task.output = "a" * 100
            store.update(task)
            self.assertLess(len(task.output), 100)
            self.assertIn("truncated", task.output)

    def test_corrupt_record_is_skipped(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "t_broken.json").write_text("{not json")
            store = TaskStore(tmp)
            self.assertEqual(store.count(), 0)

    def test_remove_deletes_record(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = TaskStore(tmp)
            task = store.add(Task(prompt="x"))
            self.assertTrue(store.remove(task.id))
            self.assertIsNone(store.get(task.id))
            self.assertFalse(Path(tmp, task.id + ".json").exists())
            self.assertFalse(store.remove(task.id))
            self.assertEqual(TaskStore(tmp).count(), 0)

    def test_thread_is_ordered_and_shared(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = TaskStore(tmp)
            root = store.add(Task(prompt="first"))
            follow = store.add(Task(prompt="second", parent_id=root.id, thread_id=root.root_id))
            self.assertEqual(root.root_id, root.id)
            self.assertEqual(follow.root_id, root.id)
            self.assertEqual([t.id for t in store.thread(root.id)], [root.id, follow.id])
            self.assertEqual(store.thread("t_missing"), [])


if __name__ == "__main__":
    unittest.main()
