#!/usr/bin/env bash
# Best-effort swagger static sync after npm install on production hosts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash "${ROOT}/scripts/sync-swagger-ui-static.sh"
