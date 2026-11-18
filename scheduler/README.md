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

Pi reaches the server through the `scheduler` **builtin of isidore's tool
registry**: when `PI_SANDBOX_SCHEDULER_URL` is set, the runner composes a
builtin manifest into every spawned task and the worker registers it with
`pi.registerMcpServer` (there is no shared `mcp.json` any more). The composed
MCP config is:

```json
{
  "url": "http://scheduler:8940/mcp",
  "headers": {
    "X-Isidore-Task-Token": "${ISIDORE_TASK_TOKEN}",
    "X-Isidore-Origin": "${ISIDORE_TASK_ORIGIN}"
  },
  "exposure": "direct",
  "timeout": 30
}
```

Pi expands `${ISIDORE_TASK_TOKEN}` and `${ISIDORE_TASK_ORIGIN}` from the calling
task's environment. The config carries **no admin secret**: the builtin
manifest is composed per spawn from the service-side registry and only ever
references the task's own env vars, so it must never contain `SCHEDULER_TOKEN`.
Instead each task presents its own capability token, which the scheduler
validates against isidore (see [Conversation scoping](#conversation-scoping)).

When `schedule_task` receives `X-Isidore-Origin: telegram:<chat>`, the schedule
stores it as `reply_to` and fires its tasks with that origin instead of
`scheduler`, so isidore posts their results to that Telegram chat.

## Conversation scoping

With `SCHEDULER_MCP_SCOPING=1` (the default) every MCP tool call must carry a
valid `X-Isidore-Task-Token`. The scheduler validates it against isidore's
`GET /api/auth/whoami` (never trusting a self-asserted header) and binds the
call to the token's conversation (`root_id`). Each schedule records the
`conversation_id` that created it; `list_schedules` shows only the caller's
conversation, and `get_schedule` / `cancel_schedule` / `run_schedule_now` raise
a tool error on any other conversation's schedule. Legacy schedules (no
`conversation_id`) are invisible to task tokens. Validation results are cached
by token hash for 30s. **Revocation lag (accepted trade-off):** isidore revokes
a task token when the task finalises, but a cached introspection keeps it valid
here for up to 30s afterwards. The window is bounded and the token only ever
grants access to its *own* conversation's schedules, so the lag is accepted
rather than adding a per-call introspection round-trip; expired cache entries
are evicted proactively on lookup. The guard **fails closed**: a
missing/invalid token, or isidore being unreachable, denies the call.

An admin `Authorization: Bearer $SCHEDULER_TOKEN` on `/mcp` bypasses scoping
(operator debugging; tasks never hold that token). Set `SCHEDULER_MCP_SCOPING=0
to restore the legacy open behavior for standalone development and tests.

On the REST API, an **admin-authenticated** request may also send
`X-Isidore-Conversation-Id: <root-id>` to scope its view: `GET` filters,
`POST` stamps `conversation_id`, and `GET`/`DELETE`/`run` check it. isidore's
proxy sends this header alongside the admin Bearer when the original caller
used a task token. A plain admin request (no header) sees everything.

## REST API

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/schedules` | `{"schedules": [...]}` |
| `POST` | `/api/schedules` | `{prompt, at?, every?, model?, origin?}` → 201 |
| `GET` | `/api/schedules/{id}` | one schedule |
| `DELETE` | `/api/schedules/{id}` | remove |
| `POST` | `/api/schedules/{id}/run` | fire now |
| `GET` | `/healthz` | liveness |

The REST API **always** requires the admin token (`Authorization: Bearer
<token>` or `?token=`); there is no unauthenticated mode. When `SCHEDULER_TOKEN`
is unset (the compose default), the scheduler generates one at startup
(`secrets.token_hex(32)`), logs it loudly to stderr and writes it to
`$SCHEDULER_SHARED_DIR/scheduler-token` (default `/shared`, mode 0600 — the
`scheduler-auth` named volume). isidore reads that file per-request via
`ISIDORE_SCHEDULER_TOKEN_FILE` (compose: `/state/scheduler-shared/scheduler-token`)
and forwards the Bearer when calling the REST API (plus
`X-Isidore-Conversation-Id` for task-scoped requests). Retrieve it out-of-band:

```sh
docker compose exec scheduler cat /shared/scheduler-token   # or: docker compose logs scheduler
```

In standalone dev without a writable `/shared`, the file falls back to
`$SCHEDULER_STATE/scheduler-token` (or is skipped with a warning — the startup
log always carries the token). The generated token never reaches task workers:
the builtin scheduler manifest carries only per-task token headers, the runner
scrubs `SCHEDULER_*` / `ISIDORE_*` from worker env, and the token file lives
outside the workers' Landlock allow-list. The MCP endpoint itself is only
reachable on the private compose network (no published port) and is scoped per
task token rather than by a shared admin secret.

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
| `SCHEDULER_ISIDORE_TOKEN_FILE` | none | file holding the isidore admin token, read per-request when `SCHEDULER_ISIDORE_TOKEN` is unset (compose: `/isidore-shared/admin-token`) |
| `SCHEDULER_MCP_SCOPING` | `1` | scope MCP tool calls to the caller's conversation; `0` = legacy open mode |
| `SCHEDULER_TOKEN` | generated | admin bearer token for the REST API and the `/mcp` admin bypass; generated at startup when unset (logged to stderr, written to `$SCHEDULER_SHARED_DIR/scheduler-token`) |
| `SCHEDULER_SHARED_DIR` | `/shared` | where the generated admin token is published (compose: `scheduler-auth` volume, read by isidore at `/state/scheduler-shared`) |
| `SCHEDULER_TICK` | `1` | seconds between due checks |
| `SCHEDULER_RETRY_DELAY` | `30` | retry delay after a spawn failure |
| `SCHEDULER_ALLOWED_HOSTS` | `scheduler:*,localhost:*,127.0.0.1:*` | MCP DNS-rebinding allow-list |

## Tests

Schedule arithmetic, persistence and the firing loop are pure Python;
conversation scoping (guard, tools, REST) is tested with a fake whoami and a
fake MCP context:

```sh
python3 -m unittest discover -s scheduler/tests
# or, from scheduler/: uv run python -m unittest discover tests
```
