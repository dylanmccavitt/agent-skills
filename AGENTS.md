# Repository Instructions

## Exact-head delivery

- Bind implementation checks, review, merge authorization, tags, and release evidence to the exact current head.
- Resolve the authoritative head from repository-host state: use the pull request `headRefOid` (or `refs/pull/<number>/head`) for PR review, fetched `origin/main` for main, and the dereferenced tag commit for releases.
- Do not treat a review sandbox's local `HEAD`, synthetic merge ref, or unpushed ephemeral commit as the pull-request head.
- Report an exact-head mismatch only when the evidence SHA differs from the authoritative repository-host SHA; cite both SHAs in the finding.
- Invalidate head-specific proof whenever the branch or pull-request head moves.
- Require the release tag to match both `package.json` and the exact current `main` head.

## Non-destructive installation

- Replace or remove only marker-backed, package-owned install roots, skill links, and exact historical hook entries.
- Reject symlinked, malformed, unmanaged, or ambiguous ownership before mutation.
- Preserve unrelated skills, customized hooks, and user configuration.
- Preflight failure-prone reads before mutation and prove rollback or no-mutation behavior with tests.

## Review findings

- For each finding, record whether it was fixed, rejected, deferred, or blocked.
- Re-run relevant checks after fixes and request fresh exact-head review.
- Do not resolve review threads without explicit authorization.

## Improvement loop

- Run `npm run gate` before and after any skill change. It runs skill validation, unit tests, the adversarial suite, and the skill-behavior suite, then writes `evaluation/reports/latest-<mode>.json`.
- Treat `evaluation/reports/baseline.json` as the record of proven behavior. The gate exits non-zero when a guarded metric regresses.
- Record a new baseline with `npm run gate:accept` only after a deliberate improvement. State the metric delta in the commit message.
- Score against a real agent with `npm run gate:live`. It uses `evaluation/adapters/prime-agent-print.mjs`, disables skill discovery, and loads only the fixture skills, so installed skills cannot contaminate the result.
- A live run costs model tokens and is not deterministic. Read a one-scenario delta as noise. Confirm a live improvement over at least two runs before recording a baseline.
- The agent command must be absolute. The adapter runs with its working directory set to a throw-away fixture project, so a relative path fails silently into plumbing-shaped results.
- Dispatch fixes with `node scripts/fanout.mjs`. It converts the latest report into one self-contained brief per failing skill, or per scenario with `--by scenario`.
- Fix the skill guidance or the CLI. Never edit the evaluator or a scenario to make a case pass.
- Keep repository conventions in this file. Keep agent-scoped lessons in the harness.
