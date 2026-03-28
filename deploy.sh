#!/usr/bin/env bash
# deploy.sh — Deploy dunedin-euchre to forkstech.com VPS
# Usage: ./deploy.sh
# Requires: SSH key access to michael@100.120.233.4 via Tailscale

set -euo pipefail

REMOTE_HOST="michael@100.120.233.4"
REMOTE_DIR="$HOME/apps/dunedin-euchre"
PM2_APP="dunedin-euchre"

echo "→ Deploying to ${REMOTE_HOST}:${REMOTE_DIR}"

ssh "${REMOTE_HOST}" bash <<EOF
  set -euo pipefail

  # Create app dir if first deploy
  mkdir -p "${REMOTE_DIR}"
  cd "${REMOTE_DIR}"

  echo "  → Pulling latest from GitHub..."
  git pull origin main

  echo "  → Installing production dependencies..."
  npm install --production --no-audit --no-fund

  echo "  → Creating uploads directory..."
  mkdir -p uploads logs

  # Start or restart PM2 process
  if pm2 show "${PM2_APP}" > /dev/null 2>&1; then
    echo "  → Restarting PM2 process..."
    pm2 restart "${PM2_APP}"
  else
    echo "  → Starting PM2 process for the first time..."
    pm2 start ecosystem.config.js
    pm2 save
  fi

  echo "  → Done. App status:"
  pm2 show "${PM2_APP}" | grep -E "(status|uptime|restarts)" || true
EOF

echo ""
echo "✓ Deploy complete. App running at https://dunedin-euchre.com"
