import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { skillNames, validateSkill } from "../scripts/validate-skills.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);

test("shipped skills satisfy discovery and reference contracts", () => {
  assert.deepEqual(skillNames, ["compass", "relay", "cairn"]);
  for (const name of skillNames) {
    assert.equal(validateSkill(root, name), true);
  }
});

test("skills stay lean guides, not rulebooks", () => {
  for (const name of skillNames) {
    const text = readFileSync(resolve(root, name, "SKILL.md"), "utf8");
    const words = text.split(/\s+/).filter(Boolean).length;
    assert.ok(words < 400, `${name}/SKILL.md has ${words} words; keep it under 400`);
    const prohibitions = (text.match(/\b(?:Do not|Never|Don't)\b/gi) || []).length;
    assert.ok(
      prohibitions <= 3,
      `${name}/SKILL.md has ${prohibitions} prohibitions; state intent instead`,
    );
  }
});

test("compass keeps the visual-first interactive decision loop", () => {
  const compass = readFileSync(resolve(root, "compass", "SKILL.md"), "utf8");
  assert.match(compass, /showing over telling/i);
  assert.match(compass, /disposable/i);
  assert.match(compass, /even when the decision isn't visual/i);
  assert.match(compass, /one question at a time/i);
  assert.match(compass, /request_user_input/);
  assert.match(compass, /decision-shelf/);
  assert.match(compass, /never as markdown files inside the repository/i);
  assert.match(compass, /Record: <absolute path>/);
  assert.match(compass, /Record: none/);
  assert.match(compass, /\$relay/);

  const record = readFileSync(
    resolve(root, "compass", "assets", "decision-record.html"),
    "utf8",
  );
  assert.match(record, /<article\s+data-status="exploring"/);
  assert.match(record, /Options and evidence/);
  assert.match(record, /<h2 id="bridge">Bridge<\/h2>/);
  assert.match(record, /data-repository=/);
  assert.match(record, /data-base-head=/);
});

test("relay keeps briefs bounded and receipts compact", () => {
  const relay = readFileSync(resolve(root, "relay", "SKILL.md"), "utf8");
  assert.match(relay, /one objective/i);
  assert.match(relay, /read-only/i);
  assert.match(relay, /receipt/i);
  assert.match(relay, /assets\/receipt\.md/);
  assert.match(relay, /green check means ready, not authorized/i);
  assert.match(relay, /head it was produced on/i);

  const receipt = readFileSync(resolve(root, "relay", "assets", "receipt.md"), "utf8");
  for (const field of ["Outcome", "Where", "Evidence", "Open questions", "Next action"]) {
    assert.match(receipt, new RegExp(field));
  }
});

test("cairn routes durable state to owned homes, not repo files", () => {
  const cairn = readFileSync(resolve(root, "cairn", "SKILL.md"), "utf8");
  assert.match(cairn, /tracker issue/i);
  assert.match(cairn, /PR description/i);
  assert.match(cairn, /decision shelf/i);
  assert.match(cairn, /never the answer/i);
  assert.match(cairn, /refresh against live state/i);
  assert.match(cairn, /Live state wins/i);
});

test("decision-shelf CLI creates, lists, and refuses duplicate records", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-test-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-repo-"));
  mkdirSync(join(workspace, "project"), { recursive: true });
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: join(workspace, "project"),
      env,
      encoding: "utf8",
    });

  const help = run(["help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /resume the matching record/i);
  assert.match(help.stdout, /exploring/);
  assert.match(help.stdout, /superseded/);

  const created = run(["new", "Pick a queue library"]);
  assert.equal(created.status, 0, created.stderr);
  const recordPath = created.stdout.trim();
  assert.match(recordPath, /pick-a-queue-library\.html$/);
  const record = readFileSync(recordPath, "utf8");
  assert.match(record, /Pick a queue library/);
  assert.match(record, /data-status="exploring"/);

  const duplicate = run(["new", "Pick a queue library"]);
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /resume it instead of duplicating/);

  const listed = run(["list"]);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /exploring/);
  assert.match(listed.stdout, /Pick a queue library/);

  const found = run(["find", "queue"]);
  assert.equal(found.status, 0, found.stderr);
  assert.match(found.stdout, /pick-a-queue-library\.html/);

  const second = run(["new", "Choose a cache strategy"]);
  assert.equal(second.status, 0, second.stderr);
  writeFileSync(
    recordPath,
    readFileSync(recordPath, "utf8")
      .replace('data-status="exploring"', 'data-status="superseded"')
      .replace(/data-updated="[^"]*"/, 'data-updated="2099-01-01"'),
  );
  const ordered = run(["list"]);
  assert.equal(ordered.status, 0, ordered.stderr);
  assert.ok(
    ordered.stdout.indexOf("Choose a cache strategy") <
      ordered.stdout.indexOf("Pick a queue library"),
    "superseded records list last even with a newer updated date",
  );
});

test("decision-shelf status, supersede, and --stale manage the record lifecycle", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-lifecycle-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-repo-"));
  mkdirSync(join(workspace, "project"), { recursive: true });
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: join(workspace, "project"),
      env,
      encoding: "utf8",
    });

  const first = run(["new", "Pick a storage engine"]).stdout.trim();
  const second = run(["new", "Revisit the storage engine"]).stdout.trim();

  // status updates the chip, data-status, and dates together.
  const selected = run(["status", "storage-engine", "selected"]);
  assert.notEqual(selected.status, 0, "ambiguous name must refuse, not guess");
  assert.match(selected.stderr, /matches several records/);
  const byPath = run(["status", first, "selected"]);
  assert.equal(byPath.status, 0, byPath.stderr);
  const afterStatus = readFileSync(first, "utf8");
  assert.match(afterStatus, /data-status="selected"/);
  assert.match(afterStatus, /<p class="status">selected<\/p>/);

  const invalid = run(["status", first, "shipped"]);
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /unknown status/);

  // superseded is only reachable through supersede, so a successor is linked.
  const blocked = run(["status", first, "superseded"]);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /supersede <old> <new>/);

  const superseded = run(["supersede", first, second]);
  assert.equal(superseded.status, 0, superseded.stderr);
  const afterSupersede = readFileSync(first, "utf8");
  assert.match(afterSupersede, /data-status="superseded"/);
  assert.match(afterSupersede, /<dt>Superseded by<\/dt>/);
  assert.ok(
    afterSupersede.includes("Revisit the storage engine"),
    "the successor link carries the successor's title",
  );
  const again = run(["supersede", first, second]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already superseded/);

  // A hand-mangled record is refused, not partially rewritten.
  const mangledPath = run(["new", "Choose a metrics stack"]).stdout.trim();
  const pristine = readFileSync(mangledPath, "utf8");
  writeFileSync(mangledPath, pristine.replace(/data-status="[^"]*"\s*/, ""));
  const mangled = run(["status", mangledPath, "selected"]);
  assert.notEqual(mangled.status, 0);
  assert.match(mangled.stderr, /missing expected structure/);
  writeFileSync(mangledPath, pristine);

  // --stale surfaces stalled and unlinked records, and only those.
  const freshStale = run(["list", "--stale"]);
  assert.equal(freshStale.status, 0, freshStale.stderr);
  assert.match(freshStale.stdout, /No stale records/);

  writeFileSync(
    mangledPath,
    readFileSync(mangledPath, "utf8").replace(
      /data-updated="[^"]*"/,
      'data-updated="2001-01-01"',
    ),
  );
  writeFileSync(
    second,
    readFileSync(second, "utf8").replace(
      'data-status="exploring"',
      'data-status="superseded"',
    ),
  );
  const stale = run(["list", "--stale"]);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /Choose a metrics stack/);
  assert.match(stale.stdout, /no update in \d+ days/);
  assert.match(stale.stdout, /superseded without a successor link/);
  assert.doesNotMatch(
    stale.stdout,
    /Pick a storage engine/,
    "superseded with a successor link is not stale",
  );
});
