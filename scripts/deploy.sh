#!/usr/bin/env bash
# Deploy Dunedin Euchre from committed Mac source by rsync. ForksTech is a
# generated deployment target and never performs Git operations.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
REMOTE_HOST="${REMOTE_HOST:-michael@100.120.233.4}"
REMOTE_DIR="${REMOTE_DIR:-/home/michael/deployments/dunedin-euchre}"
SERVICE_NAME="dunedin-euchre"

for command_name in git ssh rsync curl; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "ERROR: Missing required command: $command_name" >&2
    exit 1
  }
done

if [[ "$(git -C "$REPO_ROOT" branch --show-current)" != "main" ]]; then
  echo "ERROR: Deploys must run from main." >&2
  exit 1
fi
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]]; then
  echo "ERROR: Working tree is dirty. Commit changes before deploying." >&2
  exit 1
fi

git -C "$REPO_ROOT" push origin main
ssh "$REMOTE_HOST" "install -d -m 700 '$REMOTE_DIR'"
rsync -az --delete -e ssh \
  --exclude='.git/' \
  --exclude='.env' \
  --exclude='.deployment.json' \
  --exclude='.DS_Store' \
  --exclude='.claude/' \
  --exclude='node_modules/' \
  --exclude='data/' \
  --exclude='uploads/' \
  --exclude='logs/' \
  --exclude='*.db' \
  --exclude='*.db-shm' \
  --exclude='*.db-wal' \
  "$REPO_ROOT/" "$REMOTE_HOST:$REMOTE_DIR/"

ssh "$REMOTE_HOST" "REMOTE_DIR='$REMOTE_DIR' SERVICE_NAME='$SERVICE_NAME' bash -s" <<'REMOTE_EOF'
set -euo pipefail
cd "$REMOTE_DIR"
docker compose config --quiet
docker compose build "$SERVICE_NAME"
docker compose up -d --no-deps "$SERVICE_NAME"

deadline=$((SECONDS + 120))
while true; do
  container_id="$(docker compose ps -q "$SERVICE_NAME")"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id")"
  [[ "$health" == healthy ]] && break
  if [[ "$health" == unhealthy || "$health" == exited || "$health" == dead || SECONDS -ge deadline ]]; then
    docker compose logs --tail=100 "$SERVICE_NAME" >&2 || true
    exit 1
  fi
  sleep 5
done

docker exec "$container_id" node -e \
  'fetch("http://127.0.0.1:3456/healthz").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
REMOTE_EOF

curl -fsS --max-time 15 https://dunedin-euchre.com/healthz >/dev/null
echo "Dunedin Euchre deployment completed successfully."
