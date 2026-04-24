#!/usr/bin/env bash
set -euo pipefail

for dir in /app/data /app/uploads /app/logs; do
  mkdir -p "${dir}"
  chown -R appuser:appgroup "${dir}"
done

exec gosu appuser "$@"
