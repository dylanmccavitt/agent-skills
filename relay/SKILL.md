---
name: relay
description: Dispatch bounded work — one task or several genuinely independent lanes — and return a compact reviewable receipt. Use when the user hands off a task, asks for parallel agents, or wants tracked issue-to-branch-to-PR delivery with clear evidence. Not for trivial edits completed faster directly.
---

# Relay

Take a brief, do the work, come back with a receipt worth reviewing.

## Brief

Before starting or dispatching, make the assignment concrete: one objective, what is out of scope, what authority it carries, and what the deliverable looks like. State it once, as one line the reviewer can audit:

```
{"type":"brief","objective":"...","out_of_scope":"...","authority":"...","deliverable":"..."}
```

Parallelize only genuinely independent lanes. Give each lane one owner and non-overlapping files, keep scouts and reviewers read-only, and use the harness's native isolation and orchestration — worktrees, branches, subagents, workflows — instead of inventing custody rules. Declare the dispatch once, before any lane starts:

```
{"type":"delegate","parallel":true,"lanes":[{"owner":"docs-agent","target":"API docs","files":["docs/api.html"]},{"owner":"cli-agent","target":"CLI help","files":["bin/help.mjs"]}]}
```

Every lane names an owner, a target, and at least one file. No owner and no file appears twice. Work you keep and run yourself is either no `delegate` line at all, or a single lane with `"parallel": false`.

## Deliver

Match checks to risk. `delivery receipt` discovers and runs the repository's documented checks and drafts the receipt from live state. Call `delivery` exactly once per task, at the final head: a second call splits the evidence across two states. For tracked delivery keep one issue to one PR — branching and isolation are the harness's job — and get independent review before calling the change ready. Evidence is bound to the exact head it was produced on; if the head moves, re-verify.

## Receipt

Return one receipt per task, shaped like [receipt.md](assets/receipt.md). `delivery receipt` drafts it from live state — head, diff, check results; fill in what only the author knows. The tool's own run is the record of that receipt, so never restate it as a JSON line. Synthesize parallel lanes into a single receipt — never paste agent transcripts.

External effects — merge, deploy, publish, migrate, destructive cleanup — stay with the user. A green check means ready, not authorized. When the work came from a `$compass` record, update that record's Bridge with the delivered head and receipt location.
