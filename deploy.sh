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
  cd ~/apps/dunedin-euchre

  echo "  → Pulling latest from GitHub..."
  git pull origin main

  echo "  → Building and restarting container..."
  docker compose build
  docker compose up -d

  echo "  → Status:"
  docker compose ps
EOF

echo ""
echo "✓ Deploy complete. App running at https://dunedin-euchre.com"
