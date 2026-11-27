#!/usr/bin/env bash
# launch.sh — provision a complete isidore instance on a Scaleway IPv6-only host.
#
# Automates the manual steps sketched in go.sh:
#   1. create the DEV1-S server with the reserved routed-IPv6 flexible IP and
#      cloud-config-scw-ipv6.yaml (netplan + DNS64/NAT64 + docker IPv6 live there)
#   2. wait for SSH and for cloud-init to finish
#   3. ship this repo + the OpenRouter key (and optional Telegram bot token),
#      create state dirs and .env
#   4. pull the GHCR images published by CI (default :latest) and force-recreate
#      the compose services (stamp checked against the checkout's commit;
#      warn-only for :latest, hard failure for pinned tags)
#   5. nginx reverse proxy in front of isidore (127.0.0.1:8920)
#   6. Let's Encrypt cert for isidore.flal.net (HTTP-01 over IPv6) + HTTPS
#
# Local prereqs: scw CLI configured, ssh/scp/tar, IPv6 connectivity, the private
# key matching cloud-config's ssh_authorized_keys (flo@dopey), and an OpenRouter
# key file. DNS: isidore.flal.net AAAA -> the host's ::cc address in the /64.
#
# Override anything with env vars, e.g.:
#   OPENROUTER_KEY_FILE=~/keys/or.key LETSENCRYPT_EMAIL=me@flal.net ./launch.sh
#   SSH_TARGET=2001:db8:...:cc ./launch.sh   # bypass DNS / use the raw IPv6
#   ISIDORE_IMAGE_TAG=v1.2.3 ./launch.sh     # pin a published image tag (default: latest)
#
# Telegram (optional): point TELEGRAM_TOKEN_FILE at a 0600 file holding the
# BotFather token and set TELEGRAM_CHATS to the comma-separated allow-list
# (private chats are positive, groups negative), e.g.:
#   TELEGRAM_TOKEN_FILE=~/.telegram-token TELEGRAM_CHATS=111111111,-1002222222222 ./launch.sh
# With no token file the bot stays disabled; the token is shipped over SSH and
# never written to .env or the image.
#
# Webhook mode (optional): Telegram can push updates instead of isidore polling.
# Set TELEGRAM_WEBHOOK_URL to the public HTTPS URL of isidore's webhook route,
# e.g. https://isidore.flal.net/telegram/webhook (nginx already forwards it).
# The URL must end in /telegram/webhook; the dev secret is derived from the bot
# token. Unset = long polling (no public endpoint needed).

set -euo pipefail

# ------------------------------------------------------------------- config ---
SERVER_NAME=${SERVER_NAME:-isidore}
DOMAIN=${DOMAIN:-isidore.flal.net}
FLEXIBLE_IP_ID=${FLEXIBLE_IP_ID:-12059d73-d72b-410e-9866-7ba2cc69302d}
SSH_USER=${SSH_USER:-flo}
SSH_TARGET=${SSH_TARGET:-$DOMAIN}
REMOTE_DIR=${REMOTE_DIR:-/home/flo/isidore}
OPENROUTER_KEY_FILE=${OPENROUTER_KEY_FILE:-$HOME/.openrouter-key}
TELEGRAM_TOKEN_FILE=${TELEGRAM_TOKEN_FILE:-$HOME/.telegram-token}
TELEGRAM_CHATS=${TELEGRAM_CHATS:-${ISIDORE_TELEGRAM_CHATS:-}}
TELEGRAM_WEBHOOK_URL=${TELEGRAM_WEBHOOK_URL:-${ISIDORE_TELEGRAM_WEBHOOK_URL:-}}
LETSENCRYPT_EMAIL=${LETSENCRYPT_EMAIL:-admin@flal.net}
SSH_KEY=${SSH_KEY:-}                  # optional private key path (ssh -i)
WAIT_TIMEOUT=${WAIT_TIMEOUT:-1800}    # seconds allowed for boot + cloud-init
PI_WEB_PACKAGE=${PI_WEB_PACKAGE:-}    # empty => pi-web-access
# Images are pulled from GHCR (published by .github/workflows/images.yml), never
# built on the host. Override the registry/tag to pin a specific build, e.g.
# ISIDORE_IMAGE_TAG=v1.2.3 or ISIDORE_IMAGE_TAG=sha-<short>.
ISIDORE_IMAGE_REGISTRY=${ISIDORE_IMAGE_REGISTRY:-ghcr.io/flo-dhalluin}
ISIDORE_IMAGE_TAG=${ISIDORE_IMAGE_TAG:-latest}

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_INIT="$REPO_DIR/cloud-config-scw-ipv6.yaml"
ssh_host="$SSH_USER@$SSH_TARGET"

SSH_OPTS=(
  -o BatchMode=yes
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=10
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=6
)
[ -n "$SSH_KEY" ] && SSH_OPTS+=(-i "$SSH_KEY")

# The published images carry io.isidore.source = the commit SHA they were built
# from (CI sets ISIDORE_SOURCE=${{ github.sha }}). Stamp the deploy with the
# local HEAD SHA so the remote can prove the pulled image matches this checkout.
# Falls back to a content hash when the repo isn't a git checkout.
source_stamp() {
  local sha
  sha=$(git -C "$REPO_DIR" rev-parse HEAD 2>/dev/null)
  if [ -z "$sha" ]; then
    sha=$(
      cd "$REPO_DIR/isidore" || exit 1
      find . -type f -not -path './node_modules/*' -not -path './dist/*' -not -path './test/*' -print0 \
        | sort -z \
        | xargs -0 -r sha256sum \
        | sha256sum \
        | cut -c1-16
    )
  fi
  printf '%s' "$sha"
}

log()    { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die()    { printf 'error: %s\n' "$*" >&2; exit 1; }
ssh_run(){ ssh "${SSH_OPTS[@]}" "$ssh_host" "$@"; }

# ---------------------------------------------------------------- preflight ---
log "Preflight"
for bin in scw ssh scp tar find sort xargs sha256sum cut; do
  command -v "$bin" >/dev/null || die "missing $bin"
done
[ -f "$CLOUD_INIT" ] || die "missing $CLOUD_INIT"
[ -s "$OPENROUTER_KEY_FILE" ] || die \
  "OpenRouter key missing/empty: $OPENROUTER_KEY_FILE (set OPENROUTER_KEY_FILE)"
SOURCE_STAMP=$(source_stamp)
echo "  source stamp: $SOURCE_STAMP"

# Telegram is optional. When a token file is present it is copied to the
# remote 0600 file below; the token itself never enters .env or the image.
# Without it, point compose at /dev/null so a leftover remote token is ignored.
TELEGRAM_REMOTE_TOKEN=/home/flo/.telegram-token
TELEGRAM_TOKEN_ENV=/dev/null
if [ -s "$TELEGRAM_TOKEN_FILE" ]; then
  TELEGRAM_TOKEN_ENV=$TELEGRAM_REMOTE_TOKEN
  echo "  telegram: token $TELEGRAM_TOKEN_FILE, chats ${TELEGRAM_CHATS:-<none>}"
  [ -n "$TELEGRAM_CHATS" ] || echo "  warning: Telegram chats list is empty; every chat will be ignored" >&2
elif [ -n "$TELEGRAM_CHATS" ]; then
  echo "  warning: TELEGRAM_CHATS set but no token file at $TELEGRAM_TOKEN_FILE; bot stays disabled" >&2
fi
if [ -n "$TELEGRAM_WEBHOOK_URL" ]; then
  case "$TELEGRAM_WEBHOOK_URL" in
    https://*/telegram/webhook) : ;;
    *) die "TELEGRAM_WEBHOOK_URL must be https://<host>/telegram/webhook: $TELEGRAM_WEBHOOK_URL" ;;
  esac
  [ -s "$TELEGRAM_TOKEN_FILE" ] || die \
    "TELEGRAM_WEBHOOK_URL requires a Telegram token (TELEGRAM_TOKEN_FILE=$TELEGRAM_TOKEN_FILE)"
  echo "  telegram: webhook $TELEGRAM_WEBHOOK_URL"
fi

# ------------------------------------------------------------- create server ---
log "Server '$SERVER_NAME' (IPv6-only, reserved flexible IP $FLEXIBLE_IP_ID)"
existing=$(scw instance server list "name=$SERVER_NAME" -o json 2>/dev/null || true)
if [[ "$existing" == *'"id"'* ]]; then
  echo "  already exists — reusing (won't recreate)"
else
  echo "  creating ..."
  ( cd "$REPO_DIR" && scw instance server create \
      "name=$SERVER_NAME" \
      image=debian_trixie \
      type=DEV1-M \
      "ip=$FLEXIBLE_IP_ID" \
      dynamic-ip-required=false ipv6=true \
      "cloud-init=@$CLOUD_INIT" )
fi

# ---------------------------------------------- wait for ssh + cloud-init -----
log "Waiting for SSH at $ssh_host (up to ${WAIT_TIMEOUT}s)"
ssh-keygen -R "$SSH_TARGET" >/dev/null 2>&1 || true   # host key changes on recreate
deadline=$((SECONDS + WAIT_TIMEOUT))
until ssh_run true >/dev/null 2>&1; do
  [ "$SECONDS" -lt "$deadline" ] || die \
    "SSH never came up (is the AAAA record the ::cc address? is IPv6 reachable?)"
  sleep 5
done
echo "  ssh up"

log "Waiting for cloud-init (apt upgrade, docker, netplan)"
# `cloud-init status` exit codes: 0 = done, 2 = done with recoverable errors,
# 1 = unrecoverable error. Anything else (e.g. 255) means ssh/cloud-init was
# not reachable yet, so keep waiting.
deadline=$((SECONDS + WAIT_TIMEOUT))
while :; do
  rc=0
  ssh_run 'sudo cloud-init status --wait >/dev/null 2>&1' || rc=$?
  case "$rc" in
    0) echo "  cloud-init done"; break ;;
    2) echo "  cloud-init done (recoverable errors — 'sudo cloud-init status --long' for details)"; break ;;
    1) die "cloud-init failed (run 'sudo cloud-init status --long' on the host)" ;;
  esac
  [ "$SECONDS" -lt "$deadline" ] || die "cloud-init did not finish (last exit code $rc)"
  sleep 5
done
ssh_run 'systemctl is-active --quiet docker' || die "docker daemon not ready"
echo "  docker ready"

# --------------------------------------------------------------- ship files ---
log "Copying OpenRouter key -> $ssh_host:/home/flo/.openrouter-key"
scp "${SSH_OPTS[@]}" "$OPENROUTER_KEY_FILE" "$ssh_host:/home/flo/.openrouter-key"
ssh_run 'chmod 600 /home/flo/.openrouter-key'

if [ -s "$TELEGRAM_TOKEN_FILE" ]; then
  log "Copying Telegram bot token -> $ssh_host:$TELEGRAM_REMOTE_TOKEN"
  scp "${SSH_OPTS[@]}" "$TELEGRAM_TOKEN_FILE" "$ssh_host:$TELEGRAM_REMOTE_TOKEN"
  ssh_run "chmod 600 '$TELEGRAM_REMOTE_TOKEN'"
fi

log "Syncing repo -> $ssh_host:$REMOTE_DIR"
ssh_run "mkdir -p '$REMOTE_DIR'"
tar -C "$REPO_DIR" \
    --exclude='./.git' \
    --exclude='*/node_modules' \
    --exclude='*/dist' \
    --exclude='*/.venv' \
    --exclude='*/__pycache__' \
    --exclude='*.pyc' \
    --exclude='./.env' \
    --exclude='./.env.*' \
    --exclude='./docs' \
    -cf - . \
  | ssh_run "tar -C '$REMOTE_DIR' -xf -"
echo "  repo synced"

# --------------------------------------------------------------- provision ---
log "Provisioning: compose + nginx + Let's Encrypt"
# Config is injected as a small header; the body is a quoted heredoc so nginx's
# $variables and the remote shell's $variables are left for the remote bash.
{
  printf 'DOMAIN=%q\n' "$DOMAIN"
  printf 'EMAIL=%q\n' "$LETSENCRYPT_EMAIL"
  printf 'REMOTE_DIR=%q\n' "$REMOTE_DIR"
  printf 'SOURCE_STAMP=%q\n' "$SOURCE_STAMP"
  printf 'ISIDORE_IMAGE_REGISTRY=%q\n' "$ISIDORE_IMAGE_REGISTRY"
  printf 'ISIDORE_IMAGE_TAG=%q\n' "$ISIDORE_IMAGE_TAG"
  printf 'PI_WEB_PACKAGE=%q\n' "$PI_WEB_PACKAGE"
  printf 'TELEGRAM_TOKEN_ENV=%q\n' "$TELEGRAM_TOKEN_ENV"
  printf 'TELEGRAM_CHATS=%q\n' "$TELEGRAM_CHATS"
  printf 'TELEGRAM_WEBHOOK_URL=%q\n' "$TELEGRAM_WEBHOOK_URL"
  cat <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

PUID=$(id -u)
PGID=$(id -g)
STATE=/home/flo/.local/state/pi-sandbox
KEY=/home/flo/.openrouter-key
SITE="/etc/nginx/sites-available/$DOMAIN"
WEBROOT=/var/www/letsencrypt
LIVE="/etc/letsencrypt/live/$DOMAIN"

echo "-- state dirs + .env"
mkdir -p "$STATE/isidore" "$STATE/scheduler"
# Docker creates the named-volume mountpoints inside the bind-mounted state
# dirs as root-owned host directories (isidore: shared, scheduler-shared;
# scheduler: shared, isidore-shared). A recursive host chown hits them and
# fails with EPERM, aborting the deploy. Docker owns those volume contents; we
# only need the rest of the state tree writable by the runtime user.
chown "$PUID:$PGID" "$STATE" "$STATE/isidore" "$STATE/scheduler"
find "$STATE/isidore" -mindepth 1 -maxdepth 1 \
  ! -name shared ! -name scheduler-shared \
  -exec chown -R "$PUID:$PGID" {} +
find "$STATE/scheduler" -mindepth 1 -maxdepth 1 \
  ! -name shared ! -name isidore-shared \
  -exec chown -R "$PUID:$PGID" {} +
cat > "$REMOTE_DIR/.env" <<EOF
PI_SANDBOX_KEY_FILE=$KEY
PI_UID=$PUID
PI_GID=$PGID
ISIDORE_STATE=$STATE/isidore
SCHEDULER_STATE=$STATE/scheduler
PI_WEB_PACKAGE=$PI_WEB_PACKAGE
ISIDORE_TELEGRAM_TOKEN_FILE=$TELEGRAM_TOKEN_ENV
ISIDORE_TELEGRAM_CHATS=$TELEGRAM_CHATS
ISIDORE_TELEGRAM_WEBHOOK_URL=$TELEGRAM_WEBHOOK_URL
EOF
chmod 600 "$REMOTE_DIR/.env"

echo "-- docker compose pull + recreate (image tag $ISIDORE_IMAGE_TAG)"
cd "$REMOTE_DIR"
# Layer compose.images.yaml over compose.yaml: it overrides each service's
# image: with the GHCR image published by CI and pins pull_policy: always, so
# compose pulls the published image instead of building the local context.
COMPOSE_FILES="-f compose.yaml -f compose.images.yaml"
# compose.yaml interpolates this into the isidore image build arg. It is unused
# when pulling (no build), but the published image carries the same value in its
# io.isidore.source label, which the checks below verify against the running
# container.
export ISIDORE_SOURCE="$SOURCE_STAMP"
export ISIDORE_IMAGE_REGISTRY ISIDORE_IMAGE_TAG
# --force-recreate restarts containers even when Docker thinks they are up to
# date; --wait fails if a service never comes up.
docker compose $COMPOSE_FILES pull
docker compose $COMPOSE_FILES up -d --force-recreate --remove-orphans --wait --wait-timeout 180

# Prove the running container's image was built from this checkout's commit.
# Inspect the image by the container's image ID: `docker compose config
# --images` lists every service's image (the service filter is ignored), so it
# cannot target isidore alone.
isidore_container=$(docker compose $COMPOSE_FILES ps -q isidore)
if [ -z "$isidore_container" ]; then
  echo "error: isidore container is not running" >&2
  docker compose $COMPOSE_FILES ps >&2 || true
  exit 1
fi
running_image=$(docker inspect "$isidore_container" --format '{{.Image}}')
image_stamp=$(docker image inspect "$running_image" --format '{{ index .Config.Labels "io.isidore.source" }}' 2>/dev/null || true)
if [ "$image_stamp" != "$SOURCE_STAMP" ]; then
  # `latest` is a moving target (main's newest build), so a SHA mismatch is
  # expected when the checkout is behind main or the branch was merged under a
  # different commit — warn and proceed. Pinned tags (sha-<short>, vX.Y.Z) are
  # exact: a mismatch there means the image really wasn't built from this
  # checkout, so fail.
  if [ "$ISIDORE_IMAGE_TAG" = "latest" ]; then
    echo "warning: isidore image stamp '$image_stamp' does not match checkout '$SOURCE_STAMP'" >&2
    echo "         deploying main's latest build; checkout main for an exact match," >&2
    echo "         or pin ISIDORE_IMAGE_TAG (e.g. sha-<short>) to enforce the check" >&2
  else
    echo "error: isidore image stamp '$image_stamp' does not match checkout '$SOURCE_STAMP'" >&2
    echo "       the published image was not built from this commit" >&2
    echo "       (push and let CI build, or set ISIDORE_IMAGE_TAG to a matching tag)" >&2
    exit 1
  fi
fi
echo "   isidore running $running_image (built from $image_stamp)"

echo "-- install nginx + certbot"
sudo apt-get update -qq
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo systemctl enable --now nginx
sudo rm -f /etc/nginx/sites-enabled/default
sudo mkdir -p "$WEBROOT"

# Reload nginx after every successful renewal (webroot authenticator below).
sudo mkdir -p /etc/letsencrypt/renewal-hooks/deploy
sudo tee /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh >/dev/null <<'HOOK'
#!/bin/sh
systemctl reload nginx
HOOK
sudo chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

echo "-- nginx phase A: HTTP (ACME challenge + proxy)"
sudo tee "$SITE" >/dev/null <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }

    location / {
        proxy_pass http://127.0.0.1:8920;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGINX
sudo sed -i "s/__DOMAIN__/$DOMAIN/g" "$SITE"
sudo ln -sfn "$SITE" "/etc/nginx/sites-enabled/$DOMAIN"
sudo nginx -t
sudo systemctl reload nginx

echo "-- Let's Encrypt (HTTP-01 over IPv6, webroot authenticator)"
if [ ! -f "$LIVE/fullchain.pem" ]; then
  sudo certbot certonly \
      --webroot -w "$WEBROOT" \
      -d "$DOMAIN" \
      --non-interactive --agree-tos -m "$EMAIL"
else
  echo "   certificate already present, skipping issuance"
fi

echo "-- nginx phase B: HTTPS + redirect"
sudo tee "$SITE" >/dev/null <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

    location /.well-known/acme-challenge/ { root /var/www/letsencrypt; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name __DOMAIN__;

    ssl_certificate     /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:SSL:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    location / {
        proxy_pass http://127.0.0.1:8920;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }
}
NGINX
sudo sed -i "s/__DOMAIN__/$DOMAIN/g" "$SITE"
sudo nginx -t
sudo systemctl reload nginx

echo "-- done"
echo "   isidore: https://$DOMAIN/"
echo "   admin token (also: docker compose $COMPOSE_FILES exec -T isidore cat /state/shared/admin-token):"
tok=""
for _ in $(seq 1 30); do
  tok=$(docker compose $COMPOSE_FILES exec -T isidore cat /state/shared/admin-token 2>/dev/null) && break
  sleep 2
done
if [ -n "$tok" ]; then
  echo "   $tok"
  echo "   open: https://$DOMAIN/?token=$tok"
else
  echo "   (not ready yet — run the command above in $REMOTE_DIR)"
fi
REMOTE
} | ssh_run 'cat > /tmp/isidore-provision.sh && bash /tmp/isidore-provision.sh'

log "All done"
