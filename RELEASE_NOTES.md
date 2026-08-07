# v1.2.0 — Scout ownership and behavior evaluation

Scout becomes a package-owned skill, and the repository gains a measured
improvement loop that scores the skills against a real agent.

## Scout

- Scout is now the fourth package-owned skill alongside Compass, Relay, and
  Cairn. Fresh installs link it into every supported harness, and marker-owned
  three-skill installations gain it on upgrade.
- Existing unmanaged Scout entries are refused rather than adopted or
  overwritten. Preserve any customization and relocate that copy before
  installing the package-managed skill.
- Scout documents its plan-tree handoff: after a decision is selected, material
  changes move through `decision-shelf propose`, `checkpoint`, and `reject`.

## Improvement loop

- `npm run gate` runs skill validation, unit tests, the adversarial suite, and
  the skill-behavior suite, then writes a report and fails when a guarded metric
  regresses against `evaluation/reports/baseline.json`.
- `npm run gate:live` scores the skills against a real agent with skill
  discovery disabled, so installed skills cannot contaminate a result.
- The behavior evaluator covers 24 balanced scenarios across all four skills and
  rejects Scout/Compass co-selection in their boundary cases.
- `scripts/fanout.mjs` turns a report into one self-contained brief per failing
  skill or scenario.

## Evidence integrity

- Durable `record` and `prototype` events are read only from `decision-shelf`
  audit records. A declared file location can no longer stand in for a record
  that was never created.
- Audits name the exact record they touched, prototype lanes are never mistaken
  for durable records, and an audit that cannot be attributed to one record
  drops its event instead of guessing.
- `--only` is validated against the real stage names, and a run that executed no
  stage fails. An empty or misspelled selection previously skipped every check
  and still exited 0.
- `--accept` writes a baseline only when the run proved something: every stage
  passed, no guarded metric regressed, and the run was not partial. A baseline
  marked stale is reported but not guarded, so it can be replaced.
- Evaluation fixtures are removed on success and retained when the agent failed,
  so a failed run stays reconstructable.

## Fixes

- `decision-shelf` resolves project identity from inside a bare repository.
  Working under `objects/` or `refs/` previously derived a local path identity
  instead of the repository one. The repository probe is also stricter: it
  requires `config` beside `HEAD`, `objects`, and `refs`, and requires `HEAD` to
  hold a symref or object id.

# v1.1.0 — Decision record lifecycle and prototype lanes

`decision-shelf` gains a full record lifecycle and disposable prototype lanes.
Records now carry their state explicitly instead of leaving it in prose, and
exploration artifacts live beside the record that owns them rather than in the
repository.

## Record lifecycle

- `status <record> <status>` sets `exploring`, `selected`, or `rejected`,
  updating the chip, `data-status`, and updated date in one write.
- `supersede <old> <new>` marks a record superseded and links its successor;
  it is the only way to reach the `superseded` status.
- `list --stale` surfaces records needing attention: exploring or selected with
  no update in 30 days, superseded without a successor link, or settled with a
  prototype lane still present.
- Hand-edited lifecycle states are refused or surfaced rather than silently
  accepted, so a record's status always matches its markup.

## Prototype lanes

- `proto <record> new [variant]` creates a disposable lane beside the record,
  `view` prints one URL or path per variant, `promote <variant>` records the
  surviving variant in the record's Prototype field and evidence table, and
  `clean` removes the lane while the record keeps the outcome.
- Lanes are record-owned and project-qualified; unmanaged and symlinked lane
  paths are refused outright.

## Fixes

- Lifecycle preflights are scoped to the record header, so an `Updated` or
  `Superseded by` row elsewhere in the document no longer satisfies or blocks
  a write.
- Stray-path and gitlink scans are NUL-delimited and recurse into submodules,
  so paths containing whitespace are handled correctly.
- `supersede` repairs a label-only successor field instead of refusing it, and
  accepts single-quoted successor anchors as linked.
- CLI-filled record slots use delimited tokens, so hand-edit placeholders are
  left intact.

## Packaging

- `bin/delivery.mjs` is executable in the published tarball, matching the other
  bins. npm already set this bit at install time, so installed consumers were
  unaffected; this only matters when running the file directly from a clone.

## About

`@dylanmccavitt/agent-skills` ships Scout, Compass, Relay, and Cairn plus the
`decision-shelf` and `delivery` CLIs. It continues from `@dylanmccavitt/skills`,
retired at v3.1.1; installs written by the old package are recognized as
package-owned and upgrade in place.

<!-- runner health probe: do not merge -->
