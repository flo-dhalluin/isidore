#!/bin/sh
# isidore entrypoint: unlock the credential, seed the Pi config used by every
# spawned task, wire the MCP servers, then start the web service.
set -eu

export HOME="${HOME:-/state/home}"
: "${PI_CODING_AGENT_DIR:=/state/pi}"
export PI_CODING_AGENT_DIR
mkdir -p "$HOME" "$PI_CODING_AGENT_DIR" 2>/dev/null || true

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

# MCP servers available to every spawned task. Entries are removed again when
# the corresponding URL is unset, so the state dir stays consistent.
mcp_file="$PI_CODING_AGENT_DIR/mcp.json"
[ -s "$mcp_file" ] || printf '{}\n' >"$mcp_file"

if [ -n "${PI_SANDBOX_BROWSER_URL:-}" ]; then
	jq --arg url "$PI_SANDBOX_BROWSER_URL" '.mcpServers.browser = {
		url: $url, exposure: "direct", timeout: 120,
		description: "Headless Firefox: open pages, read and interact with them, fill forms, take screenshots"
	}' "$mcp_file" >"$mcp_file.tmp" && mv "$mcp_file.tmp" "$mcp_file"
else
	jq 'del(.mcpServers.browser)' "$mcp_file" >"$mcp_file.tmp" && mv "$mcp_file.tmp" "$mcp_file"
fi

if [ -n "${PI_SANDBOX_SCHEDULER_URL:-}" ]; then
	if [ -n "${ISIDORE_SCHEDULER_TOKEN:-}" ]; then
		jq --arg url "$PI_SANDBOX_SCHEDULER_URL" --arg token "$ISIDORE_SCHEDULER_TOKEN" '.mcpServers.scheduler = {
			url: $url, headers: {Authorization: ("Bearer " + $token)}, exposure: "direct", timeout: 30,
			description: "Schedule one-shot or recurring tasks that spawn isolated Pi agents"
		}' "$mcp_file" >"$mcp_file.tmp" && mv "$mcp_file.tmp" "$mcp_file"
	else
		jq --arg url "$PI_SANDBOX_SCHEDULER_URL" '.mcpServers.scheduler = {
			url: $url, exposure: "direct", timeout: 30,
			description: "Schedule one-shot or recurring tasks that spawn isolated Pi agents"
		}' "$mcp_file" >"$mcp_file.tmp" && mv "$mcp_file.tmp" "$mcp_file"
	fi
else
	jq 'del(.mcpServers.scheduler)' "$mcp_file" >"$mcp_file.tmp" && mv "$mcp_file.tmp" "$mcp_file"
fi

# A usable git identity for spawned tasks (they get a per-task HOME).
git config --global --get user.name >/dev/null 2>&1 ||
	git config --global user.name "${GIT_AUTHOR_NAME:-pi-sandbox}"
git config --global --get user.email >/dev/null 2>&1 ||
	git config --global user.email "${GIT_AUTHOR_EMAIL:-pi-sandbox@localhost}"

exec "$@"
