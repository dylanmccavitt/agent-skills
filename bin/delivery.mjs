#!/usr/bin/env node

// Delivery mechanics as an interface: discover and run a repository's
// documented checks and draft receipts bound to the exact head. Help text
// is the manual. Branching and worktree isolation stay with git and the
// harness — this tool does not manage them.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `delivery — checks and receipts for evidence-first delivery

Evidence is bound to the exact head that produced it: if the head moves,
re-run. A green check means ready, not authorized — external effects (merge,
deploy, publish, migrate) stay with the user.

Usage:
  delivery checks [--list]           Discover and run this repo's documented checks
  delivery receipt [--base REF] [--no-checks]
                                     Draft a delivery receipt from live state
  delivery help                      Show this help

Checks are discovered, not configured: package.json scripts (test, lint,
typecheck, check), Makefile targets (test, lint, check), Cargo.toml, go.mod.
Every discovered check is reported as pass, fail, or blocked — a skipped
check is stated, not hidden.

Stray context files (plan.md, notes.md, handoff.md, todo.md) are flagged as
advisories, never failures: durable context belongs in the issue, the PR, the
decision shelf, or agent memory — not in the repository.

Receipts follow the relay receipt shape: outcome, where, evidence at head,
skipped or blocked, open questions, next action. The tool fills what live
state proves; fill in what only the author knows before presenting it.
`;

function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// The real index carries state neither git status nor the content
// fingerprint can see — entry flags like assume-unchanged and
// skip-worktree (the lowercase/S prefixes of ls-files -v) and file modes
// (ls-files -s). Null when the index cannot be read: fail closed.
function indexFingerprint(cwd) {
  // Read from the repository top level — ls-files in a subdirectory lists
  // only that subtree — and recurse into initialized submodules, whose
  // indexes (and entry flags) are invisible from the superproject.
  const worktree = git(["rev-parse", "--show-toplevel"], cwd) || cwd;
  try {
    const stage = execFileSync("git", ["ls-files", "-s"], {
      cwd: worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const flags = execFileSync("git", ["ls-files", "-v"], {
      cwd: worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parts = [`${stage}\n${flags}`];
    const nestedPaths = gitlinkPaths(worktree);
    if (nestedPaths === null) return null;
    for (const path of nestedPaths) {
      const nested = join(worktree, path);
      if (!existsSync(join(nested, ".git"))) continue;
      const inner = indexFingerprint(nested);
      if (inner === null) return null;
      parts.push(`${path}=${inner}`);
    }
    return parts.join(";");
  } catch {
    return null;
  }
}

// "clean", "dirty", or null when git status itself fails — a failed status
// must never read as clean, so callers block on null.
function worktreeStatus(cwd) {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim() === "" ? "clean" : "dirty";
  } catch {
    return null;
  }
}

// A content fingerprint of the exact repository state: the head plus a tree
// hash of the full working tree (tracked and untracked, via a scratch
// index), so any mutation during checks is detected — a dirty-flag boolean
// would mask changes inside an already-dirty tree. Recurses into
// initialized submodules: the superproject's tree records only each
// submodule's gitlink commit, never dirty contents inside its working tree.
// Returns null when there is no head to bind to, or when the fingerprint
// cannot be built — callers must fail closed on null, never treat the
// evidence as valid.
export function stateFingerprint(cwd = process.cwd()) {
  const head = git(["rev-parse", "HEAD"], cwd);
  if (!head) return null;
  // Stage from the repository top level: a cwd-relative pathspec would
  // blind the fingerprint to check mutations outside the current subtree.
  const worktree = git(["rev-parse", "--show-toplevel"], cwd) || cwd;
  const tree = worktreeFingerprint(worktree);
  return tree === null ? null : `${head}:${tree}`;
}

function worktreeFingerprint(worktree) {
  const scratch = mkdtempSync(join(tmpdir(), "delivery-fp-"));
  let tree = "";
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
    // Seed from HEAD so tracked files stay in the fingerprint even when a
    // later .gitignore rule matches them — ignore rules only affect
    // untracked paths once the file is already in the index.
    execFileSync("git", ["read-tree", "HEAD"], {
      cwd: worktree,
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    execFileSync("git", ["add", "-A", "."], {
      cwd: worktree,
      env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    tree = execFileSync("git", ["write-tree"], {
      cwd: worktree,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Fail closed: a status-porcelain fallback records categories and
    // paths, not contents, so a check rewriting an already-dirty file
    // would go unnoticed. No fingerprint is better than a lying one.
    tree = null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (tree === null) return null;
  const parts = [tree];
  const nestedPaths = gitlinkPaths(worktree);
  if (nestedPaths === null) return null;
  for (const path of nestedPaths) {
    const nested = join(worktree, path);
    // An uninitialized gitlink is an empty directory; running git there
    // would climb back to the superproject and fingerprint it twice.
    if (!existsSync(join(nested, ".git"))) continue;
    const inner = worktreeFingerprint(nested);
    if (inner === null) return null;
    parts.push(`${path}=${inner}`);
  }
  return parts.join(";");
}

// Nested repositories enumerated as mode-160000 gitlink entries from the
// index itself — .gitmodules is optional (git permits a bare `git add
// nested`), so the index is the only complete source. Null when it cannot
// be read: callers fail closed.
function gitlinkPaths(worktree) {
  try {
    return execFileSync("git", ["ls-files", "-s"], {
      cwd: worktree,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split("\n")
      .filter((line) => line.startsWith("160000 "))
      .map((line) => line.split("\t").slice(1).join("\t"))
      .filter(Boolean);
  } catch {
    return null;
  }
}

const NPM_PLACEHOLDER_TEST = /echo .Error: no test specified/;

export function discoverChecks(cwd = process.cwd()) {
  const checks = [];
  const packagePath = join(cwd, "package.json");
  if (existsSync(packagePath)) {
    let scripts = {};
    try {
      scripts = JSON.parse(readFileSync(packagePath, "utf8")).scripts || {};
    } catch {
      scripts = {};
    }
    for (const name of ["test", "lint", "typecheck", "check"]) {
      const script = scripts[name];
      if (!script || (name === "test" && NPM_PLACEHOLDER_TEST.test(script))) continue;
      checks.push({
        label: name === "test" ? "npm test" : `npm run ${name}`,
        command: name === "test" ? ["npm", "test"] : ["npm", "run", name],
      });
    }
  }
  const makefilePath = join(cwd, "Makefile");
  if (existsSync(makefilePath)) {
    const makefile = readFileSync(makefilePath, "utf8");
    for (const target of ["test", "lint", "check"]) {
      if (new RegExp(`^${target}\\s*:`, "m").test(makefile)) {
        checks.push({ label: `make ${target}`, command: ["make", target] });
      }
    }
  }
  if (existsSync(join(cwd, "Cargo.toml"))) {
    checks.push({ label: "cargo test", command: ["cargo", "test"] });
  }
  if (existsSync(join(cwd, "go.mod"))) {
    checks.push({ label: "go test ./...", command: ["go", "test", "./..."] });
  }
  return checks;
}

export function runChecks(cwd = process.cwd(), checks = discoverChecks(cwd)) {
  return checks.map((check) => {
    const result = spawnSync(check.command[0], check.command.slice(1), {
      cwd,
      encoding: "utf8",
    });
    const status =
      result.error || result.status === null
        ? "blocked"
        : result.status === 0
          ? "pass"
          : "fail";
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    const detail =
      status === "blocked"
        ? (result.error?.message || "could not run").split("\n")[0]
        : "";
    return { ...check, status, output, detail };
  });
}

function printCheckResults(results) {
  for (const result of results) {
    const suffix = result.detail ? ` (${result.detail})` : "";
    console.log(`${result.status.padEnd(7)} ${result.label}${suffix}`);
    if (result.status === "fail") {
      const tail = result.output.trim().split("\n").slice(-20);
      for (const line of tail) console.log(`        ${line}`);
    }
  }
}

// Cairn's promise — no plan.md/handoff.md scattered through repositories —
// only has teeth if something looks. Tracked and untracked files both count;
// ignored files are the author's business. Advisory only: stray context never
// fails the gate.
const STRAY_CONTEXT_NAMES = new Set(["plan.md", "notes.md", "handoff.md", "todo.md"]);

export function strayContextFiles(cwd = process.cwd()) {
  // The promise is repository-wide, and ls-files in a subdirectory lists
  // only that subtree — so scan from the repository top level. ls-files
  // cannot combine --recurse-submodules with the cached/others mode, so
  // each initialized submodule is scanned recursively and its results
  // prefixed, mirroring the fingerprint code above.
  const worktree = git(["rev-parse", "--show-toplevel"], cwd) || cwd;
  // NUL-delimited output (-z): with the default core.quotePath, a non-ASCII
  // path comes back C-style-quoted on newline output and its basename would
  // never match. NUL delimiting returns paths verbatim.
  const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], worktree);
  if (!listed) return [];
  const strays = listed
    .split("\0")
    .filter(Boolean)
    .filter((path) => STRAY_CONTEXT_NAMES.has(basename(path).toLowerCase()));
  for (const path of gitlinkPaths(worktree) || []) {
    const nested = join(worktree, path);
    if (!existsSync(join(nested, ".git"))) continue;
    for (const stray of strayContextFiles(nested)) {
      strays.push(`${path}/${stray}`);
    }
  }
  return strays.sort();
}

function printStrayAdvisories(cwd) {
  for (const stray of strayContextFiles(cwd)) {
    console.log(
      `advisory: stray context file ${stray} — fold it into its home (issue, PR, shelf, memory) and remove it`,
    );
  }
}

function commandChecks(cwd, listOnly) {
  const checks = discoverChecks(cwd);
  if (checks.length === 0) {
    console.log("No documented checks discovered (package.json scripts, Makefile, Cargo.toml, go.mod).");
    // Advisories are independent of check discovery: a repo with no checks
    // can still be littered with stray context files.
    printStrayAdvisories(cwd);
    process.exitCode = 1;
    return;
  }
  if (listOnly) {
    for (const check of checks) console.log(check.label);
    return;
  }
  const head = git(["rev-parse", "HEAD"], cwd);
  const status = worktreeStatus(cwd);
  const before = stateFingerprint(cwd);
  const indexBefore = indexFingerprint(cwd);
  const results = runChecks(cwd, checks);
  printCheckResults(results);
  // Evidence is only meaningful bound to the exact state it ran against.
  const headAfter = git(["rev-parse", "HEAD"], cwd);
  const statusAfter = worktreeStatus(cwd);
  const indexAfter = indexFingerprint(cwd);
  if (!head) {
    // Unbound evidence is not evidence: without a head there is nothing
    // to bind results to, so the gate fails even when every check passes.
    console.log(
      "BLOCKED: not inside a git repository with a commit — results are not bound to any head",
    );
    process.exitCode = 1;
  } else if (
    status === null ||
    statusAfter === null ||
    indexBefore === null ||
    indexAfter === null
  ) {
    // A failed git status or index read must never read as clean.
    console.log(
      "BLOCKED: git state could not be read (status or index) — evidence cannot be attributed to this head; fix the repository and re-run",
    );
    process.exitCode = 1;
  } else if (indexAfter !== indexBefore) {
    // Entry flags (assume-unchanged, skip-worktree) and modes live only in
    // the real index; status and the content fingerprint cannot see them.
    console.log(
      "INVALIDATED: the checks changed the git index (entry flags or modes); reset the index, then re-run",
    );
    process.exitCode = 1;
  } else if (before === null) {
    console.log(
      "BLOCKED: repository state could not be fingerprinted (scratch-index staging failed, e.g. a failing clean filter); evidence cannot be validated — fix the repository and re-run",
    );
    process.exitCode = 1;
  } else if (stateFingerprint(cwd) !== before) {
    console.log(
      `INVALIDATED: the checks changed repository state (now at ${headAfter}` +
        `${statusAfter === "dirty" ? " with a dirty tree" : ""}); commit or clean up, then re-run at the final head`,
    );
    process.exitCode = 1;
  } else if (status === "clean" && statusAfter === "dirty") {
    // Content and HEAD unchanged but status now reports differences: the
    // checks mutated the real index (e.g. update-index --chmod).
    console.log(
      "INVALIDATED: the checks left the index dirty without changing content; reset the index, then re-run",
    );
    process.exitCode = 1;
  } else if (status === "dirty") {
    // A dirty tree means the evidence cannot be attributed to the reported
    // commit: the gate fails, exactly like unverifiable fingerprints.
    console.log(
      `BLOCKED: at head ${head} with a DIRTY working tree — evidence is not bound to a committed head; commit or stash, then re-run`,
    );
    process.exitCode = 1;
  } else {
    console.log(`at head ${head}`);
  }
  printStrayAdvisories(cwd);
  if (results.some((result) => result.status !== "pass")) process.exitCode = 1;
}

function defaultBase(cwd) {
  const originHead = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd);
  if (originHead) return originHead.replace("refs/remotes/", "");
  for (const candidate of ["main", "master"]) {
    if (git(["rev-parse", "--verify", "--quiet", candidate], cwd)) return candidate;
  }
  return "";
}

export function buildReceipt(cwd = process.cwd(), { base, checks = true } = {}) {
  const head = git(["rev-parse", "HEAD"], cwd);
  if (!head) throw new Error("not inside a git repository with at least one commit");
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const status = worktreeStatus(cwd);
  const fingerprintBefore = stateFingerprint(cwd);
  const indexBefore = indexFingerprint(cwd);
  const baseRef = base || defaultBase(cwd);

  let where = `branch \`${branch}\``;
  if (baseRef && baseRef !== branch) {
    const mergeBase = git(["merge-base", baseRef, "HEAD"], cwd);
    if (mergeBase && mergeBase !== head) {
      const files = git(["diff", "--name-only", `${mergeBase}..HEAD`], cwd)
        .split("\n")
        .filter(Boolean);
      const shown = files.slice(0, 10).join(", ");
      const more = files.length > 10 ? ` (+${files.length - 10} more)` : "";
      where += files.length > 0 ? ` — vs ${baseRef}: ${shown}${more}` : ` — no diff vs ${baseRef}`;
    } else if (mergeBase === head) {
      where += ` — no commits beyond ${baseRef}`;
    }
  }

  const headNote =
    status === null
      ? `${head} (BLOCKED — git status failed, worktree state unknown; evidence cannot be attributed to this head)`
      : status === "dirty"
        ? `${head} (DIRTY working tree — evidence is not bound to a committed head)`
        : head;

  let evidence = `no checks run, at head ${headNote}`;
  let skipped = "CHECKS NOT RUN AND WHY, OR NONE";
  if (checks) {
    const results = runChecks(cwd);
    if (results.length === 0) {
      evidence = `no documented checks discovered, at head ${headNote}`;
    } else {
      evidence = `${results
        .filter((result) => result.status !== "blocked")
        .map((result) => `${result.status} — ${result.label}`)
        .join("; ")}, at head ${headNote}`;
      const blocked = results.filter((result) => result.status === "blocked");
      skipped =
        blocked.length > 0
          ? blocked.map((result) => `${result.label} blocked: ${result.detail}`).join("; ")
          : "none";
      // Checks can create files, modify the tree, or move HEAD; evidence is
      // only valid if the state it was captured against survived the run —
      // compared by content fingerprint, since a dirty-flag boolean masks
      // mutations inside an already-dirty tree. An unbuildable fingerprint
      // fails closed: unverifiable evidence is not evidence.
      if (fingerprintBefore === null) {
        evidence +=
          " — BLOCKED: repository state could not be fingerprinted " +
          "(scratch-index staging failed, e.g. a failing clean filter); " +
          "evidence cannot be validated";
      } else {
        const headAfter = git(["rev-parse", "HEAD"], cwd);
        const statusAfter = worktreeStatus(cwd);
        if (stateFingerprint(cwd) !== fingerprintBefore) {
          evidence +=
            " — INVALIDATED: running the checks changed repository state " +
            `(now at ${headAfter}${statusAfter === "dirty" ? " with a dirty tree" : ""}); ` +
            "commit or clean up, then re-run the checks at the final head";
        } else if (statusAfter === null || indexBefore === null || indexFingerprint(cwd) === null) {
          evidence +=
            " — BLOCKED: git state could not be read after the checks; the worktree state is unknown";
        } else if (indexFingerprint(cwd) !== indexBefore) {
          evidence +=
            " — INVALIDATED: the checks changed the git index (entry flags or modes); reset the index, then re-run";
        } else if (status === "clean" && statusAfter === "dirty") {
          evidence +=
            " — INVALIDATED: the checks left the index dirty without changing content; reset the index, then re-run";
        }
      }
    }
  }

  return [
    "# Receipt: TASK",
    "",
    "- **Outcome:** WHAT CHANGED AND WHY",
    `- **Where:** ${where}`,
    `- **Evidence:** ${evidence}`,
    `- **Skipped or blocked:** ${skipped}`,
    "- **Open questions:** DECISIONS THE USER STILL OWNS, OR NONE",
    "- **Next action:** THE EXACT NEXT STEP",
    "",
  ].join("\n");
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const cwd = process.cwd();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
  } else if (command === "checks") {
    commandChecks(cwd, rest.includes("--list"));
  } else if (command === "receipt") {
    const baseIndex = rest.indexOf("--base");
    process.stdout.write(
      buildReceipt(cwd, {
        base: baseIndex >= 0 ? rest[baseIndex + 1] : undefined,
        checks: !rest.includes("--no-checks"),
      }),
    );
  } else {
    throw new Error(`unknown command: ${command} (try: delivery help)`);
  }
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(`delivery: ${error.message}`);
    process.exitCode = 1;
  }
}
