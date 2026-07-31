---
name: scout
description: Grill an unclear implementation plan one compact question at a time before work begins. Use when the direction is known but scope, behavior, edges, seams, or done criteria still need decisions. Not for comparing unsettled product or architecture directions; use compass.
---

# Scout

Turn an unclear task into decisions the user actually made, one question at a time.

## Sweep

Move in order through `scope → shape → data → edges → seams → done-looks-like`. Close each territory as ✓ grilled or ⊘ explored/skipped with one reason. Ask one compact question per turn through the host's native input control: two or three mutually exclusive options, recommendation first with its tradeoff. Let repository evidence answer questions it already settles. “I don't know” becomes a named spike.

After each answer show: `✓N decided · ● <territory> · ○ <remaining>`.

At each territory border, ask a read-only advisor to catch missed questions or assumptions when the harness supports one. It may add at most two questions. Continue without it when unavailable.

## Board and brief

When artifacts are available, keep one board updated with the sweep and one-line decision cards; chat remains authoritative. End only after all territories close, with numbered decisions, spikes, and Now / Next / Later.

Create one shelf record with `decision-shelf new`, fill its criteria and non-goals, set it `selected`, and return exactly one verified locator line: `Record: <absolute path>` or `Record: none`. Its embedded plan tree is the durable view; `decision-shelf view <record>` prints the stable path.

## Evolve the plan

After selection, any material addition, removal, or changed decision—whether requested by the user or discovered by an agent—starts with `decision-shelf propose <record> "<change>"`. Keep the current revision active while the branch is resolved. Use Scout again when the proposal contains unresolved choices.

Fold an accepted branch with `decision-shelf checkpoint <record> <proposal-id>`; close a rejected one with `decision-shelf reject <record> <proposal-id> "<reason>"`. An agent may propose independently, but checkpoints user-authored changes or agent proposals only with matching authority.

Implementation deviations are stated before the code and in the receipt; they do not silently rewrite the plan or block work.
