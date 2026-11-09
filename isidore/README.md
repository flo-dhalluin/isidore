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

The Pi config directory (`/state/pi`) is shared so every task sees the same
model catalog, `pi-web-access`, and MCP servers (browser + scheduler), but
sessions are redirected into each workspace. If you need stronger isolation,
run isidore with a different `ISIDORE_STATE` per tenant or put each task in
its own container.

## Web UI

`http://127.0.0.1:8920/` (bound to loopback by compose). The page is a single
HTML document: a prompt box, an optional model, a task list, and — when the
scheduler is configured — a one-shot/interval schedule form. The list groups
follow-ups under their root task; clicking a task opens a full-screen
conversation page where you can read the transcript, cancel a running turn,
ask follow-up questions, or delete a finished conversation (records **and**
workspace). Agent answers are rendered as HTML by a small, dependency-free
Markdown renderer in the page (headings, lists, code blocks, tables, links);
the source is HTML-escaped first and unsafe URL schemes are refused, so agent
output cannot inject markup.

REST API:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/info` | feature flags (scheduler, telegram, model) |
| `GET` | `/api/tasks?limit=50&status=running` | list tasks |
| `POST` | `/api/tasks` | `{prompt, model?, origin?, schedule_id?}` → 202 |
| `GET` | `/api/tasks/{id}` | one task, including output |
| `DELETE` | `/api/tasks/{id}` | delete a finished conversation + workspace |
| `GET` | `/api/tasks/{id}/thread` | every turn of a conversation, oldest first |
| `POST` | `/api/tasks/{id}/followup` | `{prompt, model?}` → 202, continues the conversation |
| `POST` | `/api/tasks/{id}/cancel` | cancel a queued/running task |
| `GET` | `/api/schedules` | proxy to the scheduler |
| `POST` | `/api/schedules` | `{prompt, at?, every?, model?}` |
| `DELETE` | `/api/schedules/{id}` | proxy to the scheduler |
| `GET` | `/healthz` | liveness |

Set `ISIDORE_TOKEN` to require `Authorization: Bearer <token>` (or
`?token=<token>` for the UI). The compose port is loopback-only; use a reverse
proxy for remote access.

## Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Send the bot a message, then find your chat id (e.g. with
   `https://api.telegram.org/bot<token>/getUpdates`).
3. Set `ISIDORE_TELEGRAM_TOKEN` and `ISIDORE_TELEGRAM_CHATS` (comma-separated
   chat ids) in the environment used by `docker compose`.

The bot long-polls, so no public webhook is needed. An empty allow-list denies
everyone. Commands: `/new <prompt>` (plain text also works), `/list`,
`/status <id>`, `/cancel <id>`, `/help`. The originating chat is notified when
a task finishes.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ISIDORE_STATE` | `/state` | tasks, workspaces, Pi config |
| `ISIDORE_HOST` / `ISIDORE_PORT` | `0.0.0.0` / `8920` | listen address |
| `ISIDORE_MODEL` | host default | model passed to the worker |
| `ISIDORE_MAX_WORKERS` | `2` | concurrent tasks |
| `ISIDORE_TASK_TIMEOUT` | none | seconds before a task is killed |
| `ISIDORE_PI_MODE` | `print` | `print` (final text) or `json` (live transcript) |
| `ISIDORE_WORKER_SCRIPT` | `dist/worker.js` | Node worker that runs the Pi SDK |
| `ISIDORE_WORKER_BIN` | `process.execPath` | Node binary used to run the worker |
| `ISIDORE_TOKEN` | none | bearer token for the API/UI |
| `ISIDORE_SCHEDULER_URL` | none | enables the schedule form |
| `ISIDORE_SCHEDULER_TOKEN` | none | bearer token for the scheduler |
| `ISIDORE_TELEGRAM_TOKEN` | none | enables the bot |
| `ISIDORE_TELEGRAM_CHATS` | empty | allowed chat ids |

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
