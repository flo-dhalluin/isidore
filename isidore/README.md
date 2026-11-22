# isidore

Run isolated Pi coding-agent tasks from a minimalist web UI or a Telegram bot.
isidore is the "front door" of the sandbox: it accepts a prompt, starts a fresh
worker process in its own workspace, and streams the result back.

It is a TypeScript/Node service. The agent runs through the Pi TypeScript SDK
in a per-task worker process (`dist/worker.js`); there is no `pi` CLI
subprocess per task.

```
POST /api/tasks  ──►  Runner  ──►  node worker.js  ──►  Pi TypeScript SDK
                        │
                        └──►  /state/workspaces/<task-id>/   (cwd + $HOME)
```

## Isolation

Each task is a separate process with:

* its own working directory and `$HOME` under `/state/workspaces/<id>`;
* its own Pi session store (`$HOME/sessions`), so conversation state lives and
  dies with the workspace;
* a fresh process group, so cancelling a task kills its whole tree;
* no shell: the prompt is passed as JSON on stdin, never interpolated into a
  command.

A conversation is a chain of tasks that share the root task's workspace and
Pi session, so a follow-up keeps the earlier files and history.

The Pi config directory (`/state/pi`) is shared **read-only** so every task
sees the same model catalog and `pi-web-access`; sessions are redirected into
each workspace. MCP servers no longer come from a shared `mcp.json`: each
worker is composed from the [tool registry](#tool-registry) at spawn. If you
need stronger isolation, run isidore with a different `ISIDORE_STATE` per
tenant or put each task in its own container.

## Web UI

`http://127.0.0.1:8920/` (bound to loopback by compose). The page is a single
HTML document: a prompt box, an optional model, and a task list, with — when
the scheduler is configured — a sidebar listing the active schedules and their
scheduled time (next run, with a relative hint). The model field is a
dropdown of the built-in whitelist (`src/models.ts`), with the default
preselected. The list groups follow-ups
under their root task; clicking a task opens a full-screen conversation page
where you can read the transcript, cancel a running turn, ask follow-up
questions, or delete a finished conversation (records **and** workspace). Each
task shows the tools the agent called (name, arguments and outcome) in a
collapsible accordion; a spinner marks a queued or running task while it
waits to finish; and files published with `send_file` appear as download
links on the turn that produced them. Agent answers are rendered as HTML by a
small, dependency-free
Markdown renderer in the page (headings, lists, code blocks, tables, links);
the source is HTML-escaped first and unsafe URL schemes are refused, so agent
output cannot inject markup.

REST API:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/info` | feature flags (scheduler, telegram, model, model whitelist) |
| `GET` | `/api/auth/whoami` | caller identity: `{admin:true}` or `{task_id, root_id, origin}` |
| `GET` | `/api/tasks?limit=50&status=running` | list tasks |
| `POST` | `/api/tasks` | `{prompt, model?, origin?, schedule_id?}` → 202 (model must be whitelisted) |
| `GET` | `/api/tasks/{id}` | one task, including output |
| `GET` | `/api/tasks/{id}/artifacts/{artifactId}` | download a file published with `send_file` |
| `DELETE` | `/api/tasks/{id}` | delete a finished conversation + workspace |
| `GET` | `/api/tasks/{id}/thread` | every turn of a conversation, oldest first |
| `POST` | `/api/tasks/{id}/followup` | `{prompt, model?}` → 202, continues the conversation |
| `POST` | `/api/tasks/{id}/cancel` | cancel a queued/running task |
| `GET` | `/api/schedules` | proxy to the scheduler |
| `POST` | `/api/schedules` | `{prompt, at?, every?, model?}` |
| `DELETE` | `/api/schedules/{id}` | proxy to the scheduler |
| `GET` | `/healthz` | liveness |

### Authentication

Every API/UI request needs `Authorization: Bearer <token>`. Two kinds of token
are accepted:

* **Admin token** — full access. `?token=<token>` also works, but is
  **admin-only** (it is how the browser UI authenticates). Set `ISIDORE_TOKEN`
  to choose your own; otherwise isidore **generates one at startup**, logs it
  loudly to stderr, and writes it to `<stateDir>/shared/admin-token` (mode
  0600). Retrieve it out-of-band:

  ```sh
  docker compose exec isidore cat /state/shared/admin-token
  # or read it from the startup log: docker compose logs isidore
  ```

  then open `http://127.0.0.1:8920/?token=<TOKEN>`. In dev (no compose) the file
  is `<ISIDORE_STATE>/shared/admin-token`.

  > **Note:** the shared token volumes are pre-created owned by uid 1000, so the
  > bootstrap assumes the default `PI_UID`/`PI_GID` (1000). If you override them,
  > ensure the `isidore-admin` and `scheduler-auth` volumes are writable by that
  > uid, or set `ISIDORE_TOKEN`/`SCHEDULER_TOKEN` explicitly.

  The token is deliberately **not** injected into the loopback UI: workers
  share isidore's network namespace, so a task could `curl` loopback and
  harvest an injected admin token. Out-of-band retrieval keeps it away from
  tasks.

* **Task token** — a per-task capability the runner mints at spawn
  (`ISIDORE_TASK_TOKEN`, 64 hex chars) and revokes when the task finishes. It
  is accepted as a Bearer only (never `?token=`) and is scoped to the task's
  **conversation** (`root_id`): it can list/read/continue/cancel/delete only
  that conversation's turns, and create only follow-up turns of it. Any
  cross-conversation read or action returns **404**; no/invalid token returns
  **401**. `GET /api/auth/whoami` reports the scope. The scheduler validates
  task tokens through this endpoint — it never trusts a self-asserted header.

The compose port is loopback-only; use a reverse proxy for remote access.

## Tool registry

Each spawn is composed from a service-owned registry (`src/tools.ts`):
builtin manifests (browser, scheduler, the `tools` authoring MCP, the `files`
MCP, plus informational extension entries), the conversation's own active
tools, any human-approved active globals, and — for lineage children
(`conversation_id` on `POST /api/tasks`) — the parent conversation's tools
pinned to the version current at spawn. Workers never touch the registry
itself.

Storage (service-only; the sandbox denies `/state/tools` to workers):

```text
/state/tools/<id>/index.json               mutable: scope, status, ownership, current_version, versions
/state/tools/<id>/<version>/               immutable: manifest.json + files/<name>
/state/tool-cache/<root>/<id>/<version>/   per-conversation copies of command sources, mounted read-only
```

### Authoring

Agents author tools through the `tools` MCP (`POST /mcp/tools`, Bearer task
token): `tool_create`, `tool_list`, `tool_get`, `tool_update`, `tool_disable`,
`tool_remove`, `tool_request_promotion`. Kinds: `mcp` (http(s) endpoint,
`${VAR}` header templates expanded from the worker env) and `command` (argv
with `{{param}}` whole-token templates + source files, run under the worker's
Landlock ruleset with a scrubbed env, no shell). Created/updated tools
register in the same turn. `extension` tools are human-authored only — via
`POST /api/tools` (admin), never the agent MCP. Humans can also author
`command`/`mcp` globals there: origin `human`, scope `global`, active
immediately (no approval needed — a human is the author).

Visibility is per conversation: a task sees and mutates only its own tools
(plus active globals, read-only). New tools default to `conversation` scope;
`scope: "global"` from an agent always lands in `pending_approval`.

### Files (`send_file`)

Every task also gets the `files` builtin MCP (`POST /mcp/files`, Bearer task
token). Its single tool, `send_file`, copies a file from the task's workspace
into the service-only artifact store and records it on the current turn, so
the task view shows a download link:

```json
{"path": "report.md", "name": "report.md", "description": "quarterly report"}
```

`path` may be relative to the workspace (its cwd) or absolute, but it must
resolve inside the workspace; symlinks are resolved and refused if they
escape. `name` and `description` are optional. The agent can call the tool
once per file; each call returns the recorded artifact id.

Artifacts live under `<stateDir>/artifacts/<root>/<artifactId>` (never mounted
into the worker) and are deleted with the conversation. Downloads go through
`GET /api/tasks/{id}/artifacts/{artifactId}` with the admin token (or a task
token scoped to that conversation) and are always
`Content-Disposition: attachment` with `X-Content-Type-Options: nosniff`, so
agent-authored HTML/SVG cannot execute in the UI's origin. Limits: 50 MB per
file, 32 files per turn.

### Promotion (human-gated)

`tool_request_promotion` records a reason and sets `pending_approval`. A
human then approves from the tool registry page, the admin API, or Telegram
(`/tools` lists pending promotions + active globals, `/approve <id>`
approves; allowed chats only). Approval is the **only** path to
active+global for agent-authored tools: it re-checks name collisions
(including MCP `-`/`_` namespace normalization) against active globals and
builtins, then activates the tool, makes it global and clears creator
ownership in ONE atomic index write. The web confirm shows the tool's name +
version and sends `expected_version`; if the creator updated the tool between
review and approval, approve returns 409 (Telegram echoes name + version
before applying). Reject sets
`disabled` but keeps scope + ownership, so the creator can revise and
re-promote. `disable` hides a tool from new spawns (running workers keep
their copy); `enable` restores a disabled tool but refuses never-approved
globals, so it cannot bypass approval. `rollback` points `current_version`
at any recorded immutable version; old versions stay readable forever.

### Admin surface

`/tools?token=<TOKEN>` (linked from the main page) lists every tool with
scope, status, version, provenance and the pending reason, with
approve/reject/disable/enable/rollback/delete actions. The API behind it is
**admin-only** — task tokens get 401 on every route:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/tools` | human authoring: `{name, kind, description, …, scope?}` → 201; the only place `extension` tools can be created (`files` + `entry`); command/mcp globals are active immediately |
| `GET` | `/api/tools?scope=&status=` | indexes + current manifests + provenance |
| `GET` | `/api/tools/{id}?version=` | one tool; an explicit `?version=` is returned verbatim (immutable), the index carries live state |
| `POST` | `/api/tools/{id}/approve` | pending → active + global (collision re-check; optional `{expected_version}` → 409 if the tool changed since review) |
| `POST` | `/api/tools/{id}/reject` | pending → disabled, ownership kept |
| `POST` | `/api/tools/{id}/disable` | hide from new spawns |
| `POST` | `/api/tools/{id}/enable` | disabled → active (never bypasses approval) |
| `POST` | `/api/tools/{id}/rollback` | `{version}` → any recorded version |
| `DELETE` | `/api/tools/{id}` | remove records + every cache copy across roots |

Deleting a conversation (`DELETE /api/tasks/{id}`) also deletes its scoped
tools, their cache copies, and its published artifacts.

### Limits

| Limit | Value |
|---|---|
| tools per conversation (incl. pending globals) | 32 |
| manifest size | 16 KB |
| command source per version (≤16 files) | 64 KB |
| command timeout | 120 s max, 30 s default |
| command stdout/stderr | truncated at `MAX_EVENT_TEXT` (4000 chars) each |

### Residual risks

The registry does not change the isolation model: all tasks share one uid
and Landlock ABI 4 does not scope signals, so a task can `kill` another
worker; CPU/memory/pids are capped per container, not per task, so a task
can starve its siblings; outbound network is open, so a task can exfiltrate
anything it can read (its own workspace and tool cache); and the
`/proc/self` allow-list rule covers the worker pid only, so command-tool
children cannot read their own `/proc/self`.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
   For the bot avatar, send BotFather `/setuserpic` and upload
   `templates/loutre-tete.png` (also served at `/loutre-tete.png`); the Bot API
   has no method to set a bot's profile photo.
2. Send the bot a message, then find your chat id (e.g. with
   `https://api.telegram.org/bot<token>/getUpdates`).
3. Write the token to a 0600 file and set `ISIDORE_TELEGRAM_TOKEN_FILE` (its
   path) and `ISIDORE_TELEGRAM_CHATS` (comma-separated chat ids) in the
   environment used by `docker compose`. Compose mounts the file as the
   `telegram` secret; outside compose, `ISIDORE_TELEGRAM_TOKEN` (the token
   itself) also works.

By default the bot long-polls, so no public endpoint is needed (any leftover
webhook is deleted at startup). With `ISIDORE_TELEGRAM_WEBHOOK_URL` set, it
calls `setWebhook` instead and receives updates on `POST /telegram/webhook`,
which a reverse proxy must expose at that public HTTPS URL. That route is
authenticated by Telegram's `X-Telegram-Bot-Api-Secret-Token` header, not by
`ISIDORE_TOKEN`; the secret defaults to an HMAC of the bot token
(override with `ISIDORE_TELEGRAM_WEBHOOK_SECRET[_FILE]`). An empty allow-list denies
everyone. Commands: `/new <prompt>` (plain text also works), `/list`,
`/status <id>`, `/cancel <id>`, `/tools`, `/approve <id>`, `/help`; `/start`
sends the bot logo with the help text. The
originating chat is notified once
when a task finishes (only if it is an allowed chat). Replying to a bot message
that names a task queues a follow-up turn in that task's thread.

Each worker gets `ISIDORE_TASK_ORIGIN` (e.g. `telegram:<chat>`), which the
builtin scheduler tool sends to the scheduler as `X-Isidore-Origin`; a
schedule created from a Telegram task fires its tasks with that origin, so
their results go back to the chat.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ISIDORE_STATE` | `/state` | tasks, workspaces, Pi config |
| `ISIDORE_HOST` / `ISIDORE_PORT` | `0.0.0.0` / `8920` | listen address |
| `ISIDORE_MODEL` | built-in default | default model override; must be in the built-in whitelist (`src/models.ts`) |
| `ISIDORE_MAX_WORKERS` | `2` | concurrent tasks |
| `ISIDORE_TASK_TIMEOUT` | none | seconds before a task is killed |
| `ISIDORE_PI_MODE` | `print` | `print` (final answer) or `json` (full transcript); the worker always emits the event stream, so tool calls are captured either way |
| `ISIDORE_WORKER_SCRIPT` | `dist/worker.js` | Node worker that runs the Pi SDK |
| `ISIDORE_WORKER_BIN` | `process.execPath` | Node binary used to run the worker |
| `ISIDORE_TOKEN` | generated | admin bearer token for the API/UI; generated at startup when unset (see [Authentication](#authentication)) |
| `ISIDORE_SANDBOX_BIN` | `/usr/local/bin/isidore-sandbox` | Landlock launcher binary used to sandbox each worker |
| `ISIDORE_UNSAFE_NO_SANDBOX` | `0` | `1` runs workers without the launcher (logged loudly; dev only) |
| `ISIDORE_SCHEDULER_URL` | none | enables the schedule form |
| `ISIDORE_SCHEDULER_TOKEN` | none | bearer token for the scheduler; when unset, read per-request from `ISIDORE_SCHEDULER_TOKEN_FILE` |
| `ISIDORE_SCHEDULER_TOKEN_FILE` | `/state/scheduler-shared/scheduler-token` | file holding the scheduler admin token (compose: `scheduler-auth` volume; the scheduler generates it at startup when `SCHEDULER_TOKEN` is unset) |
| `ISIDORE_TOOLS_URL` | `http://127.0.0.1:<port>/mcp/tools` | override the builtin tools authoring MCP URL |
| `ISIDORE_FILES_URL` | `http://127.0.0.1:<port>/mcp/files` | override the builtin files MCP URL |
| `ISIDORE_TELEGRAM_TOKEN` | none | bot token; enables the bot |
| `ISIDORE_TELEGRAM_TOKEN_FILE` | none | file holding the token, used when `ISIDORE_TELEGRAM_TOKEN` is unset |
| `ISIDORE_TELEGRAM_CHATS` | empty | allowed chat ids |
| `ISIDORE_TELEGRAM_WEBHOOK_URL` | none | public HTTPS URL for webhook mode; unset = long polling |
| `ISIDORE_TELEGRAM_WEBHOOK_SECRET` (`_FILE`) | HMAC of the bot token | webhook secret token (`[A-Za-z0-9_-]`, ≤256 chars) |

## Development

```sh
npm install
npm run dev        # node --experimental-strip-types src/index.ts
npm run build      # tsc -> dist/
npm start          # node dist/index.js
```

## Tests

The store and runner are pure TypeScript and tested without a web server:

```sh
npm test
```
