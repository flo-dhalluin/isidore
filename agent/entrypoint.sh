#!/bin/sh
# Container entrypoint: unlock the credential, seed the config dir, wire the
# browser + scheduler MCP servers, run Pi (or bash with PI_SANDBOX_SHELL=1).
set -eu

export HOME="${HOME:-/tmp/home}"
: "${PI_CODING_AGENT_DIR:=/state}"
export PI_CODING_AGENT_DIR
mkdir -p "$HOME" 2>/dev/null || true

# The credential arrives as a compose secret (a file), then becomes an env
# var only inside this process tree.
if [ -s /run/secrets/openrouter ]; then
	OPENROUTER_API_KEY=$(cat /run/secrets/openrouter)
	export OPENROUTER_API_KEY
fi

# Seed the writable state from the baked config (settings + pi-web-access)
# whenever the image was built from different Pi / pi-web-access versions.
seed_tag=$(cat /opt/pi-config/.seed 2>/dev/null || true)
if [ "$seed_tag" != "$(cat "$PI_CODING_AGENT_DIR/.seed" 2>/dev/null || true)" ]; then
	rm -rf "$PI_CODING_AGENT_DIR/npm"
	cp -a --no-preserve=ownership /opt/pi-config/. "$PI_CODING_AGENT_DIR"/
	printf 'pi-sandbox: refreshing model catalog...\n' >&2
	pi update --models >/dev/null 2>&1 || true
fi

# MCP entries for the browser and scheduler services. The state dir is
# persistent, so an entry is removed again when its URL is unset.
mcp_file="$PI_CODING_AGENT_DIR/mcp.json"
[ -s "$mcp_file" ] || printf '{}\n' >"$mcp_file"
if [ -n "${PI_SANDBOX_BROWSER_URL:-}" ]; then
	jq --arg url "$PI_SANDBOX_BROWSER_URL" '.mcpServers.browser = {
		url: $url, exposure: "direct", timeout: 120,
		description: "Headless Firefox: open pages, read and interact with them, fill forms, take screenshots"
	}' "$mcp_file" >"$mcp_file.tmp" && mv "$mcp_file.tmp" "$mcp_file"
elif jq -e '.mcpServers.browser' "$mcp_file" >/dev/null 2>&1; then
	jq 'del(.mcpServers.browser)' "$mcp_file" >"$mcp_file.tmp" && mv "$mcp_file.tmp" "$mcp_file"
fi
if [ -n "${PI_SANDBOX_SCHEDULER_URL:-}" ]; then
	if [ -n "${SCHEDULER_TOKEN:-}" ]; then
		jq --arg url "$PI_SANDBOX_SCHEDULER_URL" --arg token "$SCHEDULER_TOKEN" '.mcpServers.scheduler = {
			url: $url, headers: {Authorization: ("Bearer " + $token)}, exposure: "direct", timeout: 30,
			description: "Schedule one-shot or recurring tasks that spawn isolated Pi agents"
		}' "$mcp_file" >"$mcp_file.tmp" && mv "$mcp_file.tmp" "$mcp_file"
	else
		jq --arg url "$PI_SANDBOX_SCHEDULER_URL" '.mcpServers.scheduler = {
			url: $url, exposure: "direct", timeout: 30,
			description: "Schedule one-shot or recurring tasks that spawn isolated Pi agents"
		}' "$mcp_file" >"$mcp_file.tmp" && mv "$mcp_file.tmp" "$mcp_file"
	fi
elif jq -e '.mcpServers.scheduler' "$mcp_file" >/dev/null 2>&1; then
	jq 'del(.mcpServers.scheduler)' "$mcp_file" >"$mcp_file.tmp" && mv "$mcp_file.tmp" "$mcp_file"
fi

# A usable git identity, without touching the host configuration.
git config --global --get user.name >/dev/null 2>&1 ||
	git config --global user.name "${GIT_AUTHOR_NAME:-pi-sandbox}"
git config --global --get user.email >/dev/null 2>&1 ||
	git config --global user.email "${GIT_AUTHOR_EMAIL:-pi-sandbox@localhost}"

if [ "${PI_SANDBOX_SHELL:-0}" = 1 ]; then
	exec bash "$@"
fi

# Default model (mirrored from the host by the launcher) unless one is given.
if [ -n "${PI_SANDBOX_MODEL:-}" ]; then
	for arg in "$@"; do
		case $arg in --model | --model=* | -m) PI_SANDBOX_MODEL= ;; esac
	done
	if [ -n "$PI_SANDBOX_MODEL" ]; then set -- --model "$PI_SANDBOX_MODEL" "$@"; fi
fi
exec pi "$@"
