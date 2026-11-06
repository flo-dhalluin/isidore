"""Small HTTP client for the scheduler service.

isidore uses it to let the web UI create and inspect schedules without
duplicating the scheduler's storage. The scheduler is optional: when
``ISIDORE_SCHEDULER_URL`` is unset the UI simply hides scheduling.
"""

from __future__ import annotations

from typing import Any

import httpx


class SchedulerError(RuntimeError):
    pass


class SchedulerClient:
    def __init__(self, base_url: str | None, *, token: str | None = None, timeout: float = 10.0) -> None:
        self.base_url = (base_url or "").rstrip("/")
        self.token = token
        self._client = httpx.AsyncClient(timeout=timeout)

    @property
    def enabled(self) -> bool:
        return bool(self.base_url)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        if not self.enabled:
            raise SchedulerError("scheduler is not configured")
        try:
            response = await self._client.request(
                method, f"{self.base_url}{path}", headers=self._headers(), **kwargs
            )
        except httpx.HTTPError as exc:
            raise SchedulerError(f"scheduler unreachable: {exc}") from exc
        if response.status_code >= 400:
            detail = response.text.strip() or response.reason_phrase
            raise SchedulerError(f"scheduler returned {response.status_code}: {detail}")
        if response.status_code == 204 or not response.content:
            return None
        return response.json()

    async def create(
        self,
        prompt: str,
        *,
        at: str | None = None,
        every: str | int | None = None,
        model: str | None = None,
        origin: str = "isidore",
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"prompt": prompt, "origin": origin}
        if at:
            payload["at"] = at
        if every:
            payload["every"] = every
        if model:
            payload["model"] = model
        return await self._request("POST", "/api/schedules", json=payload)

    async def list(self) -> list[dict[str, Any]]:
        data = await self._request("GET", "/api/schedules")
        return data.get("schedules", []) if isinstance(data, dict) else list(data or [])

    async def cancel(self, schedule_id: str) -> None:
        await self._request("DELETE", f"/api/schedules/{schedule_id}")

    async def aclose(self) -> None:
        await self._client.aclose()
