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
