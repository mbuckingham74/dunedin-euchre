#!/usr/bin/env bash
# deploy.sh — Deploy dunedin-euchre to forkstech.com VPS
# Usage: ./deploy.sh
# Requires: SSH key access to michael@100.120.233.4 via Tailscale

set -euo pipefail

REMOTE_HOST="michael@100.120.233.4"
REMOTE_DIR="~/apps/dunedin-euchre"

echo "→ Deploying to ${REMOTE_HOST}:${REMOTE_DIR}"

ssh "${REMOTE_HOST}" bash <<'EOF'
  set -euo pipefail

  SERVICE_NAME="dunedin-euchre"
  HEALTH_TIMEOUT_SECONDS=120
  HEALTH_POLL_SECONDS=5

  cd ~/apps/dunedin-euchre

  echo "  → Pulling latest from GitHub..."
  git pull --ff-only origin main

  echo "  → Building updated image..."
  docker compose build --pull "${SERVICE_NAME}"

  echo "  → Starting updated container..."
  docker compose up -d --no-deps "${SERVICE_NAME}"

  container_id="$(docker compose ps -q "${SERVICE_NAME}")"
  if [[ -z "${container_id}" ]]; then
    echo "  ✗ Could not determine container ID for ${SERVICE_NAME}."
    exit 1
  fi

  echo "  → Waiting for health check..."
  deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  while true; do
    health_status="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${container_id}")"

    case "${health_status}" in
      healthy)
        echo "  ✓ Container is healthy."
        break
        ;;
      starting|running|created|restarting)
        if (( SECONDS >= deadline )); then
          echo "  ✗ Timed out waiting for ${SERVICE_NAME} to become healthy."
          docker compose logs --tail=100 "${SERVICE_NAME}"
          exit 1
        fi

        sleep "${HEALTH_POLL_SECONDS}"
        ;;
      *)
        echo "  ✗ ${SERVICE_NAME} reported health status: ${health_status}"
        docker compose logs --tail=100 "${SERVICE_NAME}"
        exit 1
        ;;
    esac
  done

  echo "  → Pruning stale Docker layers..."
  docker image prune -f >/dev/null
  docker builder prune -af --filter 'until=24h' >/dev/null

  echo "  → Status:"
  docker compose ps
EOF

echo ""
echo "✓ Deploy complete. App running at https://dunedin-euchre.com"
