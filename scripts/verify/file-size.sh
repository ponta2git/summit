#!/usr/bin/env bash
# Warn on TypeScript source files exceeding the soft split threshold.
#
# Rationale: docs/dev-rule.md defines the 300-line cohesion review threshold.
# This script is advisory — it emits warnings so that drift toward very large
# files stays visible in CI output without blocking progress. Never exits
# non-zero on threshold violations (reviewers decide when a split is worth it).
#
# Threshold:
#   - WARN_LINES (default 300): soft split reminder
#
# Scope: src/**/*.ts and tests/**/*.ts (excluding generated/build artifacts).

set -euo pipefail

WARN_LINES="${WARN_LINES:-300}"

warn_count=0

while IFS= read -r -d '' file; do
  lines=$(wc -l < "$file" | tr -d ' ')
  if [[ "$lines" -gt "$WARN_LINES" ]]; then
    echo "⚠️  ${file}: ${lines} lines (soft split threshold ${WARN_LINES})"
    warn_count=$((warn_count + 1))
  fi
done < <(find src tests -type f -name '*.ts' -not -path '*/node_modules/*' -not -path '*/dist/*' -print0 | sort -z)

echo "--- summary ---"
echo "warn (>${WARN_LINES}): ${warn_count}"
echo "✅ file-size: advisory only (never fails)"
