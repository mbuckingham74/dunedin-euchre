#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRIVY_IMAGE="${TRIVY_IMAGE:-ghcr.io/aquasecurity/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969}"
TRIVY_CACHE_DIR="${TRIVY_CACHE_DIR:-$HOME/.cache/trivy}"
SEVERITY="${TRIVY_SEVERITY:-HIGH,CRITICAL}"
APP_IMAGE_TAG="${APP_IMAGE_TAG:-dunedin-euchre:trivy-scan}"
TARGET="${1:-all}"

FS_SKIP_DIRS=(
  "/workspace/node_modules"
  "/workspace/data"
  "/workspace/uploads"
  "/workspace/logs"
  "/workspace/.git"
)

FS_SKIP_FILES=(
  "/workspace/*.db"
  "/workspace/*.db-journal"
  "/workspace/*.db-shm"
  "/workspace/*.db-wal"
)

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "docker is required to run Trivy scans." >&2
    exit 1
  fi
}

pull_trivy_image() {
  echo "Pulling ${TRIVY_IMAGE}..."
  docker pull "${TRIVY_IMAGE}" >/dev/null
}

run_trivy() {
  docker run --rm "$@"
}

scan_filesystem() {
  local args=()

  for path in "${FS_SKIP_DIRS[@]}"; do
    args+=(--skip-dirs "$path")
  done

  for path in "${FS_SKIP_FILES[@]}"; do
    args+=(--skip-files "$path")
  done

  echo ""
  echo "==> Scanning repository filesystem and config"
  run_trivy \
    -v "${ROOT_DIR}:/workspace:ro" \
    -v "${TRIVY_CACHE_DIR}:/root/.cache/trivy" \
    "${TRIVY_IMAGE}" fs \
    --severity "${SEVERITY}" \
    --scanners vuln,misconfig \
    --ignore-unfixed \
    --ignorefile /workspace/.trivyignore \
    --exit-code 1 \
    --no-progress \
    "${args[@]}" \
    /workspace
}

scan_image() {
  echo ""
  echo "==> Building ${APP_IMAGE_TAG}"
  docker build -t "${APP_IMAGE_TAG}" "${ROOT_DIR}"

  echo ""
  echo "==> Scanning Docker image ${APP_IMAGE_TAG}"
  run_trivy \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "${TRIVY_CACHE_DIR}:/root/.cache/trivy" \
    -v "${ROOT_DIR}/.trivyignore:/workspace/.trivyignore:ro" \
    "${TRIVY_IMAGE}" image \
    --severity "${SEVERITY}" \
    --scanners vuln,misconfig \
    --ignore-unfixed \
    --ignorefile /workspace/.trivyignore \
    --exit-code 1 \
    --no-progress \
    "${APP_IMAGE_TAG}"
}

scan_all() {
  local fs_status=0
  local image_status=0

  scan_filesystem || fs_status=$?
  scan_image || image_status=$?

  if (( fs_status != 0 || image_status != 0 )); then
    return 1
  fi
}

main() {
  require_docker
  mkdir -p "${TRIVY_CACHE_DIR}"
  pull_trivy_image

  case "${TARGET}" in
    all)
      scan_all
      ;;
    fs)
      scan_filesystem
      ;;
    image)
      scan_image
      ;;
    *)
      echo "Usage: bash scripts/trivy-scan.sh [all|fs|image]" >&2
      exit 64
      ;;
  esac
}

main
