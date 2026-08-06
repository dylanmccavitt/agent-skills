#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export LANG=C
export TZ=UTC

readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly RUNNER="${SKILL_BEHAVIOR_RUNNER:-$ROOT/evaluation/adapters/skill-behavior-cli.mjs}"
readonly EXPECTED_SCENARIOS=24

if [[ ! -x "$RUNNER" && ! -f "$RUNNER" ]]; then
  echo "behavior-autoresearch: runner missing: $RUNNER" >&2
  exit 1
fi

mode="${SKILL_BEHAVIOR_MODE:-}"
if [[ -z "${SKILL_BEHAVIOR_AGENT_CMD:-}" && -z "$mode" ]]; then
  mode="plumbing"
fi

output="$(mktemp "${TMPDIR:-/tmp}/skill-behavior-autoresearch.XXXXXX")"
trap 'rm -f "$output"' EXIT

env_args=(
  "SKILL_BEHAVIOR_MODE=${mode}"
)
if [[ -n "${SKILL_BEHAVIOR_AGENT_CMD:-}" ]]; then
  env_args+=("SKILL_BEHAVIOR_AGENT_CMD=${SKILL_BEHAVIOR_AGENT_CMD}")
fi
if [[ -n "${SKILL_BEHAVIOR_TRANSCRIPT_DIR:-}" ]]; then
  env_args+=("SKILL_BEHAVIOR_TRANSCRIPT_DIR=${SKILL_BEHAVIOR_TRANSCRIPT_DIR}")
fi

if ! env "${env_args[@]}" node "$ROOT/evaluation/skill-behavior-v1.mjs" \
  --runner "$RUNNER" \
  --measure >"$output" 2>&1; then
  cat "$output" >&2
  echo "behavior-autoresearch: evaluator failed" >&2
  exit 1
fi

if ! grep -Eq "^METRIC scenarios_passed=[0-9]+$" "$output"; then
  cat "$output" >&2
  echo "behavior-autoresearch: scenarios_passed metric missing" >&2
  exit 1
fi

passed="$(sed -n 's/^METRIC scenarios_passed=//p' "$output" | tail -n1)"
if ! grep -Eq "Scenarios: ${EXPECTED_SCENARIOS} \\|" "$output"; then
  cat "$output" >&2
  echo "behavior-autoresearch: unexpected scenario count" >&2
  exit 1
fi

# Re-emit the evaluator metrics for the outer autoresearch harness.
grep -E '^METRIC ' "$output"

# Guardrail: plumbing/no-agent runs are IO baseline only.
if [[ "${mode}" == "plumbing" || -z "${SKILL_BEHAVIOR_AGENT_CMD:-}" ]]; then
  printf 'METRIC behavior_mode=plumbing\n'
  printf 'METRIC live_agent=0\n'
else
  printf 'METRIC behavior_mode=live\n'
  printf 'METRIC live_agent=1\n'
fi

printf 'METRIC scenarios_total=%s\n' "$EXPECTED_SCENARIOS"
printf 'METRIC scenarios_passed_count=%s\n' "$passed"
