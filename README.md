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

Open <http://127.0.0.1:8920/> (isidore's web UI). `docker compose logs -f`
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
| `PI_SANDBOX_MODEL` | none | default model for spawned tasks (`provider/model`) |
| `ISIDORE_STATE` | `~/.local/state/pi-sandbox/isidore` | tasks, workspaces, shared Pi config |
| `SCHEDULER_STATE` | `~/.local/state/pi-sandbox/scheduler` | `schedules.json` |
| `ISIDORE_PORT` | `8920` | host port for the web UI (bound to loopback) |
| `ISIDORE_TOKEN` | none | bearer token for the isidore API/UI |
| `ISIDORE_MAX_WORKERS` | `2` | concurrent tasks |
| `ISIDORE_TASK_TIMEOUT` | none | seconds before a task is killed |
| `ISIDORE_TELEGRAM_TOKEN` | none | enables the Telegram bot |
| `ISIDORE_TELEGRAM_CHATS` | empty | allowed Telegram chat ids |
| `SCHEDULER_TOKEN` | none | bearer token for the scheduler |
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
open http://127.0.0.1:8920/            # or curl -X POST localhost:8920/api/tasks \
                                       #   -H 'content-type: application/json' \
                                       #   -d '{"prompt":"list the files here"}'
```

A Telegram bot is enabled by setting `ISIDORE_TELEGRAM_TOKEN` and
`ISIDORE_TELEGRAM_CHATS` (comma-separated allow-list). It long-polls, so no
public webhook is needed; plain text or `/new <prompt>` creates a task and the
chat is notified when it finishes. See [isidore/README.md](isidore/README.md).

## Scheduler (schedule tasks)

`scheduler` is an MCP tool server (streamable HTTP at `/mcp`) plus a firing
loop. Pi gets it through `mcp.json` automatically, so the agent can call
`schedule_task`, `list_schedules`, `cancel_schedule` and `run_schedule_now`.
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

isidore's entrypoint adds `mcpServers.browser = {url: "http://browser:8931/mcp",
exposure: "direct"}` to the shared Pi config, so every spawned task gets it.
`browser` is appended to `NO_PROXY`/`no_proxy`, since Docker injects
`~/.docker/config.json` proxies into every container.

Tools: `browser_navigate`, `back`/`forward`/`reload`, `snapshot` (page outline
with element refs like `[ref=e12]`), `get_text` (markdown/text, paged), `click`,
`type`, `fill_form`, `select_option`, `hover`, `press_key`, `wait_for`,
`screenshot` (viewport/full page/element), `tabs`, `reset`. `browser_evaluate`
(arbitrary JS) only exists with `BROWSER_MCP_ALLOW_JS=1`. Only `http(s)` URLs;
no file upload/download.

Smoke test: `docker compose exec -T browser python - < pilot.py`.

## Notes

- To change the Pi or `pi-web-access` version, set `PI_VERSION` /
  `PI_WEB_PACKAGE` and rebuild (`docker compose build`). `pi update` inside the
  container is pointless (read-only rootfs).
- The web UI and API are bound to loopback; put a reverse proxy in front for
  remote access.
