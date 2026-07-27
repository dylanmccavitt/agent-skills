import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildReceipt,
  discoverChecks,
  runChecks,
  stateFingerprint,
  strayContextFiles,
} from "../bin/delivery.mjs";
import {
  extractBridgeCriteria,
  scaffoldBridgeTests,
} from "../bin/decision-shelf.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const deliveryCli = resolve(root, "bin", "delivery.mjs");
const shelfCli = resolve(root, "bin", "decision-shelf.mjs");

function temporaryDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function gitRepo() {
  const repo = temporaryDir("delivery-repo-");
  const git = (...args) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "seed\n");
  git("add", ".");
  git("commit", "-m", "seed");
  return { repo, git };
}

test("delivery help is the manual", () => {
  const result = spawnSync(process.execPath, [deliveryCli, "help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /checks/);
  assert.match(result.stdout, /receipt/);
  assert.doesNotMatch(result.stdout, /lane/);
  assert.match(result.stdout, /green check means ready, not authorized/i);
});

test("checks are discovered from documented sources, not configured", () => {
  const project = temporaryDir("delivery-checks-");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      scripts: {
        test: "node -e \"process.exit(0)\"",
        lint: "node -e \"process.exit(1)\"",
        deploy: "echo never-a-check",
      },
    }),
  );
  writeFileSync(join(project, "Makefile"), "check:\n\ttrue\n");
  const labels = discoverChecks(project).map((check) => check.label);
  assert.deepEqual(labels, ["npm test", "npm run lint", "make check"]);
});

test("npm placeholder test script is not a documented check", () => {
  const project = temporaryDir("delivery-placeholder-");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
    }),
  );
  assert.deepEqual(discoverChecks(project), []);
});

test("checks report pass and fail honestly", () => {
  const project = temporaryDir("delivery-run-");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({
      scripts: {
        test: "node -e \"process.exit(0)\"",
        lint: "node -e \"console.error('boom'); process.exit(1)\"",
      },
    }),
  );
  const results = runChecks(project);
  assert.deepEqual(
    results.map((result) => [result.label, result.status]),
    [
      ["npm test", "pass"],
      ["npm run lint", "fail"],
    ],
  );
  assert.match(results[1].output, /boom/);

  const cli = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /pass\s+npm test/);
  assert.match(cli.stdout, /fail\s+npm run lint/);
});

test("checks flag stray context files as advisories without failing the gate", () => {
  const { repo, git } = gitRepo();
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  writeFileSync(join(repo, "plan.md"), "stray\n");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "HANDOFF.md"), "stray, any case, any depth\n");
  writeFileSync(join(repo, "architecture.md"), "not a stray context name\n");
  git("add", ".");
  git("commit", "-m", "add checks and strays");

  const cli = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.match(cli.stdout, /advisory: stray context file plan\.md/);
  assert.match(cli.stdout, /advisory: stray context file docs\/HANDOFF\.md/);
  assert.doesNotMatch(cli.stdout, /architecture\.md/);

  // Untracked strays count too; ignored files are the author's business.
  writeFileSync(join(repo, "notes.md"), "untracked stray\n");
  writeFileSync(join(repo, ".gitignore"), "notes.md\n");
  assert.deepEqual(strayContextFiles(repo), ["docs/HANDOFF.md", "plan.md"]);

  // The scan is repository-wide from any depth, not a cwd subtree.
  assert.deepEqual(strayContextFiles(join(repo, "docs")), ["docs/HANDOFF.md", "plan.md"]);
});

test("a repo without documented checks fails the checks gate", () => {
  const project = temporaryDir("delivery-none-");
  const cli = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stdout, /No documented checks discovered/);

  // Stray-context advisories do not depend on check discovery.
  const { repo, git } = gitRepo();
  writeFileSync(join(repo, "plan.md"), "stray\n");
  git("add", ".");
  git("commit", "-m", "stray without checks");
  const stray = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(stray.status, 1);
  assert.match(stray.stdout, /No documented checks discovered/);
  assert.match(stray.stdout, /advisory: stray context file plan\.md/);
});

test("passing checks without a git head still fail the gate", () => {
  const project = temporaryDir("delivery-headless-");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ scripts: { test: "node -e \"process.exit(0)\"" } }),
  );
  const cli = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: project,
    encoding: "utf8",
  });
  assert.equal(cli.status, 1, "unbound evidence must not exit clean");
  assert.match(cli.stdout, /pass\s+npm test/);
  assert.match(cli.stdout, /BLOCKED: not inside a git repository/);
});

test("a check setting invisible index flags invalidates the evidence", () => {
  const { repo, git } = gitRepo();
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "git update-index --skip-worktree package.json" },
    }),
  );
  git("add", ".");
  git("commit", "-m", "add flag-setting check");

  const cli = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.notEqual(cli.status, 0, "an index-flag mutation must not pass the gate");
  assert.match(cli.stdout, /INVALIDATED: the checks changed the git index/);

  git("update-index", "--no-skip-worktree", "package.json");
  const receipt = buildReceipt(repo);
  assert.match(receipt, /INVALIDATED: the checks changed the git index/);
});

test("a check setting index flags inside a submodule invalidates the evidence", () => {
  const sub = gitRepo();
  writeFileSync(join(sub.repo, "lib.txt"), "v1\n");
  sub.git("add", ".");
  sub.git("commit", "-m", "lib");

  const superRepo = gitRepo();
  execFileSync(
    "git",
    ["-c", "protocol.file.allow=always", "submodule", "add", sub.repo, "sm"],
    { cwd: superRepo.repo, encoding: "utf8" },
  );
  writeFileSync(
    join(superRepo.repo, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "git -C sm update-index --skip-worktree lib.txt" },
    }),
  );
  superRepo.git("add", ".");
  superRepo.git("commit", "-m", "add flag-setting submodule check");

  const cli = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: superRepo.repo,
    encoding: "utf8",
  });
  assert.notEqual(cli.status, 0, "a submodule index-flag mutation must not pass");
  assert.match(cli.stdout, /INVALIDATED: the checks changed the git index/);
});

test("a bare gitlink without .gitmodules is still fingerprinted", () => {
  const superRepo = gitRepo();
  const nested = join(superRepo.repo, "nested");
  mkdirSync(nested);
  const nestedGit = (...args) =>
    execFileSync("git", args, { cwd: nested, encoding: "utf8" }).trim();
  nestedGit("init", "--initial-branch=main");
  nestedGit("config", "user.email", "test@example.com");
  nestedGit("config", "user.name", "Test");
  writeFileSync(join(nested, "lib.txt"), "v1\n");
  nestedGit("add", ".");
  nestedGit("commit", "-m", "lib");

  writeFileSync(
    join(superRepo.repo, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "git -C nested update-index --skip-worktree lib.txt" },
    }),
  );
  // A plain `git add` records the embedded repo as a gitlink with no
  // .gitmodules entry.
  execFileSync("git", ["add", "."], { cwd: superRepo.repo, encoding: "utf8" });
  superRepo.git("commit", "-m", "embed nested repo");

  const cli = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: superRepo.repo,
    encoding: "utf8",
  });
  assert.notEqual(cli.status, 0, "a bare-gitlink index mutation must not pass");
  assert.match(cli.stdout, /INVALIDATED: the checks changed the git index/);
});

test("a check that dirties only the index invalidates the evidence", () => {
  const { repo, git } = gitRepo();
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "git update-index --chmod=+x package.json" },
    }),
  );
  git("add", ".");
  git("commit", "-m", "add index-dirtying check");

  const cli = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.notEqual(cli.status, 0, "an index mutation must not pass the gate");
  assert.match(cli.stdout, /INVALIDATED: the checks changed the git index/);

  git("reset", "--hard", "HEAD");
  const receipt = buildReceipt(repo);
  assert.match(receipt, /INVALIDATED: the checks changed the git index/);
});

test("a failing git status blocks the gate instead of reading as clean", () => {
  const { repo, git } = gitRepo();
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node -e ''" } }),
  );
  git("add", ".");
  git("commit", "-m", "add passing check");
  writeFileSync(join(repo, "README.md"), "uncommitted change\n");
  // An invalid status-specific setting makes git status fail while
  // rev-parse and the scratch-index fingerprint still work.
  git("config", "status.showUntrackedFiles", "bogus");

  const cli = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(cli.status, 1, "unknown worktree state must not exit clean");
  assert.match(cli.stdout, /BLOCKED: git state could not be read/);

  const receipt = buildReceipt(repo, { checks: false });
  assert.match(receipt, /git status failed, worktree state unknown/);
  assert.doesNotMatch(receipt, /DIRTY working tree/);
});

test("passing checks in a dirty worktree still fail the gate", () => {
  const { repo, git } = gitRepo();
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node -e ''" } }),
  );
  git("add", ".");
  git("commit", "-m", "add passing check");
  writeFileSync(join(repo, "README.md"), "uncommitted change\n");

  const cli = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.equal(cli.status, 1, "dirty-tree evidence must not exit clean");
  assert.match(cli.stdout, /pass\s+npm test/);
  assert.match(cli.stdout, /BLOCKED: at head .* DIRTY working tree/);
});

test("receipt binds evidence to the exact head and flags dirty trees", () => {
  const { repo, git } = gitRepo();
  const head = git("rev-parse", "HEAD");
  const clean = buildReceipt(repo, { checks: false });
  assert.match(clean, /# Receipt: TASK/);
  assert.match(clean, new RegExp(`at head ${head}`));
  assert.match(clean, /branch `main`/);
  assert.doesNotMatch(clean, /DIRTY/);

  writeFileSync(join(repo, "README.md"), "changed\n");
  const dirty = buildReceipt(repo, { checks: false });
  assert.match(dirty, /DIRTY working tree — evidence is not bound to a committed head/);
});

test("receipt shows the diff against the base branch", () => {
  const { repo, git } = gitRepo();
  git("checkout", "-b", "feature");
  writeFileSync(join(repo, "feature.txt"), "new\n");
  git("add", ".");
  git("commit", "-m", "feature work");
  const receipt = buildReceipt(repo, { checks: false });
  assert.match(receipt, /branch `feature` — vs main: feature.txt/);
});

test("an unbuildable fingerprint fails closed as blocked, never validates", () => {
  const { repo, git } = gitRepo();
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node -e ''" } }),
  );
  git("add", ".");
  git("commit", "-m", "add passing check");
  // A required clean filter that always fails makes scratch-index staging
  // impossible without breaking ordinary git reads.
  git("config", "filter.broken.clean", "false");
  git("config", "filter.broken.required", "true");
  writeFileSync(join(repo, ".gitattributes"), "*.dat filter=broken\n");
  writeFileSync(join(repo, "blob.dat"), "unstageable\n");
  assert.equal(stateFingerprint(repo), null);

  const cli = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.notEqual(cli.status, 0, "blocked evidence must not exit clean");
  assert.match(cli.stdout, /BLOCKED: repository state could not be fingerprinted/);

  const receipt = buildReceipt(repo);
  assert.match(receipt, /BLOCKED: repository state could not be fingerprinted/);
  assert.doesNotMatch(receipt, /INVALIDATED/);
});

test("fingerprint sees dirty contents inside submodules", () => {
  const sub = gitRepo();
  writeFileSync(join(sub.repo, "lib.txt"), "v1\n");
  sub.git("add", ".");
  sub.git("commit", "-m", "lib");

  const superRepo = gitRepo();
  execFileSync(
    "git",
    ["-c", "protocol.file.allow=always", "submodule", "add", sub.repo, "sm"],
    { cwd: superRepo.repo, encoding: "utf8" },
  );
  superRepo.git("commit", "-m", "add submodule");

  const before = stateFingerprint(superRepo.repo);
  assert.equal(stateFingerprint(superRepo.repo), before, "fingerprint must be deterministic");

  writeFileSync(join(superRepo.repo, "sm", "lib.txt"), "v2 dirty\n");
  assert.notEqual(
    stateFingerprint(superRepo.repo),
    before,
    "a dirty tracked file inside a submodule must change the fingerprint",
  );
});

test("bridge scaffold refuses a target directory that resolves outside the repo", () => {
  const project = temporaryDir("bridge-symlink-");
  const outside = temporaryDir("bridge-outside-");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node --test tests/*.test.mjs" } }),
  );
  symlinkSync(outside, join(project, "tests"), "dir");
  assert.equal(scaffoldBridgeTests("/tmp/2026-01-01-r.html", ["x"], project), null);
  assert.deepEqual(readdirSync(outside), [], "nothing may be written outside the repository");
});

test("bridge extracts concrete acceptance criteria, not placeholders", () => {
  const template = readFileSync(
    resolve(root, "compass", "assets", "decision-record.html"),
    "utf8",
  );
  assert.deepEqual(extractBridgeCriteria(template), []);
  const filled = template.replace(
    "<li>OBSERVABLE RESULT</li>",
    "<li>Login succeeds with a <code>valid</code> token</li><li>Expired tokens are rejected</li>",
  );
  assert.deepEqual(extractBridgeCriteria(filled), [
    "Login succeeds with a valid token",
    "Expired tokens are rejected",
  ]);
});

test("bridge scaffolds failing tests bound to the record", () => {
  const shelf = temporaryDir("bridge-shelf-");
  const project = temporaryDir("bridge-project-");
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node --test" } }),
  );
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [shelfCli, ...args], {
      cwd: project,
      env,
      encoding: "utf8",
    });

  const created = run(["new", "Pick an auth flow"]);
  assert.equal(created.status, 0, created.stderr);
  const recordPath = created.stdout.trim();

  const unfilled = run(["bridge", "pick-an-auth-flow"]);
  assert.notEqual(unfilled.status, 0);
  assert.match(unfilled.stderr, /no concrete acceptance criteria/);

  const record = readFileSync(recordPath, "utf8").replace(
    "<li>OBSERVABLE RESULT</li>",
    "<li>Sessions expire after 30 minutes</li>",
  );
  writeFileSync(recordPath, record);

  const bridged = run(["bridge", "pick-an-auth-flow"]);
  assert.equal(bridged.status, 0, bridged.stderr);
  const testPath = bridged.stdout.split("\n")[0].trim();
  assert.match(testPath, /test\/bridge-pick-an-auth-flow\.test\.mjs$/);
  const scaffold = readFileSync(testPath, "utf8");
  assert.match(scaffold, /Sessions expire after 30 minutes/);
  assert.match(scaffold, /assert\.fail/);
  assert.match(scaffold, new RegExp(recordPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // Strip the outer runner's context so the scaffold runs as a top-level
  // test process with a real exit code.
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const failing = spawnSync(process.execPath, ["--test", testPath], {
    cwd: project,
    env: childEnv,
    encoding: "utf8",
  });
  assert.notEqual(failing.status, 0);

  const again = run(["bridge", "pick-an-auth-flow"]);
  assert.notEqual(again.status, 0, "must not overwrite an existing scaffold");
});

test("bridge outside a node repo prints criteria instead of guessing", () => {
  const shelf = temporaryDir("bridge-shelf2-");
  const project = temporaryDir("bridge-plain-");
  const env = { ...process.env, DECISION_SHELF_HOME: shelf };
  const run = (args) =>
    spawnSync(process.execPath, [shelfCli, ...args], {
      cwd: project,
      env,
      encoding: "utf8",
    });
  const created = run(["new", "Choose a cache"]);
  assert.equal(created.status, 0, created.stderr);
  const recordPath = created.stdout.trim();
  writeFileSync(
    recordPath,
    readFileSync(recordPath, "utf8").replace(
      "<li>OBSERVABLE RESULT</li>",
      "<li>Cold reads stay under 50ms</li>",
    ),
  );
  const bridged = run(["bridge", "choose-a-cache"]);
  assert.equal(bridged.status, 0, bridged.stderr);
  assert.match(bridged.stdout, /- Cold reads stay under 50ms/);
  assert.equal(existsSync(join(project, "test")), false);
});

test("scaffoldBridgeTests declines non-node repositories", () => {
  const project = temporaryDir("bridge-decline-");
  assert.equal(scaffoldBridgeTests("/tmp/record.html", ["x"], project), null);
});

test("bridge declines foreign runners and honors the configured layout", () => {
  const jestProject = temporaryDir("bridge-jest-");
  writeFileSync(
    join(jestProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "jest" } }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/record.html", ["x"], jestProject), null);
  assert.equal(existsSync(join(jestProject, "test")), false);

  const specProject = temporaryDir("bridge-spec-");
  writeFileSync(
    join(specProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node --test spec/*.test.mjs" } }),
  );
  const scaffolded = scaffoldBridgeTests(
    "/tmp/2026-01-01-pick-a-cache.html",
    ["Cold reads stay under 50ms"],
    specProject,
  );
  assert.match(scaffolded, /spec\/bridge-pick-a-cache\.test\.mjs$/);
  assert.equal(existsSync(scaffolded), true);

  // An exact-file script never runs a scaffolded sibling: decline.
  const exactProject = temporaryDir("bridge-exact-");
  writeFileSync(
    join(exactProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node --test test/smoke.test.mjs" } }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], exactProject), null);
  assert.equal(existsSync(join(exactProject, "test")), false);

  // A bare directory argument is loaded as a module by the runner, not
  // discovered under (`node --test spec` → MODULE_NOT_FOUND): decline.
  const bareDirProject = temporaryDir("bridge-bare-dir-");
  writeFileSync(
    join(bareDirProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node --test spec" } }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], bareDirProject), null);
  assert.equal(existsSync(join(bareDirProject, "spec")), false);

  // A glob that cannot match the generated filename: decline.
  const mismatchProject = temporaryDir("bridge-mismatch-");
  writeFileSync(
    join(mismatchProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node --test test/smoke-*.mjs" } }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], mismatchProject), null);
  assert.equal(existsSync(join(mismatchProject, "test")), false);

  // "node --test" as words inside another command is not a runner: decline.
  const echoProject = temporaryDir("bridge-echo-");
  writeFileSync(
    join(echoProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "echo node --test test/*.test.mjs" } }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], echoProject), null);
  assert.equal(existsSync(join(echoProject, "test")), false);

  // Leading environment assignments are still the node command itself.
  const envProject = temporaryDir("bridge-env-");
  writeFileSync(
    join(envProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "NODE_OPTIONS=--enable-source-maps node --test" },
    }),
  );
  const envScaffold = scaffoldBridgeTests("/tmp/2026-01-01-r.html", ["x"], envProject);
  assert.match(envScaffold, /test\/bridge-r\.test\.mjs$/);

  // --test as an argument to a program entry point is not the runner flag.
  const runnerProject = temporaryDir("bridge-runner-");
  writeFileSync(
    join(runnerProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "node runner.mjs --test test/*.test.mjs" },
    }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], runnerProject), null);

  // An option before --test can consume it as its own argument
  // (`node -r --test …` never starts the runner): decline.
  const preOptionProject = temporaryDir("bridge-pre-option-");
  writeFileSync(
    join(preOptionProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node -r --test test/*.test.mjs" } }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], preOptionProject), null);
  assert.equal(existsSync(join(preOptionProject, "test")), false);

  // Options after --test can consume the next token as a value, making the
  // real test path unprovable: decline.
  const reporterProject = temporaryDir("bridge-reporter-");
  writeFileSync(
    join(reporterProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "node --test --test-reporter spec test/*.test.mjs" },
    }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], reporterProject), null);
  assert.equal(existsSync(join(reporterProject, "spec")), false);

  // A quoted path with spaces is one token — and still a bare directory
  // argument, which the runner loads rather than discovers: decline.
  const quotedProject = temporaryDir("bridge-quoted-");
  writeFileSync(
    join(quotedProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: 'node --test "test files"' } }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/2026-01-01-r.html", ["x"], quotedProject), null);
  assert.equal(existsSync(join(quotedProject, "test files")), false);
  // A shell-terminating builtin before the runner means it never executes
  // (`exit 0; node --test …` returns success without running anything).
  const exitProject = temporaryDir("bridge-exit-");
  writeFileSync(
    join(exitProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "exit 0; node --test test/*.test.mjs" },
    }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], exitProject), null);
  assert.equal(existsSync(join(exitProject, "test")), false);

  // Before &&, a prefix that can fail short-circuits the runner away:
  // `false && node --test …` never executes it. Decline.
  const shortCircuitProject = temporaryDir("bridge-short-circuit-");
  writeFileSync(
    join(shortCircuitProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "false && node --test test/*.test.mjs" },
    }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], shortCircuitProject), null);
  assert.equal(existsSync(join(shortCircuitProject, "test")), false);

  // printf can fail (`printf %d x` exits 1), so it proves nothing before &&.
  const printfProject = temporaryDir("bridge-printf-");
  writeFileSync(
    join(printfProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "printf %d x && node --test test/*.test.mjs" },
    }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], printfProject), null);
  assert.equal(existsSync(join(printfProject, "test")), false);

  // A prefix that always succeeds keeps an &&-chained runner reachable.
  const provenAndProject = temporaryDir("bridge-proven-and-");
  writeFileSync(
    join(provenAndProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "true && node --test test/*.test.mjs" },
    }),
  );
  assert.match(
    scaffoldBridgeTests("/tmp/2026-01-01-r.html", ["x"], provenAndProject),
    /test\/bridge-r\.test\.mjs$/,
  );

  // eval can terminate the current shell despite not being `exit` itself:
  // only provably-continuing commands may precede the runner.
  const evalProject = temporaryDir("bridge-eval-");
  writeFileSync(
    join(evalProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "eval 'exit 0'; node --test test/*.test.mjs" },
    }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], evalProject), null);
  assert.equal(existsSync(join(evalProject, "test")), false);

  // A runner behind an unquoted # is commented out and never executes:
  // decline, creating nothing.
  const commentedProject = temporaryDir("bridge-commented-");
  writeFileSync(
    join(commentedProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "echo skipped # ; node --test test/*.test.mjs" },
    }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], commentedProject), null);
  assert.equal(existsSync(join(commentedProject, "test")), false);

  // A trailing comment after a real runner must not cost the scaffold.
  const trailingCommentProject = temporaryDir("bridge-trailing-comment-");
  writeFileSync(
    join(trailingCommentProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "node --test test/*.test.mjs # acceptance specs" },
    }),
  );
  const trailingScaffold = scaffoldBridgeTests(
    "/tmp/2026-01-01-r.html",
    ["x"],
    trailingCommentProject,
  );
  assert.match(trailingScaffold, /test\/bridge-r\.test\.mjs$/);

  // An unquoted newline separates commands like a semicolon: a trailing
  // line would mask the runner's exit code. Decline.
  const newlineMaskProject = temporaryDir("bridge-newline-mask-");
  writeFileSync(
    join(newlineMaskProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "node --test test/*.test.mjs\ntrue" },
    }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], newlineMaskProject), null);
  assert.equal(existsSync(join(newlineMaskProject, "test")), false);

  // A comment ends at its newline: a runner on the next line is real.
  const commentLineProject = temporaryDir("bridge-comment-line-");
  writeFileSync(
    join(commentLineProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "echo start # note\nnode --test test/*.test.mjs" },
    }),
  );
  assert.match(
    scaffoldBridgeTests("/tmp/2026-01-01-r.html", ["x"], commentLineProject),
    /test\/bridge-r\.test\.mjs$/,
  );

  // A double-quoted shell expansion is not a literal path: npm test would
  // expand it while the scaffold would land in a directory literally named
  // for the variable. Decline, and create nothing.
  const expansionProject = temporaryDir("bridge-expansion-");
  writeFileSync(
    join(expansionProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: 'node --test "${TEST_DIR}/*.test.mjs"' },
    }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], expansionProject), null);
  assert.equal(existsSync(join(expansionProject, "${TEST_DIR}")), false);

  // A quoted glob is still a provable pattern, so quoting alone must not
  // cost the scaffold.
  const quotedGlobProject = temporaryDir("bridge-quoted-glob-");
  writeFileSync(
    join(quotedGlobProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: 'node --test "test files/*.test.mjs"' } }),
  );
  const quotedScaffold = scaffoldBridgeTests(
    "/tmp/2026-01-01-r.html",
    ["x"],
    quotedGlobProject,
  );
  assert.match(quotedScaffold, /test files\/bridge-r\.test\.mjs$/);

  // Unbalanced quoting is not worth guessing: decline.
  const unbalancedProject = temporaryDir("bridge-unbalanced-");
  writeFileSync(
    join(unbalancedProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: 'node --test "broken' } }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], unbalancedProject), null);

  // Operators inside quoted text are not command boundaries: decline.
  const quotedOpsProject = temporaryDir("bridge-quoted-ops-");
  writeFileSync(
    join(quotedOpsProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: 'echo "before && node --test test && after"' },
    }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], quotedOpsProject), null);
  assert.equal(existsSync(join(quotedOpsProject, "test")), false);

  // An escaped operator is literal: the whole line is echo's arguments.
  const escapedProject = temporaryDir("bridge-escaped-");
  writeFileSync(
    join(escapedProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "echo before \\; node --test test/*.test.mjs" },
    }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], escapedProject), null);
  assert.equal(existsSync(join(escapedProject, "test")), false);

  // Absolute targets cannot be honestly joined under the repository: decline.
  const absoluteProject = temporaryDir("bridge-absolute-");
  writeFileSync(
    join(absoluteProject, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "node --test /tmp/project-tests/*.test.mjs" },
    }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], absoluteProject), null);

  // A real node --test followed by an &&-chain still scaffolds: a failing
  // test still fails npm test.
  const chainedProject = temporaryDir("bridge-chained-");
  writeFileSync(
    join(chainedProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node --test && echo done" } }),
  );
  const chainedScaffold = scaffoldBridgeTests(
    "/tmp/2026-01-01-r.html",
    ["x"],
    chainedProject,
  );
  assert.match(chainedScaffold, /test\/bridge-r\.test\.mjs$/);

  // Behind ||, the runner may never execute: decline.
  const orProject = temporaryDir("bridge-or-");
  writeFileSync(
    join(orProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "true || node --test test/*.test.mjs" } }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], orProject), null);

  // A command after ; would mask the runner's exit code: decline.
  const maskedExitProject = temporaryDir("bridge-masked-exit-");
  writeFileSync(
    join(maskedExitProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node --test ; echo done" } }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], maskedExitProject), null);

  // An unconditional prefix before the runner is fine: exit still propagates.
  const prefixProject = temporaryDir("bridge-prefix-");
  writeFileSync(
    join(prefixProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "echo start ; node --test" } }),
  );
  const prefixScaffold = scaffoldBridgeTests(
    "/tmp/2026-01-01-r.html",
    ["x"],
    prefixProject,
  );
  assert.match(prefixScaffold, /test\/bridge-r\.test\.mjs$/);

  // Traversal outside the repository: decline.
  const traversalProject = temporaryDir("bridge-traversal-");
  writeFileSync(
    join(traversalProject, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node --test ../shared/*.test.mjs" } }),
  );
  assert.equal(scaffoldBridgeTests("/tmp/r.html", ["x"], traversalProject), null);
});

test("checks bind results to the exact head and flag state changes", () => {
  const stable = gitRepo();
  writeFileSync(
    join(stable.repo, "package.json"),
    JSON.stringify({ name: "x", scripts: { test: "node -e ''" } }),
  );
  stable.git("add", ".");
  stable.git("commit", "-m", "add passing check");
  const bound = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: stable.repo,
    encoding: "utf8",
  });
  assert.equal(bound.status, 0, bound.stderr);
  assert.match(bound.stdout, new RegExp(`at head ${stable.git("rev-parse", "HEAD")}`));

  const mutating = gitRepo();
  writeFileSync(
    join(mutating.repo, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "node -e \"require('fs').writeFileSync('mutated.txt','x')\"" },
    }),
  );
  mutating.git("add", ".");
  mutating.git("commit", "-m", "add mutating check");
  const invalidated = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: mutating.repo,
    encoding: "utf8",
  });
  assert.notEqual(invalidated.status, 0);
  assert.match(invalidated.stdout, /INVALIDATED: the checks changed repository state/);

  // A dirty-flag boolean would miss a check that overwrites an untracked
  // file inside an already-dirty tree; the content fingerprint must not.
  const masked = gitRepo();
  writeFileSync(
    join(masked.repo, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "node -e \"require('fs').writeFileSync('scratch.txt','B')\"" },
    }),
  );
  masked.git("add", ".");
  masked.git("commit", "-m", "add overwriting check");
  writeFileSync(join(masked.repo, "scratch.txt"), "A");

  const stillCaught = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: masked.repo,
    encoding: "utf8",
  });
  assert.notEqual(stillCaught.status, 0);
  assert.match(stillCaught.stdout, /INVALIDATED: the checks changed repository state/);

  // Run from a subdirectory, a check mutating a file elsewhere in the repo
  // must still invalidate: the fingerprint covers the whole worktree.
  const subdir = gitRepo();
  mkdirSync(join(subdir.repo, "pkg"));
  writeFileSync(
    join(subdir.repo, "pkg", "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "node -e \"require('fs').writeFileSync('../rootfile.txt','x')\"" },
    }),
  );
  subdir.git("add", ".");
  subdir.git("commit", "-m", "add subdir check");

  const outsideCwd = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: join(subdir.repo, "pkg"),
    encoding: "utf8",
  });
  assert.notEqual(outsideCwd.status, 0);
  assert.match(outsideCwd.stdout, /INVALIDATED: the checks changed repository state/);

  // A tracked file later matched by .gitignore stays in the fingerprint:
  // ignore rules only apply to untracked paths.
  const ignoredTracked = gitRepo();
  writeFileSync(join(ignoredTracked.repo, "build.log"), "old\n");
  writeFileSync(
    join(ignoredTracked.repo, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "node -e \"require('fs').writeFileSync('build.log','new')\"" },
    }),
  );
  ignoredTracked.git("add", ".");
  ignoredTracked.git("commit", "-m", "track build.log");
  writeFileSync(join(ignoredTracked.repo, ".gitignore"), "build.log\n");
  ignoredTracked.git("add", ".gitignore");
  ignoredTracked.git("commit", "-m", "ignore build.log");

  const trackedCaught = spawnSync(process.execPath, [deliveryCli, "checks"], {
    cwd: ignoredTracked.repo,
    encoding: "utf8",
  });
  assert.notEqual(trackedCaught.status, 0);
  assert.match(trackedCaught.stdout, /INVALIDATED: the checks changed repository state/);
});

test("receipt invalidates evidence when checks mutate repository state", () => {
  const { repo, git } = gitRepo();
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "x",
      scripts: { test: "node -e \"require('fs').writeFileSync('mutated.txt','x')\"" },
    }),
  );
  git("add", ".");
  git("commit", "-m", "add mutating check");

  const receipt = buildReceipt(repo);

  assert.match(receipt, /INVALIDATED: running the checks changed repository state/);
  assert.match(receipt, /re-run the checks at the final head/);
});
