#!/usr/bin/env bash
set -euo pipefail

if ! command -v rg >/dev/null 2>&1; then
  message="rg is required for verify:forbidden"
  if [[ "${CI:-}" == "true" ]]; then
    echo "❌ ${message} (CI must provide ripgrep)" >&2
    exit 1
  fi
  echo "⚠️  ${message}" >&2
  exit 2
fi

RULE_COUNTS=""
total_matches=0

run_rule() {
  local rule_id="$1"
  local pattern="$2"
  shift 2

  local output
  output=$(rg --line-number --no-heading --color=never "$pattern" "$@" 2>/dev/null || true)

  local count=0
  if [[ -n "${output}" ]]; then
    while IFS= read -r line; do
      [[ -z "${line}" ]] && continue
      local path="${line%%:*}"
      local rest="${line#*:}"
      local line_number="${rest%%:*}"
      local text="${rest#*:}"
      echo "❌ [${rule_id}] ${path}:${line_number}: ${text}"
      count=$((count + 1))
      total_matches=$((total_matches + 1))
    done <<< "${output}"
  fi

  RULE_COUNTS="${RULE_COUNTS}${rule_id}=${count}"$'\n'
}

run_rule "no-sql-raw" "\\bsql\\.raw\\(" -g "src/**"

run_rule "no-drizzle-kit-push" "drizzle-kit\\s+push" . \
  -g "*.ts" -g "*.mjs" -g "*.cjs" -g "*.js" -g "*.json" -g "*.yml" -g "*.yaml" -g "*.sh" \
  -g "!node_modules/**" \
  -g "!dist/**" \
  -g "!drizzle/**" \
  -g "!.git/**" \
  -g "!pnpm-lock.yaml" \
  -g "!scripts/verify/forbidden-patterns.sh"

run_rule "no-as-never" "\\bas\\s+never\\b" \
  -g "src/**" \
  -g "tests/**"

run_rule "no-adhoc-date" "new\\s+Date\\s*\\(|Date\\.parse\\s*\\(" -g "src/**" -g "!src/time/**"

run_rule "no-direct-url-in-src" "DIRECT_URL" -g "src/**" -g "!src/logger.ts" -g "!src/db/client.ts"

run_rule "no-cross-feature-side-effect-import" \
  "from\\s+\"\\.\\./[a-z-]+/(send|settle|messageEditor)\\.js\"" \
  -g "src/features/**"

run_rule "no-secret-shape" "[A-Za-z0-9_-]{23,28}\\.[A-Za-z0-9_-]{6,7}\\.[A-Za-z0-9_-]{27,}" . \
  -g "!node_modules/**" \
  -g "!dist/**" \
  -g "!.git/**" \
  -g "!pnpm-lock.yaml" \
  -g "!scripts/verify/forbidden-patterns.sh"

if [[ "${total_matches}" -gt 0 ]]; then
  echo "--- summary ---"
  for rule_id in \
    no-sql-raw \
    no-drizzle-kit-push \
    no-as-never \
    no-adhoc-date \
    no-direct-url-in-src \
    no-cross-feature-side-effect-import \
    no-secret-shape; do
    local_count=$(printf '%s' "${RULE_COUNTS}" | grep -E "^${rule_id}=" | tail -1 | cut -d= -f2)
    echo "${rule_id}: ${local_count:-0}"
  done
  echo "total: ${total_matches}"
  exit 1
fi

echo "✅ forbidden-patterns: no matches"
