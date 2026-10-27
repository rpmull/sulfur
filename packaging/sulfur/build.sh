#!/usr/bin/env bash
# Developer-run build entry point. Native tooling is provided by Tauri.
set -euo pipefail
cd "$(dirname "$0")/../.."
exec bun run build "$@"
