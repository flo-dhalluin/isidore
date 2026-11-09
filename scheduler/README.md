# scheduler

Schedule one-shot or recurring tasks that isidore runs as isolated Pi agents.
The scheduler is exposed to Pi as an **MCP tool server** (streamable HTTP at
`/mcp`) and to isidore as a small REST API. A background loop fires due
schedules by calling isidore's `POST /api/tasks`.

```
Pi / isidore ──► schedule_task ──► schedules.json
                                      │
                              firing loop (1s tick)
                                      │
                                      ▼
                         POST http://isidore:8920/api/tasks
```

## MCP tools

| Tool | Arguments | Purpose |
|---|---|---|
| `schedule_task` | `prompt`, `at` xor `every`, `model?` | create a schedule |
| `list_schedules` | — | every schedule, newest first |
| `get_schedule` | `schedule_id` | one schedule |
| `cancel_schedule` | `schedule_id` | remove a schedule |
| `run_schedule_now` | `schedule_id` | fire immediately |

`at` is an absolute ISO-8601 time (`2025-01-31T09:00:00Z`) or a relative
`+30m`. `every` is a compact duration: `30s`, `5m`, `2h`, `1d`, `1w`, or a
combination such as `1h30m`. A one-shot schedule disables itself after it
fires; an interval schedule advances to the next future occurrence.

Pi connects to the server through `mcp.json`; the sandbox entrypoint adds it
automatically when `PI_SANDBOX_SCHEDULER_URL` is set:

```json
{
  "mcpServers": {
    "scheduler": {
      "url": "http://scheduler:8940/mcp",
      "exposure": "direct",
      "timeout": 30
    }
  }
}
```

## REST API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/schedules` | `{"schedules": [...]}` |
| `POST` | `/api/schedules` | `{prompt, at?, every?, model?, origin?}` → 201 |
| `GET` | `/api/schedules/{id}` | one schedule |
| `DELETE` | `/api/schedules/{id}` | remove |
| `POST` | `/api/schedules/{id}/run` | fire now |
| `GET` | `/healthz` | liveness |

Set `SCHEDULER_TOKEN` to require a bearer token on the REST API. isidore
forwards its own `ISIDORE_SCHEDULER_TOKEN` when calling it, and the sandbox
entrypoint adds the same token as an `Authorization` header to the MCP
config. The MCP endpoint itself is only reachable on the private compose
network (no published port).

## Persistence and failures

Schedules live in `$SCHEDULER_STATE/schedules.json` and survive restarts. If
isidore is unreachable when a schedule fires, the schedule stays enabled, the
error is recorded in `last_error`, and it is retried after
`SCHEDULER_RETRY_DELAY` seconds (default 30). Past-due one-shot schedules are
fired on the next tick after a restart rather than silently dropped.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `SCHEDULER_STATE` | `/state` | where `schedules.json` lives |
| `SCHEDULER_HOST` / `SCHEDULER_PORT` | `0.0.0.0` / `8940` | listen address |
| `SCHEDULER_ISIDORE_URL` | `http://isidore:8920` | where to spawn tasks |
| `SCHEDULER_ISIDORE_TOKEN` | none | bearer token for isidore |
| `SCHEDULER_TOKEN` | none | bearer token for this service |
| `SCHEDULER_TICK` | `1` | seconds between due checks |
| `SCHEDULER_RETRY_DELAY` | `30` | retry delay after a spawn failure |
| `SCHEDULER_ALLOWED_HOSTS` | `scheduler:*,localhost:*,127.0.0.1:*` | MCP DNS-rebinding allow-list |

## Tests

Schedule arithmetic, persistence and the firing loop are pure Python:

```sh
python3 -m unittest discover -s scheduler/tests
```
