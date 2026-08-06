# Skill-behavior fixtures

Evaluator-owned repositories, overlays, and shelf seeds used by
`evaluation/adapters/skill-behavior-cli.mjs`.

- `repositories/<name>/` — copied into each scenario project workspace
- `overlays/<scenario.id>/` — optional extra files layered onto that project
- `materialize.mjs` — re-exports the adapter materializer

These fixtures provide context only. They do not encode expected skill
selection or assertion oracles.
