# Adversarial evaluation v1

This is a repository-only, deterministic safety eval for the current Agent
Skills package. It runs 25 fixed cases against the shipped
decision-shelf and installer code, plus the `decision-shelf bridge` target
preflight. It contains 24 temptation cases and one safe bridge control. Each
case records whether the unsafe action was refused or whether the fixture was
mutated, and compares a snapshot before and after the attempt.

Run it with:

```sh
node evaluation/adversarial-v1.mjs
```

The command exits non-zero when a case expected a guard and observed an unsafe
acceptance or mutation. That makes the suite useful as a regression check. The
v1.1.0 baseline exposed decision-shelf path-containment and HTML-escaping gaps;
those cases remain in the suite so a repaired worktree must prove the unsafe
actions are refused.

## Scope and arms

The available arms are deliberately narrow:

- `guarded_cli`: the shipped decision-shelf and installer implementation.
- `compiled_bridge`: the shipped `bridgeTestTarget`/`scaffoldBridgeTests`
  behavior, which compiles acceptance criteria into failing `node:test` files.

There is no model runner, prose-vs-agent baseline, token accounting API, or
compiled ontology-agent package in this checkout. `prose_baseline` and
`compiled_agent` are therefore reported as unavailable rather than simulated.
The bridge arm is not evidence that the repository contains a full compiled
workflow; it only tests the deterministic compile-like surface that exists.

## Metrics contract

Real local measurements include case pass/fail, deterministic command/helper
invocation count (reported as `turns`), recovery success for cases with a
defined legal follow-up, and wall-clock latency for those invocations. The
script reports model input/output tokens, cache splits, and cost as `null`
because no model or provider instrumentation is present. It does not infer
token counts from characters or claim cost/latency parity with an agent run.

The grader is state/transcript-first: a non-zero command alone is not enough;
the expected error class and unchanged protected state must also hold. A
recovery only counts when the tempting action was refused and its explicitly
defined legal next move succeeds.

# Skill behavior evaluation v1

`skill-behavior-v1.mjs` grades 24 fixed activation and contract scenarios for
Scout, Compass, Relay, and Cairn. The scenario oracle is separate from
candidate transcripts: runners receive the prompt, context, and all current
`SKILL.md` candidates, but never the expected target, selection, or assertions.
Positive Scout and Compass boundary cases also name an excluded competitor;
co-selecting both fails activation even when the target is present.

Validate the fixed suite without claiming agent behavior:

```sh
node evaluation/skill-behavior-v1.mjs --validate
```

Run it through an agent adapter:

```sh
node evaluation/skill-behavior-v1.mjs --runner /absolute/path/to/adapter
```

`SKILL_BEHAVIOR_RUNNER` may supply the executable instead. The evaluator starts
the executable directly, without a shell, once per scenario. It writes one JSON
request to stdin:

```json
{
  "protocol": "agent-skills/skill-behavior-v1",
  "scenario": {
    "id": "compass.open-architecture-direction",
    "prompt": "...",
    "context": {}
  },
  "skills": [
    {
      "name": "scout",
      "path": "scout/SKILL.md",
      "text": "..."
    },
    {
      "name": "compass",
      "path": "compass/SKILL.md",
      "text": "..."
    },
    {
      "name": "relay",
      "path": "relay/SKILL.md",
      "text": "..."
    },
    {
      "name": "cairn",
      "path": "cairn/SKILL.md",
      "text": "..."
    }
  ]
}
```

All candidate skills are present and the target skill is deliberately absent
from `scenario`; otherwise activation accuracy would leak its own oracle.

The adapter must return one JSON object on stdout with the matching `id`,
`selected_skills`, normalized `events`, a non-empty `final`, and optional
provider `metrics`. Event types and required fields are the observable contract
encoded by the grader: `ask`, `ledger`, `scout_sweep`, `advisor_review`,
`decision_brief`, `prototype`, `record`, `production_change`, `brief`,
`delegate`, `receipt`, `external_effect`, `state_update`, `repo_write`,
`live_refresh`, `resume_summary`, and `cleanup_offer`. The evaluator rejects
missing scenarios, duplicate transcripts, unknown skills, malformed output,
and incomplete transcript sets.

Normalized event fields:

| Event | Required evidence fields |
| --- | --- |
| `ask` | `native`, two or three `options`, zero-based `recommended`; Scout asks also carry `turn` |
| `ledger` | matching `turn` and exact `✓N decided · ● territory · ○ remaining` text |
| `scout_sweep` | ordered `territories[].{name,status,reason}` covering the fixed six-territory sweep |
| `advisor_review` | ordered `territory` border and bounded `bonus_turns` |
| `decision_brief` | numbered `decisions`, `spikes`, and non-empty `now`, `next`, `later` |
| `prototype` | `disposable`, `production_path`, `format`, `structurally_different`, `variants[].view` |
| `record` | `action`, absolute `location`, `exists`; resumed records also set `refreshed` |
| `production_change` | any attempted production implementation |
| `brief` | `objective`, `out_of_scope`, `authority`, `deliverable` |
| `delegate` | `parallel`, non-overlapping `lanes[].{owner,target,files}` |
| `receipt` | `synthesized`, `head`, matching `authoritative_head`, `head_source`, head-bound `checks[].{name,passed,head}` |
| `external_effect` | any merge, deploy, publish, migration, or destructive cleanup |
| `state_update` | proper `home` and `fields` preserved in the marker |
| `repo_write` | repository-relative `path` and `purpose` |
| `live_refresh` | `sources` checked against the marker |
| `resume_summary` | `sections` separating settled, open, and stale state |
| `cleanup_offer` | stray `path`, proper `destination`, `remove`, and `authorized` |

`head_source` is `pull_request_head`, `origin_main`, `tag_commit`, or
`local_head`; tracked review and release adapters must use the corresponding
repository-host source rather than a sandbox or synthetic merge head.

`metrics`, when available for every scenario, uses `input_tokens`,
`output_tokens`, and `total_cost_usd`. Missing provider instrumentation stays
`null`; the evaluator never estimates it.

Previously captured JSON arrays or JSONL can be graded without running an
agent:

```sh
node evaluation/skill-behavior-v1.mjs --transcripts /path/to/transcripts.json
```

Behavioral failures exit non-zero by default, matching the adversarial
evaluator. Add `--measure` for an autoresearch run that must report partial
scores with exit zero; `--strict` explicitly restores the default. Malformed
suite, runner, or transcript data always exits non-zero. Reported metrics are:

- `scenario_pass_rate`
- `activation_accuracy`
- `false_activation_rate`
- `contract_pass_rate`
- `scenarios_passed`
- provider-reported input tokens, output tokens, and cost, or `null`

The evaluator deterministically grades normalized evidence; it does not invent
model calls, infer token counts, or treat `--validate` as behavior evidence.
Adapter quality remains part of the measurement boundary: an adapter must map
real agent selections, tool calls, filesystem actions, and final output rather
than synthesize favorable events.

# Skill-behavior adapter (two-tier)

`evaluation/adapters/skill-behavior-cli.mjs` is the spawnable `--runner` for
live capture. It materializes evaluator-owned fixtures, prepends PATH wrappers
for `decision-shelf` and `delivery`, optionally invokes a real agent CLI, and
maps only observed evidence into the transcript. Missing evidence is omitted;
the adapter never synthesizes favorable events.

## Plumbing mode

When `SKILL_BEHAVIOR_AGENT_CMD` is unset, or `SKILL_BEHAVIOR_MODE=plumbing`, the
runner still builds fixtures/wrappers and returns a valid transcript with empty
`selected_skills` / `events`. That proves the IO contract; it is not a behavior
score.

```sh
SKILL_BEHAVIOR_MODE=plumbing \
node evaluation/skill-behavior-v1.mjs \
  --runner "$PWD/evaluation/adapters/skill-behavior-cli.mjs" \
  --measure
```

## Live capture

Point `SKILL_BEHAVIOR_AGENT_CMD` at an argv JSON array or shell command. The
adapter exposes:

- `SKILL_BEHAVIOR_SKILLS_DIR` — materialized candidate skills
- `SKILL_BEHAVIOR_CONTEXT_PATH` — scenario context JSON (never the oracle)
- `SKILL_BEHAVIOR_ANSWERS_PATH` — optional scripted answers
- `DECISION_SHELF_HOME` / `SKILL_BEHAVIOR_AUDIT_LOG` — wrapper-backed CLI evidence

### Prime Agent print bridge

`evaluation/adapters/prime-agent-print.mjs` launches `prime-agent -p` against
the materialized project. The run is hermetic on purpose: discovery is disabled
with `--no-skills`, `--no-extensions`, and `--no-context-files`, and only the
fixture's candidate skills load through explicit `--skill` paths. The operator's
installed skills therefore cannot contaminate a score.

```sh
SKILL_BEHAVIOR_AGENT_CMD="[\"node\",\"$PWD/evaluation/adapters/prime-agent-print.mjs\"]" \
SKILL_BEHAVIOR_TRANSCRIPT_DIR="$PWD/evaluation/transcripts/skill-behavior-v1/runs/prime-smoke" \
node evaluation/skill-behavior-v1.mjs \
  --runner "$PWD/evaluation/adapters/skill-behavior-cli.mjs" \
  --measure
```

Optional overrides: `SKILL_BEHAVIOR_PRIME_BIN` (default `prime-agent`),
`SKILL_BEHAVIOR_PRIME_THINKING` (default `low`), `SKILL_BEHAVIOR_PRIME_MODEL`,
and `SKILL_BEHAVIOR_PRIME_PROVIDER`.

Use an absolute adapter path. The bridge is spawned with the fixture project as
its working directory, so a repository-relative path in
`SKILL_BEHAVIOR_AGENT_CMD` does not resolve.

### OMP print bridge

`evaluation/adapters/omp-print-agent.mjs` launches `omp -p` against the
materialized project. Skills are copied into `.agents/skills/` for discovery.

```sh
SKILL_BEHAVIOR_AGENT_CMD="[\"node\",\"$PWD/evaluation/adapters/omp-print-agent.mjs\"]" \
SKILL_BEHAVIOR_OMP_MAX_TIME=3m \
SKILL_BEHAVIOR_TRANSCRIPT_DIR="$PWD/evaluation/transcripts/skill-behavior-v1/runs/omp-smoke" \
./behavior-autoresearch.sh
```

Agents should emit explicit selection markers when a skill is chosen:

```text
SKILL_BEHAVIOR_SELECTED: ["compass"]
```

Optional durable event lines may be emitted as JSON objects with a `type`
field, but CLI-backed claims (`record`, `prototype`, `receipt`) are accepted
only when the corresponding PATH wrapper audit exists.

```sh
SKILL_BEHAVIOR_AGENT_CMD='["your-agent","--skills-dir"]' \
SKILL_BEHAVIOR_TRANSCRIPT_DIR="$PWD/evaluation/transcripts/skill-behavior-v1/runs/manual" \
node evaluation/skill-behavior-v1.mjs \
  --runner "$PWD/evaluation/adapters/skill-behavior-cli.mjs" \
  --measure
```

## Offline score from recorded transcripts

```sh
node evaluation/skill-behavior-v1.mjs \
  --transcripts evaluation/transcripts/skill-behavior-v1/plumbing.jsonl
```

Promote only real capture outputs into `plumbing.jsonl`. An empty file means
no plumbing baseline has been recorded yet.
