# pi-sandbox

Run the [Pi coding agent](https://pi.dev) (with `pi-web-access`) in a locked-down
container that only sees the current directory, plus a headless Firefox it can
drive over MCP. Everything is in `compose.yaml`; `./pi-sandbox` is a small
launcher that fills in what compose can't compute from the host.

```
agent/          Pi image + entrypoint
browser-tool/   Firefox + geckodriver + browser-mcp server
compose.yaml    both services, hardening, secret, wiring
pi-sandbox      launcher
```

```sh
pi-sandbox                      # interactive TUI on $PWD
pi-sandbox -p "summarize this"  # one-shot (any other args go to pi)
pi-sandbox --ro                 # workspace mounted read-only
pi-sandbox --shell              # bash in the agent container
pi-sandbox --rebuild            # rebuild images (e.g. after `pi update --extensions`)
pi-sandbox --down               # stop the browser service

ln -s "$PWD/pi-sandbox" ~/.local/bin/pi-sandbox
```

## What the launcher does

Exports, then `exec docker compose run --rm agent "$@"`:

| Variable | Source |
|---|---|
| `PI_VERSION` | `~/.pi/agent/install/current-version` (image tag `pi-sandbox-agent:<version>`, rebuilt when Pi updates) |
| `PI_WEB_PACKAGE` | `pi-web-access` spec from `~/.pi/agent/npm/package.json` |
| `PI_SANDBOX_MODEL` | host `defaultProvider/defaultModel` (set it, even empty, to override) |
| `PI_WORKSPACE`, `PI_UID`, `PI_GID` | `$PWD`, `id -u`, `id -g` |
| `PI_SANDBOX_STATE` | `~/.local/state/pi-sandbox/agent` (created 0700) |
| `PI_SANDBOX_KEY_FILE` | OpenRouter key, see below |

Plain compose works for everything else (`docker compose logs browser`,
`docker compose exec browser …`, `docker compose down`).

## Isolation

Both services: read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, `init`,
pid/memory limits, `/tmp` on a size-limited tmpfs, no docker socket.

- **agent** runs as your UID/GID and sees only the workspace (mounted at its
  host path, so Pi sessions stay per-project in the shared state dir) and
  `/state`. Host environment is not inherited beyond what `compose.yaml` lists.
- **browser** runs as `ubuntu`, has no mounts, and only exposes the MCP port
  (8931) on the compose network. geckodriver/Marionette stay on its loopback, so
  the agent gets curated tools, not raw WebDriver. Firefox starts lazily on the
  first tool call.

## Credential

The launcher resolves the key (`pi auth print-bearer-token --provider
openrouter`, then `~/.pi/agent/auth.json`, then `$OPENROUTER_API_KEY`), writes it
0600 to `$XDG_RUNTIME_DIR/pi-sandbox/openrouter` (RAM), and compose bind-mounts it
read-only as the `openrouter` secret. The entrypoint exports it inside the
container only: never in image layers, `docker inspect`, env of the compose
process, or a command line. (Environment-sourced compose secrets are not usable
with a read-only rootfs.)

## Browser

The entrypoint adds `mcpServers.browser = {url: "http://browser:8931/mcp",
exposure: "direct"}` to the sandbox's `mcp.json`. `browser` is appended to
`NO_PROXY`/`no_proxy`, since Docker injects `~/.docker/config.json` proxies into
every container.

Tools: `browser_navigate`, `back`/`forward`/`reload`, `snapshot` (page outline
with element refs like `[ref=e12]`), `get_text` (markdown/text, paged), `click`,
`type`, `fill_form`, `select_option`, `hover`, `press_key`, `wait_for`,
`screenshot` (viewport/full page/element), `tabs`, `reset`. `browser_evaluate`
(arbitrary JS) only exists with `BROWSER_MCP_ALLOW_JS=1`. Only `http(s)` URLs;
no file upload/download.

Smoke test: `docker compose exec -T browser python - < pilot.py`.

## Tuning

`PI_SANDBOX_MEMORY` (4g), `PI_SANDBOX_PIDS` (512), `PI_SANDBOX_TMP_SIZE` (2g),
`BROWSER_MCP_MEMORY` (3g), `PI_WORKSPACE_MODE` (`rw`/`ro`), `GIT_AUTHOR_NAME`,
`GIT_AUTHOR_EMAIL`. Extra mounts or env: `docker compose run` flags in a
`compose.override.yaml`.

## Notes

- The workspace can't be `/tmp` or `/state` (they are container mounts).
- `pi update` inside the container is pointless (read-only rootfs); update on
  the host and the next run builds a new image.
- After changing `pi-web-access` on the host, run `pi-sandbox --rebuild`.
