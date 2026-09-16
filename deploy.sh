#!/usr/bin/env bash
set -euo pipefail

# Build on the developer machine; install production dependencies on Linux.
# Native macOS packages and local .env files must never enter the release.
cd "$(dirname "$0")"
REMOTE_HOST="${REMOTE_HOST:-root@racknerd}"
DEPLOY_DOMAIN="${DEPLOY_DOMAIN:-deaddrop.thehivemind5.com}"
DEPLOY_PORT="${DEPLOY_PORT:-4310}"
REMOTE_NODE="${REMOTE_NODE:-/opt/deaddrop-node/bin/node}"
[[ "$DEPLOY_DOMAIN" =~ ^[a-z0-9.-]+$ ]] || exit 1
[[ "$DEPLOY_PORT" =~ ^[0-9]+$ ]] || exit 1
(( DEPLOY_PORT >= 1 && DEPLOY_PORT <= 65534 )) || exit 1
[[ "$REMOTE_NODE" =~ ^/[a-zA-Z0-9/._-]+$ ]] || exit 1

if [[ "${ALLOW_DIRTY:-0}" != 1 ]] && [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit changes before deploying (or explicitly set ALLOW_DIRTY=1)." >&2
  exit 1
fi

npm run typecheck
npm test
npm run build

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
RELEASE="$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short HEAD)"
mkdir -p "$STAGE/app"
# Copy only the standalone server and compiled application, not its env files.
cp .next/standalone/server.js package.json package-lock.json "$STAGE/app/"
cp -R .next/standalone/.next "$STAGE/app/.next"
cp -R .next/static "$STAGE/app/.next/static"
if [[ -d public ]]; then cp -R public "$STAGE/app/public"; fi
rm -rf "$STAGE/app/.next/cache"
mkdir -p "$STAGE/app/.next/cache"
printf '%s\n' "$RELEASE" > "$STAGE/app/RELEASE"
sed -e "s/__DOMAIN__/$DEPLOY_DOMAIN/g" -e "s/__PORT__/$DEPLOY_PORT/g" \
  deploy/nginx.conf.template > "$STAGE/nginx.conf"
sed -e "s/__PORT__/$DEPLOY_PORT/g" -e "s|__NODE__|$REMOTE_NODE|g" \
  deploy/deaddrop.service.template > "$STAGE/deaddrop.service"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$STAGE/release.tar.gz" -C "$STAGE/app" .

ssh "$REMOTE_HOST" "mkdir -p /app/deaddrop/releases/$RELEASE /app/deaddrop/shared /app/deaddrop/acme"
scp "$STAGE/release.tar.gz" "$STAGE/nginx.conf" "$STAGE/deaddrop.service" \
  "$REMOTE_HOST:/app/deaddrop/releases/$RELEASE/"
ssh "$REMOTE_HOST" bash -s -- "$RELEASE" "$DEPLOY_PORT" "$REMOTE_NODE" "$DEPLOY_DOMAIN" <<'REMOTE'
set -euo pipefail
release="$1"; port="$2"; node="$3"; domain="$4"
root=/app/deaddrop
target="$root/releases/$release"
test -s "$root/shared/app.env"
id deaddrop >/dev/null 2>&1 || useradd --system --home-dir "$root" --shell /sbin/nologin deaddrop
chmod 700 "$root/shared"
chmod 600 "$root/shared/app.env"
cd "$target"
tar -xzf release.tar.gz
rm release.tar.gz
export PATH="$(dirname "$node"):$PATH"
npm ci --omit=dev --no-audit --no-fund
chown -R root:deaddrop "$target"
chmod -R g+rX,o-rwx "$target"
chown deaddrop:deaddrop "$target/.next/cache"

# Preflight on a separate loopback port before changing the live symlink.
stage_port=$((port + 1))
systemd-run --unit=deaddrop-preflight --collect \
  --property=User=deaddrop --property=Group=deaddrop \
  --property="WorkingDirectory=$target" \
  --property="EnvironmentFile=$root/shared/app.env" \
  --setenv=NODE_ENV=production --setenv=HOSTNAME=127.0.0.1 \
  --setenv="PORT=$stage_port" --setenv=NEXT_TELEMETRY_DISABLED=1 \
  "$node" "$target/server.js"
trap 'systemctl stop deaddrop-preflight 2>/dev/null || true' EXIT
healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:$stage_port/api/health" >/dev/null; then healthy=1; break; fi
  sleep 1
done
if [[ "$healthy" != 1 ]]; then
  journalctl -u deaddrop-preflight -n 30 --no-pager
  exit 1
fi
curl --fail --silent "http://127.0.0.1:$stage_port/login" >/dev/null
curl --fail --silent "http://127.0.0.1:$stage_port/openapi.json" >/dev/null
systemctl stop deaddrop-preflight
trap - EXIT

previous="$(readlink -f "$root/current" || true)"
if [[ -n "$previous" && -d "$previous" ]]; then ln -sfn "$previous" "$root/previous"; fi
ln -sfn "$target" "$root/current.next"
mv -Tf "$root/current.next" "$root/current"
install -m 644 "$target/deaddrop.service" /etc/systemd/system/deaddrop.service
systemctl daemon-reload
systemctl enable deaddrop
systemctl restart deaddrop
healthy=0
for attempt in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:$port/api/health" >/dev/null; then healthy=1; break; fi
  sleep 1
done
if [[ "$healthy" != 1 ]]; then
  if [[ -n "$previous" && -d "$previous" ]]; then
    ln -sfn "$previous" "$root/current"
    install -m 644 "$previous/deaddrop.service" /etc/systemd/system/deaddrop.service
    systemctl daemon-reload
    systemctl restart deaddrop
  fi
  echo "Deployment health check failed; restored previous release when available." >&2
  exit 1
fi

if [[ -f "/etc/letsencrypt/live/$domain/fullchain.pem" ]]; then
  existing=/etc/nginx/conf.d/deaddrop.conf
  if [[ -f "$existing" ]]; then cp "$existing" "$target/nginx.previous"; fi
  install -m 644 "$target/nginx.conf" "$existing"
  if nginx -t; then
    systemctl reload nginx
  else
    if [[ -f "$target/nginx.previous" ]]; then cp "$target/nginx.previous" "$existing"; else rm "$existing"; fi
    exit 1
  fi
else
  echo "App is running privately. Provision HTTPS, then install $target/nginx.conf."
fi
echo "Deployed $release"
REMOTE
