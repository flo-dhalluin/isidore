"""HTTP client used by the scheduler to ask isidore to spawn a task."""

from __future__ import annotations

from typing import Any

import httpx


class IsidoreError(RuntimeError):
    pass


class IsidoreClient:
    def __init__(self, base_url: str, *, token: str | None = None, timeout: float = 15.0) -> None:
        self.base_url = base_url.rstrip("/")
        self.token = token
        self._client = httpx.AsyncClient(timeout=timeout)

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    async def create_task(self, prompt: str, **kwargs: Any) -> dict[str, Any]:
        payload: dict[str, Any] = {"prompt": prompt, "origin": kwargs.pop("origin", "scheduler")}
        for key in ("model", "schedule_id"):
            value = kwargs.pop(key, None)
            if value:
                payload[key] = value
        try:
            response = await self._client.post(
                f"{self.base_url}/api/tasks", json=payload, headers=self._headers()
            )
        except httpx.HTTPError as exc:
            raise IsidoreError(f"isidore unreachable: {exc}") from exc
        if response.status_code >= 400:
            detail = response.text.strip() or response.reason_phrase
            raise IsidoreError(f"isidore returned {response.status_code}: {detail}")
        return response.json()

    async def aclose(self) -> None:
        await self._client.aclose()
