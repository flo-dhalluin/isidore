#!/bin/sh
# isidore entrypoint: unlock the credential, seed the Pi config used by every
# spawned task, then start the web service. MCP servers (browser, scheduler)
# are registered per worker from the tool registry — no shared mcp.json.
set -eu

export HOME="${HOME:-/state/home}"
: "${PI_CODING_AGENT_DIR:=/state/pi}"
export PI_CODING_AGENT_DIR
mkdir -p "$HOME" "$PI_CODING_AGENT_DIR" "${ISIDORE_STATE:-/state}/shared" 2>/dev/null || true

# The credential arrives as a compose secret (a file), then becomes an env
# var only inside this process tree. Spawned `pi` processes inherit it.
if [ -s /run/secrets/openrouter ]; then
	OPENROUTER_API_KEY=$(cat /run/secrets/openrouter)
	export OPENROUTER_API_KEY
fi

# Seed the writable config from the baked image whenever the image changed.
seed_tag=$(cat /opt/pi-config/.seed 2>/dev/null || true)
if [ "$seed_tag" != "$(cat "$PI_CODING_AGENT_DIR/.seed" 2>/dev/null || true)" ]; then
	rm -rf "$PI_CODING_AGENT_DIR/npm"
	cp -a --no-preserve=ownership /opt/pi-config/. "$PI_CODING_AGENT_DIR"/
	printf 'isidore: refreshing model catalog...\n' >&2
	pi update --models >/dev/null 2>&1 || true
fi

# A usable git identity for spawned tasks (they get a per-task HOME).
git config --global --get user.name >/dev/null 2>&1 ||
	git config --global user.name "${GIT_AUTHOR_NAME:-pi-sandbox}"
git config --global --get user.email >/dev/null 2>&1 ||
	git config --global user.email "${GIT_AUTHOR_EMAIL:-pi-sandbox@localhost}"

exec "$@"
