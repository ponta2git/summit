#!/usr/bin/env bash
set -euo pipefail

pnpm db:generate

if git --no-pager diff --quiet -- drizzle/; then
  echo "✅ no migration drift"
else
  echo "❌ migration drift detected" >&2
  git --no-pager diff -- drizzle/ >&2
  exit 1
fi
