#!/usr/bin/env bash
set -euo pipefail

export LC_ALL=C
export LANG=C
export TZ=UTC

readonly RUNS=3
readonly EXPECTED_CASES=25
readonly EXPECTED_TURNS=41
readonly ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/agent-skills-autoresearch.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

latencies=()

for ((run = 1; run <= RUNS; run++)); do
  output="$TMP_ROOT/run-$run.txt"
  if ! node "$ROOT/evaluation/adversarial-v1.mjs" >"$output" 2>&1; then
    cat "$output" >&2
    exit 1
  fi

  if ! grep -Fq "Cases: $EXPECTED_CASES | pass: $EXPECTED_CASES | fail: 0" "$output"; then
    cat "$output" >&2
    echo "autoresearch: unexpected adversarial case result" >&2
    exit 1
  fi

  if ! grep -Fq "turns: $EXPECTED_TURNS deterministic process/helper invocations" "$output"; then
    cat "$output" >&2
    echo "autoresearch: workload shape changed" >&2
    exit 1
  fi

  latency="$(sed -n 's/^  latency_ms: \([0-9][0-9]*\.[0-9][0-9]*\) wall-clock local measurement$/\1/p' "$output")"
  if [[ -z "$latency" ]]; then
    cat "$output" >&2
    echo "autoresearch: latency metric missing" >&2
    exit 1
  fi
  latencies+=("$latency")
done

metrics="$(printf '%s\n' "${latencies[@]}" | sort -n)"
minimum="$(printf '%s\n' "$metrics" | sed -n '1p')"
median="$(printf '%s\n' "$metrics" | sed -n '2p')"
maximum="$(printf '%s\n' "$metrics" | sed -n '3p')"

printf 'METRIC adversarial_latency_ms=%s\n' "$median"
printf 'METRIC adversarial_latency_min_ms=%s\n' "$minimum"
printf 'METRIC adversarial_latency_max_ms=%s\n' "$maximum"
printf 'METRIC adversarial_cases_passed=%s\n' "$EXPECTED_CASES"
printf 'METRIC workload_turns=%s\n' "$EXPECTED_TURNS"
