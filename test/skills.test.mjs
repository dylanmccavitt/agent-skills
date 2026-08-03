import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import test from "node:test";

import {
  escapeHtml,
  mutateProjectRecord,
  sanitizeRepositoryIdentity,
  staleReason,
  writeFileInDirectory,
} from "../bin/decision-shelf.mjs";
import { skillNames, validateSkill } from "../scripts/validate-skills.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);

test("HTML and repository metadata helpers remove executable and secret-bearing syntax", () => {
  assert.equal(escapeHtml(`a <b> & "c" 'd'`), "a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39;");
  assert.equal(escapeHtml("plain"), "plain");
  assert.equal(
    sanitizeRepositoryIdentity(
      "https://release-user:TEST_SECRET_ONLY@example.invalid/org/repo.git?token=also-secret#private",
    ),
    "https://example.invalid/org/repo.git",
  );
  assert.equal(
    sanitizeRepositoryIdentity("git@example.invalid:org/repo.git"),
    "example.invalid:org/repo.git",
  );
  assert.equal(
    sanitizeRepositoryIdentity("file:///tmp/repo.git?token=TEST_SECRET_ONLY#private"),
    "file:///tmp/repo.git",
  );
  assert.equal(
    sanitizeRepositoryIdentity("https://user:TEST_SECRET_ONLY@bad host/repo.git"),
    "",
  );
  assert.equal(
    sanitizeRepositoryIdentity(
      "https://user:TEST_SECRET_ONLY@example.invalid:bad-port/org/repo.git",
    ),
    "",
  );
  assert.equal(
    sanitizeRepositoryIdentity(
      "user:TEST_SECRET_ONLY@second-user@example.invalid:org/repo.git",
    ),
    "",
  );
  assert.equal(
    sanitizeRepositoryIdentity(
      "https://good.example.invalid\\user:TEST_SECRET_ONLY@evil.example.invalid/repo.git",
    ),
    "",
  );
  assert.equal(sanitizeRepositoryIdentity("helper::TEST_SECRET_ONLY"), "");
});

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

test("decision-shelf new fills only CLI slots and leaves hand-edit placeholders intact", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-template-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-repo-"));
  mkdirSync(join(workspace, "project"), { recursive: true });
  const question = "Adopt titles for records";
  const created = spawnSync(process.execPath, [cli, "new", question], {
    cwd: join(workspace, "project"),
    env: { ...process.env, DECISION_SHELF_HOME: shelf },
    encoding: "utf8",
  });
  assert.equal(created.status, 0, created.stderr);
  const record = readFileSync(created.stdout.trim(), "utf8");

  // Every CLI-filled slot is substituted; no template token survives.
  assert.doesNotMatch(record, /\{\{[A-Z_]+\}\}/);
  assert.match(record, /<title>Decision: Adopt titles for records<\/title>/);
  assert.match(record, /<h1>Adopt titles for records<\/h1>/);
  assert.match(record, /<p>Adopt titles for records<\/p>/);
  const today = new Date().toISOString().slice(0, 10);
  assert.match(record, new RegExp(`data-updated="${today}"`));
  assert.match(record, new RegExp(`<dt>Updated</dt><dd>${today}</dd>`));

  // Hand-edit placeholders survive verbatim. Bare-string replacements once
  // bled the question into "TITLES OR NONE" (making "<question>S OR NONE"),
  // rewrote "NONE OR GIT SHA", and stamped today into the evidence table's
  // Verified cell.
  assert.match(record, /<dt>Issue candidates<\/dt><dd>TITLES OR NONE<\/dd>/);
  assert.match(record, /<dt>Delivered head<\/dt><dd>NONE OR GIT SHA<\/dd>/);
  assert.match(record, /<td>YYYY-MM-DD<\/td>/);
  assert.match(record, /<dt>Last verified<\/dt><dd>UNVERIFIED<\/dd>/);
  assert.doesNotMatch(record, /Adopt titles for recordsS/);
});

test("staleReason marks records stale on exactly day 30", () => {
  const now = new Date("2026-07-27T12:00:00Z");
  const record = { status: "exploring", updated: "2026-06-27", linked: false };
  assert.match(staleReason(record, now), /no update in 30 days/);
  assert.equal(staleReason({ ...record, updated: "2026-06-28" }, now), null);
});

test("hand-edited lifecycle states are refused or surfaced, never silently accepted", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-handedit-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-repo-"));
  mkdirSync(join(workspace, "project"), { recursive: true });
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: join(workspace, "project"),
      env,
      encoding: "utf8",
    });

  const first = run(["new", "Pick an auth provider"]).stdout.trim();
  const second = run(["new", "Revisit the auth provider"]).stdout.trim();
  assert.equal(run(["supersede", first, second]).status, 0);

  // superseded is terminal for `status`: reopening would strand the
  // successor link as stale metadata.
  const reopened = run(["status", first, "selected"]);
  assert.notEqual(reopened.status, 0);
  assert.match(reopened.stderr, /superseded — create a new record/);
  assert.match(readFileSync(first, "utf8"), /data-status="superseded"/);

  // A field label without a successor anchor is not a link: the record
  // stays visible as stale instead of silently passing.
  writeFileSync(
    second,
    readFileSync(second, "utf8")
      .replace('data-status="exploring"', 'data-status="superseded"')
      .replace("</dl>", "  <dt>Superseded by</dt><dd>lost to a hand edit</dd>\n      </dl>"),
  );
  const stale = run(["list", "--stale"]);
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /Revisit the auth provider/);
  assert.match(stale.stdout, /superseded without a successor link/);
  assert.doesNotMatch(
    stale.stdout,
    /Pick an auth provider/,
    "a real successor anchor keeps the record out of --stale",
  );

  // A record missing its visible Updated row is refused before mutation.
  const third = run(["new", "Choose a logging stack"]).stdout.trim();
  writeFileSync(
    third,
    readFileSync(third, "utf8").replace(/<dt>Updated<\/dt><dd>[^<]*<\/dd>\s*/, ""),
  );
  const refused = run(["status", third, "selected"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /missing expected structure/);
  assert.match(
    readFileSync(third, "utf8"),
    /data-status="exploring"/,
    "a refused record is not mutated",
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

test("supersede repairs a label-only successor field instead of refusing it", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-repair-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-repo-"));
  mkdirSync(join(workspace, "project"), { recursive: true });
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: join(workspace, "project"),
      env,
      encoding: "utf8",
    });

  const old = run(["new", "Choose a queue broker"]).stdout.trim();
  const successor = run(["new", "Queue broker second pass"]).stdout.trim();

  // Hand-edited malformed state: the label exists but carries no anchor —
  // exactly what list --stale reports as "superseded without a successor link".
  writeFileSync(
    old,
    readFileSync(old, "utf8")
      .replace('data-status="exploring"', 'data-status="superseded"')
      .replace("</dl>", "  <dt>Superseded by</dt><dd>see the other doc</dd>\n      </dl>"),
  );
  const staleBefore = run(["list", "--stale"]);
  assert.match(staleBefore.stdout, /superseded without a successor link/);

  const repaired = run(["supersede", old, successor]);
  assert.equal(repaired.status, 0, repaired.stderr);
  const text = readFileSync(old, "utf8");
  const rows = text.match(/<dt>Superseded by<\/dt>/g) || [];
  assert.equal(rows.length, 1, "repair replaces the malformed row, never duplicates it");
  assert.match(text, /<dt>Superseded by<\/dt><dd><a href="[^"]+">Queue broker second pass<\/a><\/dd>/);

  const staleAfter = run(["list", "--stale"]);
  assert.doesNotMatch(staleAfter.stdout, /superseded without a successor link/);

  // A genuinely linked record still refuses re-supersession.
  const again = run(["supersede", old, successor]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already superseded/);
});

test("supersede refuses a record whose header list is missing", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-headerless-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-repo-"));
  mkdirSync(join(workspace, "project"), { recursive: true });
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: join(workspace, "project"),
      env,
      encoding: "utf8",
    });

  const old = run(["new", "Pick a config format"]).stdout.trim();
  const successor = run(["new", "Config format second pass"]).stdout.trim();

  // Hand-edit removes the header list's closing tag while the Bridge's
  // list survives: a bare "</dl>" match would misplace the successor row
  // into the Bridge and still flip the status.
  const mangled = readFileSync(old, "utf8").replace("</dl>", "");
  writeFileSync(old, mangled);
  const refused = run(["supersede", old, successor]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /missing its header list/);
  assert.equal(readFileSync(old, "utf8"), mangled, "the record is left untouched");
  assert.doesNotMatch(readFileSync(old, "utf8"), /Superseded by/);
});

test("supersede refuses a Superseded by row misplaced outside the header", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-misplaced-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-repo-"));
  mkdirSync(join(workspace, "project"), { recursive: true });
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: join(workspace, "project"),
      env,
      encoding: "utf8",
    });

  const old = run(["new", "Pick a serializer"]).stdout.trim();
  const successor = run(["new", "Serializer second pass"]).stdout.trim();

  // A malformed row in the Bridge list, not the header: repairing it there
  // would leave the header without its successor while flipping the status.
  const mangled = readFileSync(old, "utf8").replace(
    "<dt>Prototype</dt>",
    "<dt>Superseded by</dt><dd>see elsewhere</dd>\n        <dt>Prototype</dt>",
  );
  writeFileSync(old, mangled);
  const refused = run(["supersede", old, successor]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /outside the record's header/);
  assert.equal(readFileSync(old, "utf8"), mangled, "the record is left untouched");

  // The misplaced anchor also never counts as linked for staleness.
  writeFileSync(
    old,
    mangled
      .replace('data-status="exploring"', 'data-status="superseded"')
      .replace("see elsewhere", '<a href="x.html">x</a>'),
  );
  const stale = run(["list", "--stale"]);
  assert.match(stale.stdout, /superseded without a successor link/);
});

test("status refuses a record whose header lost its Updated row to another list", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-dup-updated-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-repo-"));
  mkdirSync(join(workspace, "project"), { recursive: true });
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: join(workspace, "project"),
      env,
      encoding: "utf8",
    });

  const record = run(["new", "Pick a formatter"]).stdout.trim();
  // The header's Updated row is gone; an identical-looking row lives in the
  // Bridge. A global preflight would pass and mutate the wrong row.
  const mangled = readFileSync(record, "utf8")
    .replace(/<dt>Updated<\/dt><dd>[^<]*<\/dd>/, "")
    .replace("<dt>Prototype</dt>", "<dt>Updated</dt><dd>2001-01-01</dd>\n        <dt>Prototype</dt>");
  writeFileSync(record, mangled);
  const refused = run(["status", record, "selected"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /missing expected structure/);
  assert.equal(readFileSync(record, "utf8"), mangled, "the record is left untouched");
});

test("single-quoted successor anchors count as linked", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-quotes-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-repo-"));
  mkdirSync(join(workspace, "project"), { recursive: true });
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: join(workspace, "project"),
      env,
      encoding: "utf8",
    });

  const record = run(["new", "Pick a bundler"]).stdout.trim();
  const other = run(["new", "Bundler second pass"]).stdout.trim();
  writeFileSync(
    record,
    readFileSync(record, "utf8")
      .replace('data-status="exploring"', 'data-status="superseded"')
      .replace(
        "</dl>",
        "  <dt>Superseded by</dt><dd><a href='next.html'>next</a></dd>\n      </dl>",
      ),
  );
  const stale = run(["list", "--stale"]);
  assert.doesNotMatch(
    stale.stdout,
    /superseded without a successor link/,
    "a single-quoted anchor is a valid successor link",
  );
  const again = run(["supersede", record, other]);
  assert.notEqual(again.status, 0);
  assert.match(again.stderr, /already superseded/);
});

test("decision-shelf proto lanes live beside their record and settle with it", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-proto-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-repo-"));
  mkdirSync(join(workspace, "project"), { recursive: true });
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: join(workspace, "project"),
      env,
      encoding: "utf8",
    });

  // A lane cannot exist without a record.
  const orphan = run(["proto", "nothing-here", "new"]);
  assert.notEqual(orphan.status, 0);
  assert.match(orphan.stderr, /no record matching/);

  const record = run(["new", "Pick a pagination style"]).stdout.trim();
  const lane = record.replace(/\.html$/, ".proto");

  // new creates the lane beside the record, then variant stubs inside it.
  const bare = run(["proto", record, "new"]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.equal(bare.stdout.trim(), lane);
  assert.ok(
    existsSync(join(lane, ".decision-shelf-lane")),
    "creation writes the ownership marker",
  );
  const cursor = run(["proto", record, "new", "cursor-based"]);
  assert.equal(cursor.status, 0, cursor.stderr);
  assert.match(cursor.stdout, /cursor-based\/index\.html$/m);
  run(["proto", record, "new", "page-numbers"]);
  const duplicateVariant = run(["proto", record, "new", "cursor-based"]);
  assert.notEqual(duplicateVariant.status, 0);
  assert.match(duplicateVariant.stderr, /variant already exists/);

  // view prints one URL per variant.
  const view = run(["proto", record, "view"]);
  assert.equal(view.status, 0, view.stderr);
  assert.match(view.stdout, /cursor-based\s+file:\/\/.*cursor-based\/index\.html/);
  assert.match(view.stdout, /page-numbers\s+file:\/\/.*page-numbers\/index\.html/);

  // promote writes the Prototype field and an evidence row in one pass.
  const missing = run(["proto", record, "promote", "sidebar"]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /no variant "sidebar"/);
  const promoted = run(["proto", record, "promote", "cursor-based"]);
  assert.equal(promoted.status, 0, promoted.stderr);
  const afterPromote = readFileSync(record, "utf8");
  assert.match(afterPromote, /<dt>Prototype<\/dt><dd>\.\/[^<]*cursor-based\/<\/dd>/);
  assert.match(afterPromote, /<td>Prototype: cursor-based<\/td>/);
  assert.match(afterPromote, /Promoted surviving variant/);

  // A record missing the fields promotion touches is refused, not rewritten.
  const pristine = readFileSync(record, "utf8");
  writeFileSync(record, pristine.replace(/<dt>Prototype<\/dt><dd>[\s\S]*?<\/dd>/, ""));
  const refused = run(["proto", record, "promote", "cursor-based"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /missing expected structure/);
  writeFileSync(record, pristine.replace(/<dt>Updated<\/dt><dd>[^<]*<\/dd>/, ""));
  const refusedDate = run(["proto", record, "promote", "cursor-based"]);
  assert.notEqual(refusedDate.status, 0, "a missing visible Updated row is refused too");
  assert.match(refusedDate.stderr, /missing expected structure/);

  // Promotion targets the comparison section's table even when an earlier
  // hand-added table exists.
  writeFileSync(
    record,
    pristine.replace(
      '<h2 id="constraints">Constraints</h2>',
      '<h2 id="constraints">Constraints</h2>\n      <table><tbody><tr><td>unrelated</td></tr></tbody></table>',
    ),
  );
  const scoped = run(["proto", record, "promote", "page-numbers"]);
  assert.equal(scoped.status, 0, scoped.stderr);
  const scopedText = readFileSync(record, "utf8");
  assert.ok(
    scopedText.indexOf("Prototype: page-numbers") > scopedText.indexOf('id="comparison"'),
    "the evidence row lands in the comparison table",
  );
  assert.doesNotMatch(
    scopedText.slice(0, scopedText.indexOf('id="comparison"')),
    /Prototype: page-numbers/,
    "the earlier table gains nothing",
  );

  // Duplicate labels elsewhere never receive the promotion's mutations:
  // the Bridge Prototype and header Updated are patched in their own
  // sections while the decoys stay byte-identical.
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    record,
    pristine.replace(
      '<h2 id="constraints">Constraints</h2>',
      '<h2 id="constraints">Constraints</h2>\n      <dl><dt>Prototype</dt><dd>decoy</dd><dt>Updated</dt><dd>1999-01-01</dd></dl>',
    ),
  );
  const scopedFields = run(["proto", record, "promote", "page-numbers"]);
  assert.equal(scopedFields.status, 0, scopedFields.stderr);
  const fieldsText = readFileSync(record, "utf8");
  assert.match(fieldsText, /<dt>Prototype<\/dt><dd>decoy<\/dd>/);
  assert.match(fieldsText, /<dt>Updated<\/dt><dd>1999-01-01<\/dd>/);
  assert.match(fieldsText, /<dt>Prototype<\/dt><dd>\.\/[^<]*page-numbers\/<\/dd>/);
  assert.match(fieldsText, new RegExp(`<dt>Updated</dt><dd>${today}</dd>`));

  // A file or symlink at the variant path is not a promotable variant.
  writeFileSync(join(lane, "filey"), "not a directory\n");
  const fileVariant = run(["proto", record, "promote", "filey"]);
  assert.notEqual(fileVariant.status, 0);
  assert.match(fileVariant.stderr, /no variant "filey"/);
  symlinkSync(join(lane, "cursor-based"), join(lane, "linky"));
  const linkVariant = run(["proto", record, "promote", "linky"]);
  assert.notEqual(linkVariant.status, 0);
  assert.match(linkVariant.stderr, /no variant "linky"/);
  writeFileSync(record, pristine);

  // A settled record with a lane still present is stale; cleaning resolves it.
  const settled = run(["status", record, "selected"]);
  assert.equal(settled.status, 0, settled.stderr);
  const staleWithLane = run(["list", "--stale"]);
  assert.match(staleWithLane.stdout, /selected with a prototype lane still present/);

  const clean = run(["proto", record, "clean"]);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /removed .*\.proto \(2 variants\)/);
  assert.ok(!existsSync(lane), "the lane is gone");
  const quarantine = clean.stdout
    .split("\n")
    .find((line) => line.startsWith("recoverable quarantine:"))
    ?.slice("recoverable quarantine:".length)
    .trim();
  assert.ok(quarantine && existsSync(quarantine), "clean preserves a recoverable quarantine");
  assert.match(
    readFileSync(record, "utf8"),
    /<td>Prototype: cursor-based<\/td>/,
    "the record keeps the promoted outcome after clean",
  );
  const staleAfterClean = run(["list", "--stale"]);
  assert.match(staleAfterClean.stdout, /No stale records/);

  const nothingToClean = run(["proto", record, "clean"]);
  assert.notEqual(nothingToClean.status, 0);
  assert.match(nothingToClean.stderr, /no prototype lane to remove/);
});

test("proto refuses unmanaged and symlinked lane paths outright", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-ownership-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-repo-"));
  mkdirSync(join(workspace, "project"), { recursive: true });
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: join(workspace, "project"),
      env,
      encoding: "utf8",
    });

  // A pre-existing ordinary directory at the lane path is user data: the
  // filename alone is not ownership. Every action refuses; nothing is
  // adopted, written into, or deleted.
  const record = run(["new", "Choose an id scheme"]).stdout.trim();
  const lane = record.replace(/\.html$/, ".proto");
  mkdirSync(lane);
  writeFileSync(join(lane, "precious.txt"), "user data\n");
  for (const args of [["new", "variant-a"], ["view"], ["promote", "variant-a"], ["clean"]]) {
    const refused = run(["proto", record, ...args]);
    assert.notEqual(refused.status, 0, `proto ${args.join(" ")} must refuse an unmanaged directory`);
    assert.match(refused.stderr, /not created by proto/);
  }
  assert.equal(
    readFileSync(join(lane, "precious.txt"), "utf8"),
    "user data\n",
    "unmanaged directory contents are untouched",
  );

  // Unowned directories never drive lane staleness.
  run(["status", record, "selected"]);
  const stale = run(["list", "--stale"]);
  assert.doesNotMatch(stale.stdout, /prototype lane still present/);

  // A lane moved or copied from another record fails marker validation:
  // its marker names the original record, so nothing here owns it.
  const recordA = run(["new", "Choose a logger"]).stdout.trim();
  run(["proto", recordA, "new", "v1"]);
  const recordB = run(["new", "Choose a tracer"]).stdout.trim();
  const laneB = recordB.replace(/\.html$/, ".proto");
  renameSync(recordA.replace(/\.html$/, ".proto"), laneB);
  const moved = run(["proto", recordB, "clean"]);
  assert.notEqual(moved.status, 0);
  assert.match(moved.stderr, /not created by proto for this record/);
  assert.ok(
    existsSync(join(laneB, "v1", "index.html")),
    "the moved lane's contents are untouched",
  );

  // A symlinked lane path is refused before any traversal or write.
  const second = run(["new", "Choose a palette"]).stdout.trim();
  const target = mkdtempSync(join(tmpdir(), "decision-shelf-lane-target-"));
  symlinkSync(target, second.replace(/\.html$/, ".proto"));
  for (const args of [["new", "v1"], ["view"], ["clean"]]) {
    const refused = run(["proto", second, ...args]);
    assert.notEqual(refused.status, 0, `proto ${args.join(" ")} must refuse a symlinked lane`);
    assert.match(refused.stderr, /symlink/);
  }
  assert.deepEqual(readdirSync(target), [], "symlink target is never written or removed");
});

test("lane ownership is project-qualified, not basename-deep", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-crossproject-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-repos-"));
  const projectOne = join(workspace, "one");
  const projectTwo = join(workspace, "two");
  mkdirSync(projectOne, { recursive: true });
  mkdirSync(projectTwo, { recursive: true });
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const runIn = (cwd, args) =>
    spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });

  // Same question, same day, two projects: identical record basenames.
  const recordOne = runIn(projectOne, ["new", "Pick a store"]).stdout.trim();
  runIn(projectOne, ["proto", recordOne, "new", "v1"]);
  const recordTwo = runIn(projectTwo, ["new", "Pick a store"]).stdout.trim();
  assert.notEqual(recordOne, recordTwo);
  assert.ok(
    recordOne.endsWith(recordTwo.slice(recordTwo.lastIndexOf("/"))),
    "the two records share a basename",
  );

  // Moving project one's lane beside project two's record must not grant
  // ownership: the marker names the project-qualified record.
  renameSync(
    recordOne.replace(/\.html$/, ".proto"),
    recordTwo.replace(/\.html$/, ".proto"),
  );
  const moved = runIn(projectTwo, ["proto", recordTwo, "clean"]);
  assert.notEqual(moved.status, 0);
  assert.match(moved.stderr, /not created by proto for this record/);
  assert.ok(
    existsSync(join(recordTwo.replace(/\.html$/, ".proto"), "v1", "index.html")),
    "the moved lane's contents are untouched",
  );
});

test("mutation commands refuse absolute and symlink-escaped records outside the project shelf", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-containment-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-containment-repo-"));
  const outside = mkdtempSync(join(tmpdir(), "decision-shelf-outside-"));
  mkdirSync(join(workspace, "project"), { recursive: true });
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: join(workspace, "project"),
      env,
      encoding: "utf8",
    });

  const record = run(["new", "Contain this record"]).stdout.trim();
  assert.ok(existsSync(record));
  const projectDir = resolve(record, "..");
  const pristine = readFileSync(record, "utf8");

  const victim = join(outside, "victim.html");
  writeFileSync(victim, pristine);
  for (const args of [
    ["status", victim, "selected"],
    ["supersede", victim, record],
    ["supersede", record, victim],
    ["proto", victim, "new", "escape"],
    ["bridge", victim],
  ]) {
    const refused = run(args);
    assert.notEqual(refused.status, 0, `${args.join(" ")} must refuse an outside path`);
    assert.match(refused.stderr, /outside this project's shelf|must resolve under/i);
  }
  assert.equal(readFileSync(victim, "utf8"), pristine, "outside record is untouched");
  assert.deepEqual(
    readdirSync(outside).filter((name) => name !== "victim.html"),
    [],
    "no proto lane or sibling files appear outside the shelf",
  );

  const escapeLink = join(projectDir, "escape-link.html");
  symlinkSync(victim, escapeLink);
  for (const args of [
    ["status", escapeLink, "selected"],
    ["supersede", escapeLink, record],
    ["supersede", record, escapeLink],
    ["proto", escapeLink, "new", "via-link"],
    ["bridge", escapeLink],
  ]) {
    const refused = run(args);
    assert.notEqual(refused.status, 0, `${args.join(" ")} must refuse a symlink escape`);
    assert.match(refused.stderr, /regular HTML file|outside this project's shelf|symlink/i);
  }
  assert.equal(readFileSync(victim, "utf8"), pristine, "symlink target is untouched");
  assert.ok(!existsSync(escapeLink.replace(/\.html$/, ".proto")));

  const hardLink = join(projectDir, "hard-link.html");
  linkSync(victim, hardLink);
  const hardLinkRefused = run(["status", hardLink, "selected"]);
  assert.notEqual(hardLinkRefused.status, 0, "a hardlinked outside record must be refused");
  assert.match(hardLinkRefused.stderr, /regular HTML file on the project shelf/i);
  assert.equal(readFileSync(victim, "utf8"), pristine, "hardlink target is untouched");

  const allowed = run(["status", record, "selected"]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(readFileSync(record, "utf8"), /data-status="selected"/);
});

test("decision-shelf new refuses a symlinked project folder", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-project-link-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-project-link-repo-"));
  const target = mkdtempSync(join(tmpdir(), "decision-shelf-project-link-target-"));
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: workspace,
      env,
      encoding: "utf8",
    });

  const pathResult = run(["path"]);
  assert.equal(pathResult.status, 0, pathResult.stderr);
  const projectDir = pathResult.stdout
    .split("\n")
    .find((line) => line.startsWith("Project:"))
    ?.slice("Project:".length)
    .trim();
  assert.ok(projectDir);
  symlinkSync(target, projectDir);

  const refused = run(["new", "Do not follow the project link"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /project folder must be a real directory, not a symlink/);
  assert.deepEqual(readdirSync(target), [], "the symlink target stays untouched");
});

test("decision-shelf new revalidates the project folder immediately before write", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-project-swap-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-project-swap-repo-"));
  const swapContainer = mkdtempSync(join(tmpdir(), "decision-shelf-project-swap-outside-"));
  const fakeBin = mkdtempSync(join(tmpdir(), "decision-shelf-project-swap-bin-"));
  const marker = join(swapContainer, "swapped");
  const capturedProject = join(swapContainer, "captured-project");
  const baseEnv = { ...process.env, DECISION_SHELF_HOME: shelf };
  const pathResult = spawnSync(process.execPath, [cli, "path"], {
    cwd: workspace,
    env: baseEnv,
    encoding: "utf8",
  });
  assert.equal(pathResult.status, 0, pathResult.stderr);
  const projectRoot = pathResult.stdout
    .split("\n")
    .find((line) => line.startsWith("Project:"))
    ?.slice("Project:".length)
    .trim();
  assert.ok(projectRoot);

  const fakeGit = join(fakeBin, "git");
  writeFileSync(
    fakeGit,
    `#!/usr/bin/env node
const { existsSync, renameSync, symlinkSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (!existsSync(process.env.SWAP_MARKER) && existsSync(process.env.SWAP_PROJECT_ROOT)) {
  renameSync(process.env.SWAP_PROJECT_ROOT, process.env.SWAP_CAPTURED_ROOT);
  symlinkSync(process.env.SWAP_CAPTURED_ROOT, process.env.SWAP_PROJECT_ROOT, "dir");
  writeFileSync(process.env.SWAP_MARKER, "swapped\\n");
}
if (args[0] === "rev-parse" && args[1] === "--show-toplevel") console.log(process.cwd());
else if (args[0] === "rev-parse" && args[1] === "HEAD") console.log("1111111111111111111111111111111111111111");
`,
  );
  chmodSync(fakeGit, 0o755);

  const refused = spawnSync(process.execPath, [cli, "new", "Race-safe record"], {
    cwd: workspace,
    env: {
      ...baseEnv,
      PATH: `${fakeBin}${delimiter}${process.env.PATH}`,
      SWAP_MARKER: marker,
      SWAP_PROJECT_ROOT: projectRoot,
      SWAP_CAPTURED_ROOT: capturedProject,
    },
    encoding: "utf8",
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /project folder must be a real directory, not a symlink/);
  assert.ok(existsSync(marker), "the fake git process performed the directory swap");
  assert.deepEqual(
    readdirSync(capturedProject),
    [],
    "no decision record is written through the swapped project symlink",
  );
});

test("bound record creation cannot be redirected by a post-validation symlink swap", () => {
  const container = mkdtempSync(join(tmpdir(), "decision-shelf-bound-write-"));
  const preBindProject = join(container, "pre-bind-project");
  const preBindCaptured = join(container, "pre-bind-captured");
  const preBindTarget = join(container, "pre-bind-target");
  const projectRoot = join(container, "project");
  const capturedProject = join(container, "captured-project");
  const redirectTarget = join(container, "redirect-target");
  mkdirSync(preBindProject);
  mkdirSync(preBindTarget);
  mkdirSync(projectRoot);
  mkdirSync(redirectTarget);

  assert.throws(
    () =>
      writeFileInDirectory(
        preBindProject,
        lstatSync(preBindProject, { bigint: true }),
        "record.html",
        "refuse\n",
        (directory) => {
        renameSync(directory, preBindCaptured);
        symlinkSync(preBindTarget, directory, "dir");
        process.chdir(directory);
        },
      ),
    /project folder identity changed before record creation/,
  );
  assert.deepEqual(readdirSync(preBindTarget), [], "a replacement before binding is refused");

  writeFileInDirectory(
    projectRoot,
    lstatSync(projectRoot, { bigint: true }),
    "record.html",
    "bound\n",
    (directory) => {
      process.chdir(directory);
      renameSync(directory, capturedProject);
      symlinkSync(redirectTarget, directory, "dir");
    },
  );

  assert.equal(readFileSync(join(capturedProject, "record.html"), "utf8"), "bound\n");
  assert.deepEqual(
    readdirSync(redirectTarget),
    [],
    "the relative create stays bound to the validated directory instead of following the link",
  );
});

test("bound record mutation cannot be redirected after validation", () => {
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-bound-mutation-"));
  const project = "project";
  const projectRoot = join(shelf, project);
  const recordPath = join(projectRoot, "2026-08-03-record.html");
  const capturedRecord = join(projectRoot, "captured-record.html");
  const outside = mkdtempSync(join(tmpdir(), "decision-shelf-bound-mutation-outside-"));
  const victim = join(outside, "victim.html");
  mkdirSync(projectRoot);
  writeFileSync(recordPath, "before\n");
  writeFileSync(victim, "outside\n");

  mutateProjectRecord(shelf, project, recordPath, (text) => {
    assert.equal(text, "before\n");
    renameSync(recordPath, capturedRecord);
    symlinkSync(victim, recordPath);
    return "after\n";
  });

  assert.equal(readFileSync(capturedRecord, "utf8"), "after\n");
  assert.equal(readFileSync(victim, "utf8"), "outside\n");
});

test("proto promote escapes record-derived path markup", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-proto-path-escape-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-proto-path-repo-"));
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: workspace,
      env,
      encoding: "utf8",
    });

  const created = run(["new", "Escape prototype paths"]);
  assert.equal(created.status, 0, created.stderr);
  const record = created.stdout.trim();
  const hostile = join(
    resolve(record, ".."),
    `${basename(record, ".html")}-<img src=x onerror=alert(1)>.html`,
  );
  renameSync(record, hostile);
  const variant = run(["proto", hostile, "new", "safe"]);
  assert.equal(variant.status, 0, variant.stderr);
  const promoted = run(["proto", hostile, "promote", "safe"]);
  assert.equal(promoted.status, 0, promoted.stderr);

  const text = readFileSync(hostile, "utf8");
  assert.doesNotMatch(text, /<img src=x onerror=alert\(1\)>/);
  assert.match(text, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("decision-shelf refuses a project folder replaced by a symlink", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-project-root-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-project-root-repo-"));
  const outside = mkdtempSync(join(tmpdir(), "decision-shelf-project-root-outside-"));
  const cwd = join(workspace, "project");
  mkdirSync(cwd, { recursive: true });
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });

  const created = run(["new", "Protect the project root"]);
  assert.equal(created.status, 0, created.stderr);
  const record = created.stdout.trim();
  const projectRoot = resolve(record, "..");
  const outsideProject = join(outside, "captured-project");
  renameSync(projectRoot, outsideProject);
  symlinkSync(outsideProject, projectRoot, "dir");
  const outsideRecord = join(outsideProject, basename(record));
  const before = readFileSync(outsideRecord, "utf8");

  for (const args of [
    ["new", "Write through the project symlink"],
    ["status", record, "selected"],
  ]) {
    const refused = run(args);
    assert.notEqual(refused.status, 0, `${args.join(" ")} must refuse the symlinked root`);
    assert.match(refused.stderr, /project folder must be a real directory, not a symlink/);
  }
  assert.equal(readFileSync(outsideRecord, "utf8"), before);
  assert.equal(readdirSync(outsideProject).length, 1, "no record was created through the link");
});

test("decision-shelf new leaves an invalid shelf path untouched", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-preflight-repo-"));
  const container = mkdtempSync(join(tmpdir(), "decision-shelf-preflight-"));
  const shelf = join(container, "shelf-is-user-data");
  const cwd = join(workspace, "project");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(shelf, "preserve me\n");

  const refused = spawnSync(process.execPath, [cli, "new", "Do not mutate first"], {
    cwd,
    env: { ...process.env, DECISION_SHELF_HOME: shelf },
    encoding: "utf8",
  });
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /decision shelf must resolve to a directory/i);
  assert.equal(readFileSync(shelf, "utf8"), "preserve me\n");
  assert.deepEqual(readdirSync(container), ["shelf-is-user-data"]);
});

test("decision-shelf new escapes markup and omits remote credentials", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-escape-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-escape-repo-"));
  const git = (...args) =>
    spawnSync("git", args, { cwd: workspace, encoding: "utf8" });
  assert.equal(git("init", "--initial-branch=main").status, 0);
  assert.equal(
    git(
      "remote",
      "add",
      "origin",
      "https://release-user:TEST_SECRET_ONLY@example.invalid/org/repo.git?token=ALSO_SECRET",
    ).status,
    0,
  );

  const payload = '</h1><script>alert(1)</script><h1 x="evil">xss';
  const created = spawnSync(process.execPath, [cli, "new", payload], {
    cwd: workspace,
    env: { ...process.env, DECISION_SHELF_HOME: shelf },
    encoding: "utf8",
  });
  assert.equal(created.status, 0, created.stderr);
  const recordPath = created.stdout.trim();
  const record = readFileSync(recordPath, "utf8");

  assert.doesNotMatch(record, /<script\b/i);
  assert.match(record, /&lt;\/h1&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;&lt;h1/);
  assert.match(record, /&quot;/);
  assert.match(record, /https:\/\/example\.invalid\/org\/repo\.git/);
  assert.doesNotMatch(record, /TEST_SECRET_ONLY|ALSO_SECRET|release-user/);
  assert.doesNotMatch(recordPath, /TEST_SECRET_ONLY|ALSO_SECRET|release-user/);
  assert.doesNotMatch(created.stdout, /TEST_SECRET_ONLY|ALSO_SECRET|release-user/);
  assert.equal([...record.matchAll(/<h1>/g)].length, 1);
  assert.match(record, /data-status="exploring"/);

  assert.equal(
    git(
      "remote",
      "set-url",
      "origin",
      "file:///tmp/example.git?token=FILE_SECRET_ONLY#private",
    ).status,
    0,
  );
  const fileRemote = spawnSync(process.execPath, [cli, "new", "File remote metadata"], {
    cwd: workspace,
    env: { ...process.env, DECISION_SHELF_HOME: shelf },
    encoding: "utf8",
  });
  assert.equal(fileRemote.status, 0, fileRemote.stderr);
  const fileRemoteRecord = readFileSync(fileRemote.stdout.trim(), "utf8");
  assert.match(fileRemoteRecord, /file:\/\/\/tmp\/example\.git/);
  assert.doesNotMatch(fileRemoteRecord, /FILE_SECRET_ONLY|token=|#private/);
  assert.doesNotMatch(fileRemote.stdout, /FILE_SECRET_ONLY|token=|#private/);
});

test("supersede emits a safe file link even for a javascript-like record name", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-successor-url-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-successor-url-repo-"));
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: workspace,
      env,
      encoding: "utf8",
    });

  const old = run(["new", "Choose a renderer"]).stdout.trim();
  const successor = run(["new", "Renderer second pass"]).stdout.trim();
  const dangerous = join(
    resolve(successor, ".."),
    'javascript:" onclick="alert(1).html',
  );
  renameSync(successor, dangerous);
  writeFileSync(
    dangerous,
    readFileSync(dangerous, "utf8").replace(
      /<h1>[^<]*<\/h1>/,
      '<h1>Successor & "quoted"</h1>',
    ),
  );

  const superseded = run(["supersede", old, dangerous]);
  assert.equal(superseded.status, 0, superseded.stderr);
  const record = readFileSync(old, "utf8");
  const href = record.match(/<dt>Superseded by<\/dt><dd><a href="([^"]+)"/)?.[1];
  assert.ok(href);
  assert.match(href, /^\.\/javascript%3A%22%20onclick%3D%22/);
  assert.doesNotMatch(href, /^javascript:/i);
  assert.doesNotMatch(record, /href="[^"]*" onclick=/i);
  assert.match(record, />Successor &amp; &quot;quoted&quot;<\/a>/);
});

test("supersede does not double-escape a title created by decision-shelf new", () => {
  const cli = resolve(root, "bin", "decision-shelf.mjs");
  const shelf = mkdtempSync(join(tmpdir(), "decision-shelf-successor-entities-"));
  const workspace = mkdtempSync(join(tmpdir(), "decision-shelf-successor-entities-repo-"));
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [cli, ...args], {
      cwd: workspace,
      env,
      encoding: "utf8",
    });

  const oldRecord = run(["new", "Choose the original queue"]).stdout.trim();
  const newRecord = run(["new", 'Successor & "quoted"']).stdout.trim();
  const superseded = run(["supersede", oldRecord, newRecord]);
  assert.equal(superseded.status, 0, superseded.stderr);
  const record = readFileSync(oldRecord, "utf8");
  assert.match(record, />Successor &amp; &quot;quoted&quot;<\/a>/);
  assert.doesNotMatch(record, /&amp;amp;|&amp;quot;/);
});
