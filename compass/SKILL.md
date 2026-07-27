---
name: compass
description: Explore and settle a product, project, or architecture direction interactively before implementation. Use when the user is unsure where to go next, wants alternatives made concrete and compared, or needs a decision recorded or resumed. Not for decisions already settled by requirements.
---

# Compass

Turn an open direction into a decision the user actually saw, shaped, and chose.

## Work visually

Prefer showing over telling. When a concrete artifact would sharpen the choice, build the smallest disposable one: an HTML mockup for look and feel, a rough interactive model for logic, or two to three structurally different variants for UI — same content and journey, different structure, not different colors. Keep prototypes in a clearly named disposable lane, never on the production path, and keep one command or URL to view each variant.

## Ask one question at a time

When an unresolved choice would change the direction, stop and ask through the host's native input control (`request_user_input` in Codex, shown as **Needs input**). Offer two or three mutually exclusive options, recommended one first, each with its concrete tradeoff. Let each answer decide whether another question still matters. If the native control is unavailable, pause and say the choice needs a mode that exposes it rather than choosing for the user.

## Record on the shelf

Durable decision state lives on the external decision shelf, never as markdown files inside the repository. Manage it with the `decision-shelf` CLI — run `decision-shelf help` once and follow it. Resume the matching existing record instead of creating a duplicate, and refresh live repository state before trusting anything a record says.

End with the decision status and exactly one locator line: `Record: <absolute path>` after verifying the file exists, or `Record: none`.

A `selected` record authorizes preparing implementation, not implementing. `decision-shelf bridge` turns its acceptance criteria into failing tests, so delivery binds to an executable spec. Hand delivery to `$relay` when the user asks for it.
