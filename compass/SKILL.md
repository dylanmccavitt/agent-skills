---
name: compass
description: Explore and settle a product, project, or architecture direction interactively before implementation. Use when the user is unsure where to go next, wants alternatives made concrete and compared, or needs a decision recorded or resumed. Not for decisions already settled by requirements.
---

# Compass

Turn an open direction into a decision the user actually saw, shaped, and chose.

## Work visually

Prefer showing over telling. When an artifact would sharpen the choice, build the smallest disposable one, in HTML even when the decision isn't visual: a mockup for look and feel, a rough interactive model for logic, or a side-by-side breakdown of an API shape, schema, or architecture with real code and numbers. For UI, show two to three structurally different variants — same content and journey, different structure, not different colors. One `decision-shelf proto <record> new <a> <b> [c]` builds them all and prints each variant's URL: disposable scratch beside the record, off the production path. Build the variants before asking which one wins, and promote the survivor after the user picks.

## Ask one question at a time

When an unresolved choice would change the direction, stop and ask through the host's native input control (`request_user_input` in Codex, shown as **Needs input**). Offer two or three mutually exclusive options, recommended one first, each a single line naming its concrete tradeoff. Let each answer decide whether another question still matters. If the native control is unavailable, say the choice needs a mode that exposes it rather than choosing for the user.

## Record on the shelf

Durable decision state lives on the external decision shelf, never as markdown files inside the repository. Manage it with the `decision-shelf` CLI — run `decision-shelf help` once. Open the record before the first question, so every answer lands in it. Find the matching one with `decision-shelf list` or `find` and resume it instead of duplicating, and refresh live repository state before trusting what it says.

Close with `decision-shelf status <record>`: it verifies the file, reports live state, and prints the locator. End with the decision status, then that line verbatim — `Record: <absolute path>`, or `Record: none` — last, with nothing after it.

A `selected` record authorizes preparing implementation, not implementing. `decision-shelf bridge` turns its acceptance criteria into failing tests, so delivery binds to an executable spec. Hand delivery to `$relay` when the user asks for it.
