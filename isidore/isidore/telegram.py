"""Optional Telegram front-end for isidore.

The bot uses long polling (no public webhook needed) and is disabled unless
``ISIDORE_TELEGRAM_TOKEN`` is set. Only chats listed in
``ISIDORE_TELEGRAM_CHATS`` (comma separated) may create or inspect tasks; an
empty allow-list denies everyone, which is the safe default.

Commands::

    /new <prompt>      create a task (plain text also works)
    /list              recent tasks
    /status <id>       one task, including its output
    /cancel <id>       cancel a queued/running task
    /help              this message
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

import httpx

from .runner import PiRunner
from .store import Task, TaskStore

log = logging.getLogger("isidore.telegram")

MAX_MESSAGE = 3_800  # Telegram's hard limit is 4096; leave room for a header.


def _chunks(text: str, size: int = MAX_MESSAGE) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)] or [""]


class TelegramBot:
    def __init__(
        self,
        token: str,
        runner: PiRunner,
        store: TaskStore,
        *,
        allowed_chats: set[str] | None = None,
        api_base: str = "https://api.telegram.org",
        poll_timeout: int = 30,
    ) -> None:
        self.token = token
        self.runner = runner
        self.store = store
        self.allowed_chats = allowed_chats or set()
        self.api_base = api_base.rstrip("/")
        self.poll_timeout = poll_timeout
        self._client = httpx.AsyncClient(timeout=poll_timeout + 10)
        self._offset = 0
        self._stopped = asyncio.Event()

    # -- lifecycle --------------------------------------------------------
    async def run(self) -> None:
        log.info("telegram bot started (%d allowed chat(s))", len(self.allowed_chats))
        while not self._stopped.is_set():
            try:
                updates = await self._get_updates()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - keep polling through outages
                log.warning("getUpdates failed: %s", exc)
                await asyncio.sleep(5)
                continue
            for update in updates:
                try:
                    await self._handle(update)
                except Exception:  # noqa: BLE001
                    log.exception("failed to handle update %s", update.get("update_id"))

    async def stop(self) -> None:
        self._stopped.set()
        await self._client.aclose()

    # -- Telegram API -----------------------------------------------------
    async def _get_updates(self) -> list[dict[str, Any]]:
        response = await self._client.get(
            f"{self.api_base}/bot{self.token}/getUpdates",
            params={"offset": self._offset, "timeout": self.poll_timeout, "allowed_updates": '["message"]'},
        )
        response.raise_for_status()
        data = response.json()
        if not data.get("ok"):
            raise RuntimeError(data.get("description", "getUpdates failed"))
        updates = data.get("result", [])
        for update in updates:
            self._offset = max(self._offset, int(update.get("update_id", 0)) + 1)
        return updates

    async def send(self, chat_id: str | int, text: str) -> None:
        for chunk in _chunks(text):
            try:
                await self._client.post(
                    f"{self.api_base}/bot{self.token}/sendMessage",
                    json={"chat_id": chat_id, "text": chunk, "disable_web_page_preview": True},
                )
            except httpx.HTTPError as exc:
                log.warning("sendMessage to %s failed: %s", chat_id, exc)
                return

    # -- command handling -------------------------------------------------
    async def _handle(self, update: dict[str, Any]) -> None:
        message = update.get("message") or {}
        chat = message.get("chat") or {}
        chat_id = str(chat.get("id", ""))
        text = (message.get("text") or "").strip()
        if not chat_id or not text:
            return
        if chat_id not in self.allowed_chats:
            log.info("ignoring message from unauthorised chat %s", chat_id)
            return

        command, _, rest = text.partition(" ")
        command = command.split("@", 1)[0].lower()
        rest = rest.strip()

        if command in {"/start", "/help"}:
            await self.send(chat_id, self._help())
        elif command == "/new":
            if not rest:
                await self.send(chat_id, "Usage: /new <prompt>")
            else:
                await self._create(chat_id, rest)
        elif command == "/list":
            await self._list(chat_id)
        elif command == "/status":
            await self._status(chat_id, rest)
        elif command == "/cancel":
            await self._cancel(chat_id, rest)
        elif command.startswith("/"):
            await self.send(chat_id, f"Unknown command {command}. Try /help.")
        else:
            # Plain text is the friendliest way to spawn a task.
            await self._create(chat_id, text)

    async def _create(self, chat_id: str, prompt: str) -> None:
        task = self.runner.create(prompt, origin=f"telegram:{chat_id}")
        await self.send(chat_id, f"Queued {task.id}\n{prompt[:500]}")

    async def _list(self, chat_id: str) -> None:
        tasks = self.store.list(limit=15)
        if not tasks:
            await self.send(chat_id, "No tasks yet.")
            return
        lines = [f"{t.id}  {t.status:<9}  {t.prompt[:60]}" for t in tasks]
        await self.send(chat_id, "\n".join(lines))

    async def _status(self, chat_id: str, task_id: str) -> None:
        task = self.store.get(task_id)
        if task is None:
            await self.send(chat_id, f"No task {task_id!r}.")
            return
        await self.send(chat_id, self._format_task(task))

    async def _cancel(self, chat_id: str, task_id: str) -> None:
        if not task_id:
            await self.send(chat_id, "Usage: /cancel <task-id>")
            return
        if await self.runner.cancel(task_id):
            await self.send(chat_id, f"Cancelling {task_id}.")
        else:
            await self.send(chat_id, f"{task_id} is unknown or already finished.")

    # -- notifications ----------------------------------------------------
    async def notify(self, task: Task) -> None:
        """Called by the runner whenever a task changes state."""
        if not task.origin.startswith("telegram:"):
            return
        chat_id = task.origin.split(":", 1)[1]
        if task.status == "running":
            return  # avoid a message for every intermediate update
        if task.status == "queued":
            return
        await self.send(chat_id, self._format_task(task))

    # -- formatting -------------------------------------------------------
    @staticmethod
    def _format_task(task: Task) -> str:
        head = f"{task.id}  {task.status}"
        if task.exit_code is not None:
            head += f"  (exit {task.exit_code})"
        body = task.output.strip()
        if task.error:
            body += f"\n\nstderr:\n{task.error.strip()}"
        return f"{head}\n{task.prompt[:300]}\n\n{body}".strip()

    @staticmethod
    def _help() -> str:
        return (
            "isidore - spawn isolated Pi tasks\n\n"
            "/new <prompt>   create a task (plain text also works)\n"
            "/list           recent tasks\n"
            "/status <id>    task details and output\n"
            "/cancel <id>    cancel a task\n"
            "/help           this message"
        )
