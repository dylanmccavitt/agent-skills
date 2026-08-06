---
name: scout
description: Grill-style upfront planning session — interrogate an unclear task one compact question at a time across a fixed sweep, ending in a compact decision brief. Use it when the user names Scout, asks to be grilled on a plan, or wants kinks and decisions worked out before implementation; an explicit request starts the session at once. Otherwise offer it in one line.
---

# Scout

Turn an unclear task into decisions the user actually made.

## Session protocol

- Fixed sweep, in order: `scope → shape → data → edges → seams → done-looks-like`. A territory closes ✓ grilled or ⊘ skipped with a one-line reason; the session ends only when all six are closed.
- One question per turn: ≤2 lines, 2–3 mutually exclusive options, recommendation first with its tradeoff, asked through the host's native input control.
- Explore instead of asking when the codebase answers it.
- After every answer print the ledger, then the decision as one line:
  `✓N decided · ● <territory> · ○ <remaining>`
- "I don't know" never stalls: it becomes a named spike in the brief.

## Advisor

At each territory border, a subagent reviews for missed questions and wrong assumptions. It may inject at most 2 bonus turns (marked `[advisor]`) or clear the border silently.

## Session trace

Hosts read the session as JSONL. Print each beat as one unindented line:

- each turn, the ask then its ledger: `{"type":"ledger","turn":1,"text":"✓1 decided · ● scope · ○ shape, data, edges, seams, done-looks-like"}`
- each border, in sweep order: `{"type":"advisor_review","territory":"scope","bonus_turns":0}`
- at the end, sweep (all six, in order) then brief: `{"type":"scout_sweep","territories":[{"name":"scope","status":"grilled"},{"name":"shape","status":"skipped","reason":"settled earlier"}]}` then `{"type":"decision_brief","decisions":["..."],"spikes":["..."],"now":"...","next":"...","later":"..."}`

Where artifacts exist, the same beats drive one board.

## Exit brief

Fixed shape, compact: numbered decisions (one line each) · spikes · Now / Next / Later. Deliver it in chat and on the board, then record it once: `decision-shelf new "<question>" --status selected` fills the record and set status `selected` in one call. End with `Record: <absolute path>` as the last line.

## Evolve the plan

After selection, a material change starts with `decision-shelf propose`; the current revision stays active until `checkpoint` folds it or `reject` closes it, and checkpointing needs matching authority.

## Soft enforcement

Implementation that deviates from a scouted decision says so in one line before the code — then proceeds. No gates, no freeze, no check commands.
