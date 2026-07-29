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

`@dylanmccavitt/agent-skills` ships Compass, Relay, and Cairn plus the
`decision-shelf` and `delivery` CLIs. It continues from `@dylanmccavitt/skills`,
retired at v3.1.1; installs written by the old package are recognized as
package-owned and upgrade in place.
