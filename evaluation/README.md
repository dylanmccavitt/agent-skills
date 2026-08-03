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
