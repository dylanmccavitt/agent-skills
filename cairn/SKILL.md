---
name: cairn
description: Preserve and resume working context across sessions without leaving plan, handoff, or decision files inside the repository. Use when pausing substantial work, picking ongoing work back up, or when stray planning documents are accumulating in a repo.
---

# Cairn

Leave one durable marker where it belongs; never scatter context through the repo.

## Where state lives

Durable state goes where something already owns it: the tracker issue for scope and status, the PR description for change rationale, the decision shelf (`decision-shelf` CLI) for direction, commit messages for history, and the agent's own memory for personal working notes. A loose `plan.md`, `handoff.md`, or `notes.md` in the repository is never the answer. When you find such files, offer to fold each into its proper home and remove it.

## Pausing

Update the one right home with the current state, proof so far, open risks, and the exact next action — small enough to read in a minute. A handoff preserves state; it does not broaden scope or grant authority.

## Resuming

Read the marker, then refresh against live state — files, branches, PRs, checks — before acting. Separate what is settled, what is still open, and what has gone stale since the marker was written. Live state wins over the marker.
