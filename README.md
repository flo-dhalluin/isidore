# ISIDORE

Run the [Pi coding agent](https://pi.dev) in locked-down containers, driven from
a small web UI, with a headless Firefox it can drive over MCP and a scheduler
for one-shot and recurring tasks. Everything is in `compose.yaml`; the images
install Pi themselves, so **no Pi installation or configuration is needed on the
host**.

```
browser-tool/   Firefox + geckodriver + browser-mcp server
isidore/        web UI + Telegram bot that spawns isolated Pi tasks
scheduler/      MCP tool server for one-shot / recurring tasks
compose.yaml    all services, hardening, secret, wiring
```

## Requirements

- Docker Engine with the Compose plugin (`docker compose version`).
- An OpenRouter API key (the provider the tasks authenticate with).

## Quick start

```sh
# 1. State dirs, owned by the user the containers run as (default uid/gid 1000).
mkdir -p ~/.local/state/pi-sandbox/isidore ~/.local/state/pi-sandbox/scheduler

# 2. The credential, as a 0600 file — never an env var or an image layer.
(umask 077; printf '%s' 'sk-or-...' > ~/.openrouter-key)

# 3. Build and launch in the background.
export PI_SANDBOX_KEY_FILE=~/.openrouter-key
docker compose up -d --build
```

Or copy [`.env.example`](.env.example) to `.env` and edit it, then just
`docker compose up -d --build`.

Open <http://127.0.0.1:8920/> (isidore's web UI). The UI/API require an admin
token. If you did not set `ISIDORE_TOKEN`, isidore generates one at startup;
retrieve it out-of-band and pass it as a query parameter:

```sh
docker compose exec isidore cat /state/shared/admin-token   # or: docker compose logs isidore
# then open http://127.0.0.1:8920/?token=<TOKEN>
```

The token is never injected into the loopback page itself: tasks share
isidore's network namespace and could harvest it. `docker compose logs -f`
follows the logs; `docker compose down` stops and removes the containers.

The services run as `PI_UID:PI_GID` (default `1000:1000`). If your account is not
uid/gid 1000, create the state dirs as that account **and** export your ids so the
bind-mounted state stays writable:

```sh
export PI_UID=$(id -u) PI_GID=$(id -g)
```

## Configuration

Compose reads these from the environment (or a `.env` file beside
`compose.yaml`). Only `PI_SANDBOX_KEY_FILE` is required.

| Variable | Default | Meaning |
|---|---|---|
| `PI_SANDBOX_KEY_FILE` | `/dev/null` | file holding the OpenRouter key (compose secret) |
| `PI_UID` / `PI_GID` | `1000` / `1000` | uid/gid the services run as |
| `PI_VERSION` | `latest` | `@earendil-works/pi-coding-agent` version baked into the images |
| `PI_WEB_PACKAGE` | `pi-web-access` | Pi npm package pre-installed into the images |
| `PI_SANDBOX_MODEL` | built-in default | default model override; must be in the built-in whitelist (`isidore/src/models.ts`) |
| `ISIDORE_STATE` | `~/.local/state/pi-sandbox/isidore` | tasks, workspaces, shared Pi config |
| `SCHEDULER_STATE` | `~/.local/state/pi-sandbox/scheduler` | `schedules.json` |
| `ISIDORE_PORT` | `8920` | host port for the web UI (bound to loopback) |
| `ISIDORE_TOKEN` | generated | admin bearer token for the isidore API/UI; generated at startup when unset (see [isidore/README.md](isidore/README.md#authentication)) |
| `ISIDORE_MAX_WORKERS` | `2` | concurrent tasks |
| `ISIDORE_TASK_TIMEOUT` | none | seconds before a task is killed |
| `ISIDORE_TELEGRAM_TOKEN_FILE` | `/dev/null` | file holding the Telegram bot token (compose secret); enables the bot |
| `ISIDORE_TELEGRAM_CHATS` | empty | allowed Telegram chat ids |
| `ISIDORE_TELEGRAM_WEBHOOK_URL` | none | public HTTPS URL for Telegram webhooks; unset = long polling |
| `SCHEDULER_TOKEN` | generated | admin bearer token for the scheduler REST API; generated at startup when unset (`docker compose exec scheduler cat /shared/scheduler-token`, or the startup log). isidore reads it automatically via the `scheduler-auth` volume |
| `BROWSER_MCP_ALLOW_JS` | `0` | expose `browser_evaluate` (arbitrary JS) |
| `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` | `pi-sandbox` / `pi-sandbox@localhost` | git identity inside tasks |

### Resource limits

`BROWSER_MCP_MEMORY` (3g), `ISIDORE_MEMORY` (4g), `SCHEDULER_MEMORY` (256m),
`PI_SANDBOX_PIDS` (512, isidore), `PI_SANDBOX_TMP_SIZE` (2g, isidore `/tmp`),
`SCHEDULER_TICK` (1s), `SCHEDULER_RETRY_DELAY` (30s), `TZ`. Extra mounts or
environment: a `compose.override.yaml`.

## Isolation

Every service: read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, `init`,
pid/memory limits, `/tmp` on a size-limited tmpfs, no docker socket.

- **isidore** and **scheduler** run as your UID/GID and mount only their state
  directory. Host environment is not inherited beyond what `compose.yaml` lists.
- **browser** runs as `ubuntu`, has no mounts, and only exposes the MCP port
  (8931) on the compose network. geckodriver/Marionette stay on its loopback, so
  tasks get curated tools, not raw WebDriver. Firefox starts lazily on the first
  tool call.

## Credential

The key is read from the file named by `PI_SANDBOX_KEY_FILE`, bind-mounted
read-only at `/run/secrets/openrouter` (the `openrouter` compose secret). The
entrypoint exports it inside the container only: never in image layers,
`docker inspect`, the env of the compose process, or a command line.
(Environment-sourced compose secrets are not usable with a read-only rootfs.)

## isidore (run tasks)

`isidore` is a small TypeScript web service that turns a prompt into a fresh,
isolated worker process. The agent runs through the Pi TypeScript SDK inside
that worker, so there is no `pi` CLI subprocess per task. Each task gets its own
workspace and `$HOME` under `/state/workspaces/<id>`, and is killed as a whole
process group on cancel or timeout. The UI is one minimalist HTML page at
`http://127.0.0.1:8920/`; the same actions are available over a JSON API.

```sh
docker compose up -d                   # isidore, scheduler and browser
TOKEN=$(docker compose exec -T isidore cat /state/shared/admin-token)
open "http://127.0.0.1:8920/?token=$TOKEN"
# or curl -X POST localhost:8920/api/tasks \
#   -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
#   -d '{"prompt":"list the files here"}'
```

The API/UI accept the admin token (above) or a per-task capability token scoped
to one conversation; see [isidore/README.md](isidore/README.md#authentication).

### Telegram

isidore can be driven from a Telegram chat. By default the bot long-polls
Telegram (`getUpdates`), so it only needs outbound HTTPS to `api.telegram.org`:
no public URL or open port. A [webhook](#webhook-optional) is optional.

1. **Create the bot**: in Telegram, talk to [@BotFather](https://t.me/BotFather),
   send `/newbot`, pick a name and username, and copy the token
   (`123456789:AA...`). Then send BotFather `/setuserpic`, pick the bot, and
   upload [`loutre-tete.png`](loutre-tete.png) (isidore also serves it at
   `/loutre-tete.png`). The Bot API cannot change a bot's profile photo, so
   this one-time BotFather step is the only way to set the logo as its avatar.
2. **Find your chat id**: send your bot any message (for a group, add the bot to
   the group and post in it first), then, *before* isidore starts polling with
   that token (polling consumes the updates):

   ```sh
   curl -s "https://api.telegram.org/bot<token>/getUpdates" | jq '.result[].message.chat.id'
   ```

   Private chats have a positive id, groups a negative one (`-100...`).
3. **Configure isidore**: store the token in a 0600 file, like the OpenRouter
   key, and point compose at it in `.env` (or the environment of
   `docker compose`):

   ```sh
   (umask 077; printf '%s' '123456789:AA...' > ~/.telegram-token)
   ```

   ```sh
   ISIDORE_TELEGRAM_TOKEN_FILE=$HOME/.telegram-token
   ISIDORE_TELEGRAM_CHATS=111111111,-1002222222222   # comma-separated allow-list
   ```

   then `docker compose up -d` to recreate the container.
   `curl localhost:8920/api/info` (plus `-H "Authorization: Bearer $ISIDORE_TOKEN"`
   if set) should report `"telegram": true, "telegram_mode": "polling"`.
4. **Use it**: send plain text or `/new <prompt>` to queue a task; `/start`
   replies with the bot logo; `/list`,
   `/status <id>`, `/cancel <id>`, `/tools`, `/approve <id>`, `/help`. Send a
   photo, image document, or album (up to 4 images, ≤8 MiB each, with optional
   caption) to run a vision task when the active model supports images. The
   originating chat gets the task's
   output when it finishes (split into several messages if long).
   **Reply** to any of the bot's task messages (with text or a photo) to
   continue that conversation:
   the reply becomes the next turn of the thread, with the same workspace and
   Pi session (refused while a turn of it is still running).
   Schedules the agent creates from a Telegram task (`schedule_task`) post
   each run's result back to that chat.

Notes:

- Messages from chats not in `ISIDORE_TELEGRAM_CHATS` are silently ignored; an
  empty list disables everyone. Results are only ever posted to allowed chats.
- Only final results are posted, not progress or tool calls; the web UI shows
  those. Replies are rendered with Telegram's HTML formatting (bold, italic,
  strikethrough, links, inline code, code blocks, quotes, spoilers) and fall
  back to plain text if Telegram rejects the markup.
- Every allowed chat sees and can cancel **all** tasks (`/list`, `/status` are
  not scoped per chat), including ones started from the web UI.
- In polling mode isidore deletes any webhook left on the bot at startup;
  polling still fails if another process polls the same token.
- The token file is mounted read-only at `/run/secrets/telegram` (the
  `telegram` compose secret) and read by the isidore service itself: it never
  appears in an env var, `docker inspect`, or the environment of spawned tasks.

#### Webhook (optional)

Instead of polling, Telegram can push updates to isidore. This needs a public
HTTPS endpoint (valid certificate, port 443, 80, 88 or 8443) that forwards to
isidore's `POST /telegram/webhook`. Since isidore listens on loopback only, put
a reverse proxy in front and expose **only that path**, e.g. with Caddy:

```caddyfile
bot.example.com {
	handle /telegram/webhook {
		reverse_proxy 127.0.0.1:8920
	}
	respond 404
}
```

Then set the public URL and recreate the container:

```sh
ISIDORE_TELEGRAM_WEBHOOK_URL=https://bot.example.com/telegram/webhook
```

At startup isidore calls `setWebhook` with that URL and a secret derived from
the bot token; Telegram echoes it in `X-Telegram-Bot-Api-Secret-Token` and
isidore rejects requests without it (401). This route ignores `ISIDORE_TOKEN`
and returns 404 when no webhook URL is set. `/api/info` reports
`"telegram_mode": "webhook"`; `getWebhookInfo` on the Bot API shows delivery
errors. Unset the variable to go back to polling (the webhook is deleted on the
next start).

See [isidore/README.md](isidore/README.md#telegram).

## Scheduler (schedule tasks)

`scheduler` is an MCP tool server (streamable HTTP at `/mcp`) plus a firing
loop. Pi gets it as a builtin of the [tool registry](#tool-registry), so the
agent can call `schedule_task`, `list_schedules`, `cancel_schedule` and
`run_schedule_now`.
A schedule is either one-shot (`at`, ISO-8601 or `+30m`) or recurring
(`every`, e.g. `30m`, `2h`, `1d`). When due, the scheduler calls isidore's
`POST /api/tasks`; schedules persist in `schedules.json` across restarts.

```text
schedule_task(prompt="check the build", every="1h")
schedule_task(prompt="summarize the repo", at="2025-01-31T09:00:00Z")
```

isidore's web UI can also create schedules when `ISIDORE_SCHEDULER_URL` is
set (compose does this). See [scheduler/README.md](scheduler/README.md).

## Browser

isidore composes `browser` (`http://browser:8931/mcp`, exposure `direct`)
into every spawned task as a builtin of the [tool registry](#tool-registry).
`browser` is appended to `NO_PROXY`/`no_proxy`, since Docker injects
`~/.docker/config.json` proxies into every container.

Tools: `browser_navigate`, `back`/`forward`/`reload`, `snapshot` (page outline
with element refs like `[ref=e12]`), `get_text` (markdown/text, paged), `click`,
`type`, `fill_form`, `select_option`, `hover`, `press_key`, `wait_for`,
`screenshot` (viewport/full page/element), `tabs`, `reset`. `browser_evaluate`
(arbitrary JS) only exists with `BROWSER_MCP_ALLOW_JS=1`. Only `http(s)` URLs;
no file upload/download.

Smoke test: `docker compose exec -T browser python - < pilot.py`.

## Tool registry

Every spawned task is composed from a service-owned tool registry: the
builtins (browser, scheduler, the `tools` authoring MCP, the `files` MCP) plus
the conversation's own tools and any human-approved global tools. Agents author
`mcp` and `command` tools through the `tools` MCP — `tool_create`,
`tool_list`, `tool_get`, `tool_update`, `tool_disable`, `tool_remove`,
`tool_request_promotion` — and can use them in the same turn. `extension`
tools are human-authored only, via `POST /api/tools` (admin), never the
agent MCP; humans can author `command`/`mcp` globals there too (active
immediately, origin `human`).

Records live under `/state/tools/<id>/`: a mutable `index.json` (scope,
status, ownership, current version) plus one immutable directory per version
(`manifest.json` + source files). Workers never read `/state/tools`; the
service copies command sources into
`/state/tool-cache/<conversation>/<id>/<version>/`, which the sandbox mounts
read-only. Deleting a conversation deletes its tools and every cache copy.

New tools are scoped to their conversation. Going global always needs a
human: the agent calls `tool_request_promotion` (status `pending_approval`),
then you approve from the tool registry page (`/tools?token=<TOKEN>`, linked
from the main UI), via `POST /api/tools/<id>/approve`, or with Telegram
`/approve <id>` (allowed chats only; `/tools` lists pending promotions and
active globals). Approval re-checks name collisions, activates the tool for
every new spawn and clears creator ownership in one atomic index write; the
web confirm shows the tool's name + version and sends `expected_version`, so
an update sneaked in between review and approval is refused with 409. Rejecting keeps the tool
disabled but owned, so the creator can fix it and request promotion again;
`disable` hides a tool from new spawns (running workers keep their copy) and
`enable` restores it without ever bypassing approval. The rest of the admin
API: `POST /api/tools` (human authoring, incl. extensions),
`GET /api/tools[/<id>]`, `reject`, `disable`, `enable`,
`rollback {version}` (any recorded immutable version) and
`DELETE /api/tools/<id>` — all admin-token only; task tokens get 401.

Limits: 32 tools per conversation, 16 KB per manifest, 64 KB of source per
version, command tools capped at 120 s per call (30 s default) with output
truncated at 4000 characters per stream.

## Files

The `files` builtin MCP gives every task one tool, `send_file`. When the agent
produces a report, dataset, image or archive, it calls
`send_file(path="report.md", name="report.md", description="…")`; isidore
copies the file out of the workspace into `<stateDir>/artifacts/<root>/` and
adds a download link to that turn in the task view. Paths are confined to the
task's workspace (symlink escapes are refused), and the download route
(`GET /api/tasks/{id}/artifacts/{artifactId}`) always serves an attachment
with `nosniff`, so agent-authored HTML/SVG cannot run in the UI's origin.
Limits: 50 MB per file, 32 files per turn; deleting the conversation deletes
its artifacts.

## Images

When a vision-capable model is selected, you can attach images from the web UI
(file picker, drag-and-drop, or clipboard paste), via `POST /api/uploads` +
`POST /api/tasks` (or `/followup`), or directly through Telegram (photos, image
documents, and `media_group_id` albums).

- **Supported formats**: PNG, JPEG, GIF, WebP (magic-byte sniffed; SVG is
  rejected).
- **Limits**: 8 MiB per image (raw), 4 images per turn, 1 h staging TTL.
- **Model gating**: capabilities are fetched from OpenRouter's public
  `/api/v1/models` endpoint (`architecture.input_modalities`, ~1 h cache,
  fail-closed `503` when unknown/unavailable, `400` on text-only models) and
  re-checked in the worker before prompting.
- **Isolation**: the upload store (`<stateDir>/uploads/`) is service-only and
  never Landlock-allow-listed; images travel to the worker over stdin JSON, are
  served back to the UI with `nosniff` + attachment headers, and are deleted
  with the conversation. Note that switching a conversation with image history
  to a text-only model may fail at the provider (Pi keeps images in the session
  JSONL), and scheduled tasks remain text-only.

Residual risks (unchanged from the isolation model): all tasks share one uid
and Landlock ABI 4 does not scope signals, so a task can `kill` another
worker; CPU/memory/pids are capped per container, not per task; outbound
network is open, so a task can exfiltrate what it can read (its own workspace
and tool cache); and `/proc/self` is allow-listed for the worker pid only,
so command-tool children cannot read their own `/proc/self`.

See [isidore/README.md](isidore/README.md#tool-registry) for the full layout,
admin API and semantics.

## Notes

- To change the Pi or `pi-web-access` version, set `PI_VERSION` /
  `PI_WEB_PACKAGE` and rebuild (`docker compose build`). `pi update` inside the
  container is pointless (read-only rootfs).
- The web UI and API are bound to loopback; put a reverse proxy in front for
  remote access.
