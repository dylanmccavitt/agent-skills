# Compass, Relay, and Cairn

Three lean, harness-agnostic skills plus two CLIs. The skills are short
guides that state intent; the tooling carries the mechanics (interfaces over
instructions).

- `compass` settles a direction interactively — disposable visuals and
  prototypes, one decision-driving question at a time — and records the
  outcome on the external decision shelf.
- `relay` takes a bounded brief (one task or independent parallel lanes),
  does the work with the harness's native isolation, and returns one compact
  receipt.
- `cairn` preserves and resumes working context in homes that already own it
  (issue, PR, shelf, memory) instead of scattering plan and handoff files
  through the repository.
- `decision-shelf` is the CLI interface to the shelf: durable, agent-agnostic
  HTML decision records kept outside every repository. Its help text is the
  manual the skills defer to. `decision-shelf bridge` turns a record's
  acceptance criteria into a failing test scaffold, so implementation binds
  to an executable spec instead of prose.
- `delivery` carries relay's delivery mechanics: `delivery checks` discovers
  and runs a repository's documented checks, and `delivery receipt` drafts a
  receipt bound to the exact head. Branching and worktree isolation stay with
  git and the harness.

## Install

```sh
npx @dylanmccavitt/agent-skills@latest
```

The installer is cross-harness: one marker-backed bundle lives under
`~/.agents/orchestration-skills` (the canonical skills home), and package-managed
skill links are created in `~/.agents/skills`, `$CODEX_HOME/skills`, and
`~/.claude/skills` (override with `--agents-home`, `--codex-home`,
`--claude-home`, or the `AGENTS_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`
environment variables). A marker-backed bundle from an earlier Codex-only
install is migrated automatically.

Upgrading removes only package-owned legacy skill links (including the retired
v2 skills `teamwork`, `governed-delivery`, `prototype`, `decision-lab`, and
`deviling`) and exact package-owned hook entries. Unrelated skills and
ambiguous or unmanaged state are preserved or rejected rather than
overwritten.

Inspect or remove an installation:

```sh
npx @dylanmccavitt/agent-skills@latest doctor
npx @dylanmccavitt/agent-skills@latest uninstall
```

`doctor` also audits the installed skill inventory across every harness and
flags oversized guides (400+ words) as advisories — lean skills defer
mechanics to tools and references.

## Decision shelf

```sh
npm install --global @dylanmccavitt/agent-skills
decision-shelf help
```

Records live under `$DECISION_SHELF_HOME`, `$XDG_DATA_HOME/decision-shelf`, or
`~/.local/share/decision-shelf`, grouped per project by Git remote.

## Development

```sh
npm test
```

Runs the skill validator (frontmatter, references, agent metadata) and the
node test suite, which also enforces that skills stay lean guides: under 400
words and at most three prohibitions per `SKILL.md`.

## v3 migration

Version 3 is a breaking simplification: fewer, shorter skills that trust
model judgment, with mechanics moved into tool interfaces. The five v2 skills collapse into three:
`decision-lab` + `deviling` + `prototype` become `compass`, `teamwork` +
`governed-delivery` become `relay`, and the handoff guidance becomes `cairn`.
Decision records are unchanged HTML files managed through the `decision-shelf`
CLI. The v2 trajectory-evaluation harness (`skills-eval`, replay cases, and
dashboard) was removed with it.
