"""Conversation scoping for scheduler MCP tool calls.

When ``SCHEDULER_MCP_SCOPING`` is on (the default), every MCP tool call must
present a valid isidore task token in the ``X-Isidore-Task-Token`` header. The
token is validated against isidore's ``GET /api/auth/whoami`` (never trust a
self-asserted header) and bound to a conversation (``root_id``). Tools then only
see and act on schedules belonging to that conversation.

An admin ``Authorization: Bearer $SCHEDULER_TOKEN`` on ``/mcp`` bypasses scoping
(operator debugging; tasks never hold that token). With scoping off
(``SCHEDULER_MCP_SCOPING=0``) the legacy open behavior is restored for
standalone development and tests.

The guard fails closed: a missing/invalid token, or isidore being unreachable,
raises :class:`ScopeError`, which the server turns into a ``ToolError``.

Revocation lag (accepted trade-off): isidore revokes a task token when the task
finalises, but a cached introspection here keeps that token valid for up to
``ttl`` seconds (30s default) afterwards. The window is bounded, and a revoked
token only ever grants access to its OWN conversation's schedules — never
another conversation's — so the lag is accepted rather than adding a
per-call introspection round-trip.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Awaitable, Callable, Mapping

TASK_TOKEN_HEADER = "x-isidore-task-token"
CONVERSATION_HEADER = "x-isidore-conversation-id"


@dataclass(frozen=True)
class Scope:
    task_id: str
    root_id: str
    origin: str


class ScopeError(Exception):
    """A tool call could not be scoped; fail closed."""


class ConversationScope:
    """Resolve a caller's conversation scope from request headers.

    ``whoami`` is an async callable ``(task_token) -> dict | None`` (e.g.
    :meth:`scheduler.client.IsidoreClient.whoami`); None means invalid/unreachable.
    Successful introspections are cached by ``sha256(token)`` for ``ttl`` seconds
    (see the module docstring for the accepted revocation lag). Expired entries
    are evicted proactively on every lookup, so the cache stays bounded by the
    tokens active within the last TTL window.
    """

    def __init__(
        self,
        whoami: Callable[[str], Awaitable[dict | None]],
        *,
        enabled: bool = True,
        ttl: float = 30.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._whoami = whoami
        self.enabled = enabled
        self._ttl = ttl
        self._clock = clock
        self._cache: dict[str, tuple[Scope, float]] = {}

    async def resolve(self, headers: Mapping[str, str] | None, *, admin: bool = False) -> Scope | None:
        """Return the caller's scope, or None when unscoped (admin or scoping off).

        Raises :class:`ScopeError` when scoping is on and the token is
        missing/invalid or isidore is unreachable.
        """
        if not self.enabled or admin:
            return None
        token = (headers or {}).get(TASK_TOKEN_HEADER, "").strip()
        if not token:
            raise ScopeError("missing task token (X-Isidore-Task-Token)")
        key = hashlib.sha256(token.encode("utf-8")).hexdigest()
        now = self._clock()
        # Cheap proactive eviction: drop expired entries so the cache never
        # grows beyond the tokens seen within the last TTL window.
        for expired in [k for k, (_, expiry) in self._cache.items() if expiry <= now]:
            del self._cache[expired]
        cached = self._cache.get(key)
        if cached is not None and cached[1] > now:
            return cached[0]
        info = await self._whoami(token)
        if not info:
            raise ScopeError("invalid task token or isidore unreachable")
        root_id = str(info.get("root_id") or "")
        if not root_id:
            raise ScopeError("invalid task token scope")
        scope = Scope(
            task_id=str(info.get("task_id") or ""),
            root_id=root_id,
            origin=str(info.get("origin") or ""),
        )
        self._cache[key] = (scope, now + self._ttl)
        return scope
