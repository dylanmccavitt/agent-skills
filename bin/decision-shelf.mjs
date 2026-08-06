#!/usr/bin/env node

// The decision shelf: durable, agent-agnostic decision records kept outside
// every repository. This CLI is the interface; its help text is the manual.

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = join(packageRoot, "compass", "assets", "decision-record.html");
const STATUSES = ["exploring", "selected", "rejected", "superseded"];

const HELP = `decision-shelf — durable decision records, kept outside the repository

The shelf holds one HTML record per decision, grouped per project. Records
outlive sessions and agents: resume the matching record instead of creating a
duplicate, and refresh live repository state before trusting anything a record
says. Never mirror records into the repository as markdown files.

Usage:
  decision-shelf path                Print the shelf and current project folder
  decision-shelf list [--all] [--stale]
                                     List records, newest first, superseded last
                                     (--all: every project; --stale: only records
                                     needing attention)
  decision-shelf new "<question>" [--status <status>]
                                     Create a record for one decision, print its
                                     path (--status sets the status at creation,
                                     for a decision that is already made)
  decision-shelf status <record>     Resume: print what the record says now
                                     (status, date, staleness) without changing it
  decision-shelf status <record> <status>
                                     Set a record's status (updates the chip,
                                     data-status, and updated date together)
  decision-shelf supersede <old> <new>
                                     Mark <old> superseded and link its successor
  decision-shelf find <text>         Find records matching text in name or content
  decision-shelf propose <record> "<change>"
                                     Add a visible branch without changing the current plan
  decision-shelf checkpoint <record> <proposal-id>
                                     Fold an open branch into a new current revision
  decision-shelf reject <record> <proposal-id> "<reason>"
                                     Close a branch and retain its rationale in history
  decision-shelf view <record>       Print the stable absolute path to its visual tree
  decision-shelf bridge <record>     Turn a record's acceptance criteria into failing tests
  decision-shelf proto <record> new [variant...]
                                     Create the record's disposable prototype lane
                                     beside it, one stub folder per variant named;
                                     naming several prints each variant's URL and
                                     the record's locator, so one command builds
                                     a whole comparison
  decision-shelf proto <record> view Print one URL or path per variant, then the
                                     record's locator
  decision-shelf proto <record> promote <variant>
                                     Record the surviving variant in the record's
                                     Prototype field and evidence table, one write
  decision-shelf proto <record> clean
                                     Remove the lane; the record keeps the outcome
  decision-shelf help                Show this help

Statuses (set with \`status\`; \`supersede\` is the only way to set superseded):
  exploring   research, comparison, and prototypes only
  selected    a direction is chosen; prepare implementation, do not implement
  rejected    kept so the same exploration is not repeated
  superseded  replaced by a newer record; the successor is linked

A record is stale when it is exploring or selected with no update in 30 days,
superseded without a successor link, or settled (selected, rejected, or
superseded) with a prototype lane still present. A lane is expected while
exploring; it outliving the decision is what staleness flags.

Conventions:
  - One record per decision, named YYYY-MM-DD-<slug>.html.
  - Edit records directly; keep them semantic HTML readable without a build step.
  - The record's Bridge section carries acceptance criteria, non-goals, and
    delivery links once a direction is selected. \`bridge\` scaffolds those
    criteria as failing tests in the current repository, so implementation
    binds to an executable spec instead of prose.
  - \`status <record>\` with no status resumes a record: it verifies the file,
    reports what the record says now, and prints its locator line. It resolves
    a unique record anywhere on the shelf, so a project that moved or was
    cloned elsewhere can still be picked back up.
  - Finish agent responses that touched the shelf with that one locator line,
    copied verbatim: "Record: /absolute/path.html", or "Record: none".

Location: $DECISION_SHELF_HOME, else $XDG_DATA_HOME/decision-shelf, else
~/.local/share/decision-shelf.
`;

function git(args, cwd) {
  const { execFileSync } = require("node:child_process");
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
function hasGitRepository(cwd) {
  if (process.env.GIT_DIR) return true;

  const start = cwd;
  let directory = start;
  while (true) {
    if (existsSync(join(directory, ".git"))) return true;
    if (
      directory === start &&
      existsSync(join(directory, "HEAD")) &&
      existsSync(join(directory, "objects")) &&
      existsSync(join(directory, "refs"))
    ) {
      return true;
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}


// Decision records need a useful repository locator, never transport
// credentials. URL userinfo and query/fragment data are unnecessary for
// identity and are common places for tokens to leak; scp-style SSH remotes
// lose their user prefix for the same reason.
export function sanitizeRepositoryIdentity(value) {
  const repository = String(value).trim();
  if (!repository || repository.includes("\\") || repository.includes("::")) return "";
  try {
    const url = new URL(repository);
    if (url.protocol !== "file:" && !url.host && repository.includes("@")) {
      return "";
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    if (repository.includes("://")) return "";
    // Git's scp-style syntax is not a URL. Retain only its host and path,
    // dropping userinfo and URL-like query/fragment suffixes. Any malformed
    // URL-style value fails closed instead of being persisted verbatim.
    const scp = repository.match(
      /^(?:[^@\s:/]+@)?([^@:/\s]+):([^?#\s]+?)(?:[?#].*)?$/,
    );
    if (scp) return `${scp[1]}:${scp[2]}`;
    if (/[@?#\r\n\0]/.test(repository)) return "";
    return repository;
  }
}

export function resolveShelf(env = process.env, home) {
  if (env.DECISION_SHELF_HOME) return resolve(env.DECISION_SHELF_HOME);
  const dataHome =
    env.XDG_DATA_HOME ||
    join(home || require("node:os").homedir(), ".local", "share");
  return join(dataHome, "decision-shelf");
}

export function projectFolder(cwd = process.cwd()) {
  const resolvedCwd = resolve(cwd);
  if (!hasGitRepository(resolvedCwd)) {
    const hash = createHash("sha256")
      .update(resolvedCwd)
      .digest("hex")
      .slice(0, 8);
    return `local--${basename(resolvedCwd)}--${hash}`;
  }

  const remote = sanitizeRepositoryIdentity(
    git(["remote", "get-url", "origin"], resolvedCwd),
  );
  if (remote) {
    const match = remote.match(
      /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)[:/](.+?)(?:\.git)?\/?$/,
    );
    if (match) {
      const host = match[1];
      const segments = match[2].split("/").filter(Boolean);
      if (segments.length >= 2) {
        return `${host}--${segments[segments.length - 2]}--${segments[segments.length - 1]}`;
      }
    }
  }
  const root = git(["rev-parse", "--show-toplevel"], resolvedCwd) || resolvedCwd;
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `local--${basename(root)}--${hash}`;
}

function recordSummaryFromText(text, path) {
  const status = text.match(/data-status="([^"]*)"/)?.[1] || "unknown";
  const updated = text.match(/data-updated="([^"]*)"/)?.[1] || "";
  const encodedTitle = text.match(/<h1>([^<]*)<\/h1>/)?.[1];
  const title = encodedTitle ? decodeHtmlText(encodedTitle) : basename(path);
  // Only an actual successor anchor in the record's header counts as
  // linked — a hand-edited label with empty or plain-text content, or a
  // row misplaced outside the header, still leaves the record stale.
  const header = text.match(/<header>[\s\S]*?<\/header>/)?.[0] || "";
  const successor = header.match(/<dt>Superseded by<\/dt>\s*<dd>([\s\S]*?)<\/dd>/);
  const linked = Boolean(successor && SUCCESSOR_ANCHOR.test(successor[1]));
  const lane = laneOwned(lanePath(path), path);
  return { status, updated, title, linked, lane };
}

function recordSummary(path) {
  return recordSummaryFromText(readFileSync(path, "utf8"), path);
}

// The prototype lane lives beside its record, named after it: the record is
// the only thing that can own one.
function lanePath(recordPath) {
  return recordPath.replace(/\.html$/, ".proto");
}

// Records are hand-edited semantic HTML: both valid attribute quoting forms
// count as a successor anchor.
const SUCCESSOR_ANCHOR = /<a\s[^>]*href\s*=\s*("[^"]+"|'[^']+')/;

// Ownership is proven by a marker written at creation, never inferred from
// the directory name: an unmarked or symlinked directory at the lane path is
// user data the CLI refuses to adopt, mutate, remove, or count as a lane.
const LANE_MARKER = ".decision-shelf-lane";

// A marker only proves ownership when it is a regular file whose contents
// name this exact record — a lane moved or copied from another record, or a
// symlinked or malformed marker, proves nothing and is refused. The stored
// identity is project-qualified: two projects can hold records with the
// same date and slug, and a lane moved across them must not pass.
function laneRecordId(recordPath) {
  return `${basename(dirname(recordPath))}/${basename(recordPath)}`;
}

function laneMarkerValid(lane, recordPath) {
  try {
    if (!lstatSync(join(lane, LANE_MARKER)).isFile()) return false;
    const marker = JSON.parse(readFileSync(join(lane, LANE_MARKER), "utf8"));
    return (
      marker.owner === "decision-shelf proto" && marker.record === laneRecordId(recordPath)
    );
  } catch {
    return false;
  }
}

function laneOwned(lane, recordPath) {
  try {
    return !lstatSync(lane).isSymbolicLink() && laneMarkerValid(lane, recordPath);
  } catch {
    return false;
  }
}

const STALE_AFTER_DAYS = 30;

// A record needs attention when its status promises activity that stopped,
// promises a successor that was never linked, or is settled while its
// disposable prototype lane still exists. A lane is expected while
// exploring; it outliving the decision is the smell.
export function staleReason(summary, now = new Date()) {
  const { status, updated, linked, lane } = summary;
  if (status === "superseded") {
    if (!linked) return "superseded without a successor link";
    return lane ? "superseded with a prototype lane still present" : null;
  }
  if (status === "rejected") {
    return lane ? "rejected with a prototype lane still present" : null;
  }
  if (status !== "exploring" && status !== "selected") return null;
  if (status === "selected" && lane) {
    return "selected with a prototype lane still present";
  }
  const age = Math.floor((now - new Date(updated)) / 86_400_000);
  if (!updated || Number.isNaN(age)) return "no readable data-updated date";
  return age >= STALE_AFTER_DAYS ? `${status} with no update in ${age} days` : null;
}

function listRecords(directory) {
  let stat;
  try {
    stat = lstatSync(directory);
  } catch {
    return [];
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
    .map((entry) => entry.name)
    .sort()
    .map((name) => join(directory, name));
}

function slugify(text) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "decision"
  );
}

function pathInside(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// A configured shelf root may itself be a deliberate symlink, but each
// project folder is package-owned state and must be a real direct child of
// that shelf. This prevents a pre-planted project symlink from redirecting
// `new` and every later record operation outside the shelf.
function projectDirectoryState(shelf, project, { create = false } = {}) {
  const shelfPath = resolve(shelf);
  const directory = resolve(shelfPath, project);
  if (directory === shelfPath || dirname(directory) !== shelfPath) {
    throw new Error(`invalid project shelf folder — refusing:\n${directory}`);
  }
  if (!lstatOrNull(shelfPath) && create) mkdirSync(shelfPath, { recursive: true });

  let realShelf;
  try {
    realShelf = realpathSync(shelfPath);
    if (!lstatSync(realShelf).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`decision shelf must resolve to a directory — refusing:\n${shelfPath}`);
  }

  let stat = lstatOrNull(directory);
  if (!stat && create) {
    try {
      mkdirSync(directory);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    stat = lstatOrNull(directory);
  }
  if (!stat) throw new Error(`project shelf folder not found — refusing:\n${directory}`);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(
      `project folder must be a real directory, not a symlink — refusing:\n${directory}`,
    );
  }

  let realDirectory;
  try {
    realDirectory = realpathSync(directory);
  } catch {
    throw new Error(`project shelf folder could not be resolved safely — refusing:\n${directory}`);
  }
  if (realDirectory === realShelf || !pathInside(realShelf, realDirectory)) {
    throw new Error(`project shelf folder escapes the configured shelf — refusing:\n${directory}`);
  }
  const identity = lstatSync(directory, { bigint: true });
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error(
      `project folder must be a real directory, not a symlink — refusing:\n${directory}`,
    );
  }
  let finalRealDirectory;
  try {
    finalRealDirectory = realpathSync(directory);
  } catch {
    throw new Error(`project shelf folder could not be resolved safely — refusing:\n${directory}`);
  }
  if (finalRealDirectory !== realDirectory) {
    throw new Error(`project folder identity changed during validation — refusing:\n${directory}`);
  }
  return { directory, identity, realDirectory, realShelf };
}

function projectDirectory(shelf, project, options) {
  return projectDirectoryState(shelf, project, options).directory;
}

// Entering the validated directory binds relative resolution to that directory
// inode. A replacement before the bind is caught by the identity check; a
// replacement after it cannot redirect the relative create through a symlink.
export function writeFileInDirectory(
  directory,
  expected,
  filename,
  contents,
  changeDirectory = (path) => process.chdir(path),
) {
  if (!filename || basename(filename) !== filename) {
    throw new Error(`record filename must be a direct child — refusing:\n${filename}`);
  }
  if (expected.isSymbolicLink() || !expected.isDirectory()) {
    throw new Error(
      `project folder must be a real directory, not a symlink — refusing:\n${directory}`,
    );
  }
  const previousDirectory = process.cwd();
  try {
    changeDirectory(directory);
    const entered = lstatSync(".", { bigint: true });
    if (entered.dev !== expected.dev || entered.ino !== expected.ino) {
      throw new Error(`project folder identity changed before record creation — refusing:\n${directory}`);
    }
    writeFileSync(filename, contents, { flag: "wx" });
  } finally {
    process.chdir(previousDirectory);
  }
}

function realDirectoryState(path) {
  const directory = realpathSync(path);
  const identity = lstatSync(directory, { bigint: true });
  if (identity.isSymbolicLink() || !identity.isDirectory()) {
    throw new Error(`directory must resolve to a real folder — refusing:\n${path}`);
  }
  return { directory, identity };
}

function withBoundChildDirectory(
  root,
  expectedRoot,
  relativeDirectory,
  { create = false } = {},
  operation,
) {
  const segments = relativeDirectory === "." ? [] : relativeDirectory.split(/[\\/]/);
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`directory must stay below its bound root — refusing:\n${relativeDirectory}`);
  }
  const previousDirectory = process.cwd();
  try {
    process.chdir(root);
    if (!sameFileIdentity(expectedRoot, lstatSync(".", { bigint: true }))) {
      throw new Error(`directory identity changed before access — refusing:\n${root}`);
    }
    for (const segment of segments) {
      let identity;
      try {
        identity = lstatSync(segment, { bigint: true });
      } catch (error) {
        if (error?.code !== "ENOENT" || !create) throw error;
        mkdirSync(segment);
        identity = lstatSync(segment, { bigint: true });
      }
      if (identity.isSymbolicLink() || !identity.isDirectory()) {
        throw new Error(`child directory must be a real folder — refusing:\n${segment}`);
      }
      process.chdir(segment);
      if (!sameFileIdentity(identity, lstatSync(".", { bigint: true }))) {
        throw new Error(`child directory identity changed before access — refusing:\n${segment}`);
      }
    }
    return operation();
  } finally {
    process.chdir(previousDirectory);
  }
}

function printRecord(path, summary = recordSummary(path), reason = "") {
  const { status, updated, title } = summary;
  console.log(`${status.padEnd(11)} ${updated.padEnd(10)} ${title}`);
  console.log(`            ${path}`);
  if (reason) console.log(`            stale: ${reason}`);
}

// The locator is the one line a caller repeats verbatim once the record is
// verified to exist, so the command that verifies it is the command that
// prints it.
function locator(recordPath) {
  console.log(`Record: ${recordPath}`);
}

function commandPath(shelf, project) {
  console.log(`Shelf:   ${shelf}`);
  console.log(`Project: ${join(shelf, project)}`);
}

function commandList(shelf, project, { all = false, stale = false } = {}) {
  const projects = all
    ? (existsSync(shelf)
        ? readdirSync(shelf, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
        : [])
    : [project];
  let total = 0;
  for (const name of projects) {
    const records = listRecords(join(shelf, name))
      .map((path) => {
        const summary = recordSummary(path);
        return { path, summary, reason: staleReason(summary) };
      })
      .filter((record) => !stale || record.reason)
      .sort(
        (a, b) =>
          (a.summary.status === "superseded") - (b.summary.status === "superseded") ||
          b.summary.updated.localeCompare(a.summary.updated) ||
          a.path.localeCompare(b.path),
      );
    if (records.length === 0) continue;
    console.log(`${name}:`);
    for (const record of records) {
      printRecord(record.path, record.summary, stale ? record.reason : "");
    }
    total += records.length;
  }
  if (total === 0) {
    console.log(
      stale
        ? "No stale records — every record is current or settled cleanly (successor linked, no lane left behind)."
        : all
          ? `No records on the shelf: ${shelf}`
          : `No records for this project. Create one with: decision-shelf new "<question>"`,
    );
  }
}

// A decision that arrives already made — a scout brief, for example — is one
// record, not a create followed by a status call, so `new` accepts the status
// it should be born with.
function takeStatusFlag(rest) {
  const args = [];
  let status = null;
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === "--status") {
      status = rest[index + 1] ?? "";
      index += 1;
    } else if (value.startsWith("--status=")) {
      status = value.slice("--status=".length);
    } else args.push(value);
  }
  return { args, status };
}

function commandNew(shelf, project, question, cwd = process.cwd(), status = null) {
  if (!question) throw new Error('provide the decision question: new "<question>"');
  if (status !== null && !STATUSES.includes(status)) {
    throw new Error(`unknown status "${status}" (one of: ${STATUSES.join(", ")})`);
  }
  if (status === "superseded") {
    throw new Error("use: decision-shelf supersede <old> <new> — so the successor gets linked");
  }
  const slug = slugify(question);
  const { directory } = projectDirectoryState(shelf, project, { create: true });
  const existing = listRecords(directory).filter((path) =>
    basename(path).includes(slug),
  );
  if (existing.length > 0) {
    throw new Error(
      `a matching record already exists — resume it instead of duplicating:\n${existing.join("\n")}`,
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const path = join(directory, `${today}-${slug}.html`);
  const repository = sanitizeRepositoryIdentity(
    git(["remote", "get-url", "origin"], cwd) ||
      git(["rev-parse", "--show-toplevel"], cwd) ||
      resolve(cwd),
  );
  const head = git(["rev-parse", "HEAD"], cwd) || "UNKNOWN";
  // The template marks CLI-filled slots with delimited {{TOKEN}} placeholders
  // so no replacement can collide with the prose placeholders left for hand
  // editing (TITLES OR NONE, NONE OR GIT SHA, the YYYY-MM-DD evidence cell).
  // Every CLI-supplied value is HTML-escaped before substitution so it is
  // safe in both text nodes and double-quoted attributes; the question is
  // substituted last and never rescanned.
  const filled = readFileSync(TEMPLATE, "utf8")
    .replaceAll("{{CREATED}}", escapeHtml(today))
    .replaceAll("{{REPOSITORY}}", escapeHtml(repository))
    .replaceAll("{{BASE_HEAD}}", escapeHtml(head))
    .replaceAll("{{QUESTION}}", escapeHtml(question));
  const record = status ? statusTransforms(filled, status, path) : filled;
  // Git metadata collection runs external processes. Revalidate immediately,
  // then create relative to the bound directory identity so a concurrent
  // directory-to-symlink swap cannot redirect the write outside the shelf.
  const validated = projectDirectoryState(shelf, project);
  writeFileInDirectory(
    validated.directory,
    validated.identity,
    basename(path),
    record,
  );
  console.log(path);
}

export function extractBridgeCriteria(recordText) {
  const bridge = recordText.match(
    /<h2 id="bridge">[\s\S]*?<h3>Acceptance criteria<\/h3>\s*<ul>([\s\S]*?)<\/ul>/,
  );
  if (!bridge) return [];
  return [...bridge[1].matchAll(/<li>([\s\S]*?)<\/li>/g)]
    .map((match) => match[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim())
    .filter((criterion) => criterion && criterion !== "OBSERVABLE RESULT");
}

// A scaffold is only an executable spec if the repository's own test command
// will actually run it. Detect a node:test-based script and the directory it
// watches; any other runner or layout returns null so the caller prints the
// criteria instead of writing a file the project's checks would ignore.
// Split a shell script into command segments at ;, &, and | runs — but only
// outside quotes, so operators inside quoted text never fabricate a command
// boundary. Each segment records whether it carried unmodeled shell syntax
// (substitution, redirection, grouping); those segments prove nothing.
// Unbalanced quoting returns null outright.
function commandSegments(script) {
  const segments = [];
  let current = "";
  let tainted = false;
  let quote = null;
  // Each segment records the operator that follows it ("" for the last), so
  // callers can reason about conditional execution and exit propagation.
  const push = (separator) => {
    segments.push({ text: current, tainted, separator });
    current = "";
    tainted = false;
  };
  for (let index = 0; index < script.length; index += 1) {
    const character = script[index];
    if (quote) {
      // The shell still expands $ and backticks inside double quotes, so a
      // double-quoted token containing them says nothing about the literal
      // path; single-quoted text is genuinely literal and stays clean.
      if (quote === '"' && (character === "$" || character === "`")) {
        tainted = true;
      }
      current += character;
      if (character === quote) quote = null;
      continue;
    }
    // A backslash makes the next character literal — an escaped operator is
    // not a command boundary — and escape semantics beyond that are not
    // modeled, so the segment proves nothing.
    if (character === "\\") {
      tainted = true;
      current += character;
      if (index + 1 < script.length) {
        current += script[index + 1];
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    // An unquoted # at word start begins a comment that runs to the end of
    // its line: the shell ignores that span, so parsing must too — a runner
    // "inside" a comment would be a fabricated segment — while a command on
    // the next line is real and parses normally.
    if (character === "#" && (index === 0 || /[\s;&|(]/.test(script[index - 1]))) {
      while (index + 1 < script.length && script[index + 1] !== "\n") index += 1;
      continue;
    }
    // An unquoted newline separates commands exactly like a semicolon —
    // treating it as whitespace would let a trailing line mask the
    // runner's exit code.
    if (character === ";" || character === "\n") {
      push(";");
      continue;
    }
    if (character === "&" || character === "|") {
      if (script[index + 1] === character) {
        push(character + character);
        index += 1;
      } else {
        push(character);
      }
      continue;
    }
    if ("$`()<>".includes(character)) tainted = true;
    current += character;
  }
  if (quote) return null;
  push("");
  return segments;
}

// Tokenize a shell command segment honoring double and single quotes, so a
// quoted path with spaces stays one token. Unbalanced quoting returns null:
// what the shell would do with it is not worth guessing.
function shellTokens(segment) {
  const doubles = (segment.match(/"/g) || []).length;
  const singles = (segment.match(/'/g) || []).length;
  if (doubles % 2 !== 0 || singles % 2 !== 0) return null;
  const matched = segment.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
  const tokens = matched.map((raw) =>
    raw.replace(/"([^"]*)"|'([^']*)'/g, (whole, doubled, singled) => doubled ?? singled),
  );
  if (tokens.some((token) => token.includes('"') || token.includes("'"))) {
    return null;
  }
  return tokens;
}

export function bridgeTestTarget(cwd = process.cwd(), fileName = "") {
  const packagePath = join(cwd, "package.json");
  if (!existsSync(packagePath)) return null;
  let script = "";
  try {
    script = JSON.parse(readFileSync(packagePath, "utf8")).scripts?.test || "";
  } catch {
    return null;
  }
  // `node --test` must be the command actually executed — not text inside
  // an echo or another program's arguments — and every token before --test
  // must be an option, so --test cannot be an argument to a script entry
  // point or a value consumed by an option like --require.
  const segments = commandSegments(script);
  if (segments === null) return null;
  let paths = null;
  for (let index = 0; index < segments.length; index += 1) {
    const { text, tainted } = segments[index];
    if (tainted) continue;
    const tokens = shellTokens(text);
    if (tokens === null) continue;
    while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0])) {
      tokens.shift();
    }
    if (tokens.shift() !== "node") continue;
    const testIndex = tokens.indexOf("--test");
    if (testIndex === -1) continue;
    // Any option before --test may consume it as its own argument
    // (`node -r --test …` treats --test as -r's module path and never
    // starts the runner), so only a leading --test proves anything.
    if (testIndex !== 0) continue;
    // The scaffold promise is that a failing test fails `npm test`. That
    // holds only when the runner is reached unconditionally (`;` or `&&`
    // before it) and its exit code propagates (`&&` chains after it).
    // `||` anywhere, or `;`/pipes after the runner, break the promise.
    const beforeOps = segments.slice(0, index).map((segment) => segment.separator);
    const afterOps = segments.slice(index, -1).map((segment) => segment.separator);
    if (!beforeOps.every((op) => op === "&&" || op === ";")) continue;
    if (!afterOps.every((op) => op === "&&")) continue;
    // A preceding segment can keep the runner from executing — by
    // terminating the shell (`exit 0`, `exec …`, `eval 'exit 0'`) or, when
    // joined with &&, by merely failing (`false && node --test …`). So
    // reachability is proven per separator, never assumed: before `;` the
    // command must be one that always continues; before `&&` it must also
    // always succeed. Anything unprovable declines.
    // printf continues but can fail (`printf %d x` exits 1), so it may
    // precede `;` yet never proves an && chain.
    const PROVEN_CONTINUING = new Set([":", "true", "false", "echo", "printf", "test", "["]);
    const PROVEN_SUCCEEDING = new Set([":", "true", "echo"]);
    const unreachable = segments.slice(0, index).some((segment) => {
      if (segment.tainted) return true;
      const precedingTokens = shellTokens(segment.text);
      if (precedingTokens === null) return true;
      while (
        precedingTokens.length > 0 &&
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(precedingTokens[0])
      ) {
        precedingTokens.shift();
      }
      // A segment of pure variable assignments continues and succeeds.
      if (precedingTokens.length === 0) return false;
      const required =
        segment.separator === "&&" ? PROVEN_SUCCEEDING : PROVEN_CONTINUING;
      return !required.has(precedingTokens[0]);
    });
    if (unreachable) continue;
    paths = tokens.slice(testIndex + 1);
    break;
  }
  if (paths === null) return null;
  // Further options after --test may consume the next token as a value
  // (e.g. --test-reporter spec), so any of them makes the real test path
  // unprovable: decline rather than guess.
  if (paths.some((token) => token.startsWith("-"))) return null;
  // Bare `node --test` uses the runner's default discovery, which includes
  // the test directory.
  if (paths.length === 0) return "test";
  const first = paths[0].replace(/^["']|["']$/g, "");
  // The scaffold path is joined under cwd, so only targets inside the
  // repository are honest; absolute, home-anchored, or traversing targets
  // decline.
  if (first.startsWith("/") || first.startsWith("~")) return null;
  if (first.split("/").includes("..")) return null;
  const lastSlash = first.lastIndexOf("/");
  const directory = lastSlash === -1 ? "." : first.slice(0, lastSlash);
  const filePart = lastSlash === -1 ? first : first.slice(lastSlash + 1);
  if (/[*?[]/.test(directory)) return null;
  if (!/[*?[]/.test(filePart)) {
    // A bare path argument is loaded as a test file, not a directory to
    // discover under — `node --test spec` fails MODULE_NOT_FOUND on modern
    // Node — so a non-glob argument proves nothing about scaffolded files.
    return null;
  }
  // A glob only counts if it demonstrably matches the file we would write.
  if (filePart.includes("[")) return null;
  const pattern = new RegExp(
    `^${filePart
      .replace(/[.+^${}()|\\]/g, "\\$&")
      .replaceAll("?", "[^/]")
      .replaceAll("*", "[^/]*")}$`,
  );
  return pattern.test(fileName) ? directory : null;
}

// CLI-filled template slots land in both text nodes and double-quoted
// attributes. Escape once for both contexts so user/repo text cannot open
// tags or break out of attribute quotes.
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// Decode only the entities emitted by escapeHtml before moving parsed record
// text into a new HTML context. A single pass avoids recursively decoding
// hand-written entity text.
function decodeHtmlText(value) {
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    "#39": "'",
  };
  return String(value).replace(/&(amp|lt|gt|quot|#39);/g, (entity, name) =>
    Object.hasOwn(entities, name) ? entities[name] : entity,
  );
}

function javascriptString(value) {
  return JSON.stringify(String(value))
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

// Mutation commands may accept a basename needle or a full path, but every
// accepted record must be a regular .html file whose physical path stays
// under this project's real shelf folder.
function validateProjectRecord(shelf, project, recordPath) {
  const projectState = projectDirectoryState(shelf, project);
  const projectRoot = projectState.directory;
  let stat;
  try {
    stat = lstatSync(recordPath);
  } catch {
    throw new Error(`record not found — refusing:\n${recordPath}`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
    throw new Error(
      `record path must be a regular HTML file on the project shelf — refusing:\n${recordPath}`,
    );
  }
  let real;
  let realProject;
  try {
    real = realpathSync(recordPath);
    realProject = realpathSync(projectRoot);
  } catch {
    throw new Error(
      `record path must resolve under this project's shelf — refusing:\n${recordPath}`,
    );
  }
  if (dirname(real) !== realProject) {
    throw new Error(
      `record path is outside this project's shelf — refusing:\n${recordPath}`,
    );
  }
  if (!basename(real).endsWith(".html")) {
    throw new Error(`record path must end in .html — refusing:\n${recordPath}`);
  }
  const identity = lstatSync(recordPath, { bigint: true });
  if (
    identity.isSymbolicLink() ||
    !identity.isFile() ||
    identity.nlink !== 1n ||
    realpathSync(recordPath) !== real
  ) {
    throw new Error(`record identity changed during validation — refusing:\n${recordPath}`);
  }
  return {
    path: resolve(recordPath),
    identity,
    directory: projectState.directory,
    directoryIdentity: projectState.identity,
  };
}

function assertProjectRecord(shelf, project, recordPath) {
  return validateProjectRecord(shelf, project, recordPath).path;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function withProjectRecordDescriptor(shelf, project, recordPath, flags, operation) {
  const validated = validateProjectRecord(shelf, project, recordPath);
  const safePath = validated.path;
  const directory = validated.directory;
  const filename = basename(safePath);
  const expectedDirectory = validated.directoryIdentity;
  if (expectedDirectory.isSymbolicLink() || !expectedDirectory.isDirectory()) {
    throw new Error(`record parent must be a real directory — refusing:\n${directory}`);
  }

  const previousDirectory = process.cwd();
  let descriptor;
  try {
    process.chdir(directory);
    const enteredDirectory = lstatSync(".", { bigint: true });
    if (!sameFileIdentity(expectedDirectory, enteredDirectory)) {
      throw new Error(`record parent identity changed before access — refusing:\n${directory}`);
    }

    const beforeOpen = lstatSync(filename, { bigint: true });
    if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile() || beforeOpen.nlink !== 1n) {
      throw new Error(
        `record path must be a regular HTML file on the project shelf — refusing:\n${safePath}`,
      );
    }
    try {
      descriptor = openSync(filename, flags | (constants.O_NOFOLLOW || 0));
    } catch {
      throw new Error(
        `record path changed before it could be opened safely — refusing:\n${safePath}`,
      );
    }
    const opened = fstatSync(descriptor, { bigint: true });
    let current;
    try {
      current = lstatSync(filename, { bigint: true });
    } catch {
      throw new Error(`record path changed during safe open — refusing:\n${safePath}`);
    }
    if (
      opened.isSymbolicLink() ||
      !opened.isFile() ||
      opened.nlink !== 1n ||
      current.isSymbolicLink() ||
      !sameFileIdentity(validated.identity, beforeOpen) ||
      !sameFileIdentity(beforeOpen, opened) ||
      !sameFileIdentity(opened, current)
    ) {
      throw new Error(`record identity changed during safe open — refusing:\n${safePath}`);
    }
    return operation(descriptor, safePath);
  } finally {
    try {
      if (descriptor !== undefined) closeSync(descriptor);
    } finally {
      process.chdir(previousDirectory);
    }
  }
}

function readProjectRecord(shelf, project, recordPath) {
  return withProjectRecordDescriptor(
    shelf,
    project,
    recordPath,
    constants.O_RDONLY,
    (descriptor) => readFileSync(descriptor, "utf8"),
  );
}

function overwriteDescriptor(descriptor, contents) {
  const data = Buffer.from(contents);
  ftruncateSync(descriptor, 0);
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(descriptor, data, offset, data.length - offset, offset);
    if (written <= 0) throw new Error("record write made no progress");
    offset += written;
  }
  fsyncSync(descriptor);
}

export function mutateProjectRecord(shelf, project, recordPath, transform) {
  return withProjectRecordDescriptor(
    shelf,
    project,
    recordPath,
    constants.O_RDWR,
    (descriptor, safePath) => {
      const replacement = transform(readFileSync(descriptor, "utf8"), safePath);
      if (typeof replacement !== "string") {
        throw new Error("record mutation must return complete text");
      }
      overwriteDescriptor(descriptor, replacement);
      return replacement;
    },
  );
}

export function scaffoldBridgeTests(recordPath, criteria, cwd = process.cwd()) {
  const slug = slugify(
    basename(recordPath, ".html").replace(/^\d{4}-\d{2}-\d{2}-/, ""),
  );
  const fileName = `bridge-${slug}.test.mjs`;
  const directory = bridgeTestTarget(cwd, fileName);
  if (!directory) return null;
  const testPath = join(cwd, directory, fileName);
  const body = [
    `// Executable spec scaffolded from the decision record:`,
    `//   ${javascriptString(recordPath)}`,
    `// Each test states one acceptance criterion and fails until it is`,
    `// verified with a real assertion. Replace assert.fail, keep the name.`,
    "",
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    "",
    ...criteria.map((criterion) =>
      [
        `test(${javascriptString(criterion)}, () => {`,
        `  assert.fail(${javascriptString(`unverified: ${criterion}`)});`,
        "});",
        "",
      ].join("\n"),
    ),
  ].join("\n");
  let root;
  try {
    root = realDirectoryState(cwd);
    withBoundChildDirectory(
      root.directory,
      root.identity,
      directory,
      { create: true },
      () => writeFileSync(fileName, body, { flag: "wx" }),
    );
  } catch (error) {
    if (error?.code === "EEXIST") throw error;
    return null;
  }
  return testPath;
}

function resolveRecord(shelf, project, query, usage) {
  if (!query) throw new Error(`provide a record path or name: ${usage}`);
  if (query.endsWith(".html") && existsSync(query)) {
    return assertProjectRecord(shelf, project, resolve(query));
  }
  const needle = query.toLowerCase();
  const matches = listRecords(join(shelf, project)).filter((path) =>
    basename(path).toLowerCase().includes(needle),
  );
  if (matches.length === 0) {
    throw new Error(`no record matching "${query}" for this project (see: decision-shelf list)`);
  }
  if (matches.length > 1) {
    throw new Error(`"${query}" matches several records — use a full path:\n${matches.join("\n")}`);
  }
  return assertProjectRecord(shelf, project, matches[0]);
}

// Records are hand-edited HTML, so every pattern a mutation will touch is
// verified up front; a record missing the expected structure is refused
// rather than partially rewritten.
function statusTransforms(text, status, recordPath) {
  const today = new Date().toISOString().slice(0, 10);
  // The visible Updated row is validated and replaced within the header
  // specifically — a duplicate row in another list must neither satisfy
  // the preflight nor receive the mutation.
  const headerText = text.match(/<header>[\s\S]*?<\/header>/)?.[0];
  const required = [
    /data-status="[^"]*"/,
    /<p class="status">[^<]*<\/p>/,
    /data-updated="[^"]*"/,
  ];
  if (
    !headerText ||
    !/<dt>Updated<\/dt><dd>[^<]*<\/dd>/.test(headerText) ||
    !required.every((pattern) => pattern.test(text))
  ) {
    throw new Error(
      `record is missing expected structure (data-status, status chip, data-updated, header Updated row) — edit it by hand:\n${recordPath}`,
    );
  }
  const patchedHeader = headerText.replace(
    /(<dt>Updated<\/dt><dd>)[^<]*(<\/dd>)/,
    `$1${today}$2`,
  );
  return text
    .replace(headerText, () => patchedHeader)
    .replace(/data-status="[^"]*"/, `data-status="${status}"`)
    .replace(/(<p class="status">)[^<]*(<\/p>)/, `$1${status}$2`)
    .replace(/data-updated="[^"]*"/, `data-updated="${today}"`);
}

// A record outlives the path its project sat at: a repository that moved, was
// cloned, or was renamed still has its earlier record on the shelf. Reading
// one is safe anywhere under the shelf, so the read-only resume view widens to
// a unique shelf-wide match; every mutation stays bound to this project.
function resolveReadableRecord(shelf, project, query, usage) {
  try {
    return resolveRecord(shelf, project, query, usage);
  } catch (error) {
    const needle = basename(query).toLowerCase();
    if (!needle) throw error;
    const matches = (existsSync(shelf)
      ? readdirSync(shelf, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .flatMap((entry) => listRecords(join(shelf, entry.name)))
      : []
    ).filter((path) => basename(path).toLowerCase().includes(needle));
    if (matches.length !== 1) throw error;
    return matches[0];
  }
}

// Resuming is a read: it reports what the record says right now, so the caller
// can refresh live repository state against it before trusting anything.
function commandResume(shelf, project, rest) {
  const query = rest.join(" ").trim();
  if (!query) throw new Error("provide a record: status <record> [status]");
  const recordPath = resolveReadableRecord(shelf, project, query, "status <record>");
  const summary = recordSummary(recordPath);
  printRecord(recordPath, summary, staleReason(summary) || "");
  locator(recordPath);
}

function commandStatus(shelf, project, rest) {
  if (rest.length === 1) return commandResume(shelf, project, rest);
  const status = rest[rest.length - 1];
  const query = rest.slice(0, -1).join(" ").trim();
  if (!query || !status) {
    throw new Error("provide a record and a status: status <record> <status>");
  }
  if (!STATUSES.includes(status)) {
    throw new Error(`unknown status "${status}" (one of: ${STATUSES.join(", ")})`);
  }
  if (status === "superseded") {
    throw new Error("use: decision-shelf supersede <old> <new> — so the successor gets linked");
  }
  const recordPath = resolveRecord(shelf, project, query, "status <record> <status>");
  mutateProjectRecord(shelf, project, recordPath, (text, safePath) => {
    // Leaving superseded would strand the successor link as stale metadata,
    // and commandSupersede could never repair the lifecycle afterwards — so
    // the transition is refused rather than partially rewritten.
    if (/data-status="superseded"/.test(text)) {
      throw new Error(
        `record is superseded — create a new record instead, or edit it by hand:\n${safePath}`,
      );
    }
    return statusTransforms(text, status, safePath);
  });
  console.log(`${status}: ${recordPath}`);
}

function commandSupersede(shelf, project, rest) {
  if (rest.length !== 2) {
    throw new Error("provide both records: supersede <old> <new>");
  }
  const usage = "supersede <old> <new>";
  const oldPath = resolveRecord(shelf, project, rest[0], usage);
  const newPath = resolveRecord(shelf, project, rest[1], usage);
  if (oldPath === newPath) throw new Error("a record cannot supersede itself");
  const successor = recordSummaryFromText(
    readProjectRecord(shelf, project, newPath),
    newPath,
  );
  const href =
    dirname(oldPath) === dirname(newPath)
      ? `./${encodeURIComponent(basename(newPath))}`
      : pathToFileURL(newPath).href;
  const anchor = `<a href="${escapeHtml(href)}">${escapeHtml(successor.title)}</a>`;
  mutateProjectRecord(shelf, project, oldPath, (text, safePath) => {
    // The successor row belongs in the header's list specifically. Detection,
    // repair, and insertion are all scoped there: a row outside the header —
    // or a bare "</dl>" that belongs to the Bridge — would leave the header
    // without its successor while the record still flips to superseded, so
    // misplaced structure is refused before any mutation.
    const rowPattern = /<dt>Superseded by<\/dt>\s*<dd>([\s\S]*?)<\/dd>/;
    const headerText = text.match(/<header>[\s\S]*?<\/header>/)?.[0];
    const existing = headerText ? headerText.match(rowPattern) : null;
    if (!existing && rowPattern.test(text)) {
      throw new Error(
        `a Superseded by row exists outside the record's header — edit it by hand:\n${safePath}`,
      );
    }
    // Only a valid successor anchor means "already superseded". A field label
    // with an empty or plain-text value is exactly the malformed state that
    // list --stale reports, so supersede repairs that row in place — refusing
    // it would leave the CLI unable to fix the condition it diagnoses.
    if (existing && SUCCESSOR_ANCHOR.test(existing[1])) {
      throw new Error(
        `already superseded — edit it by hand if the successor changed:\n${safePath}`,
      );
    }
    if (!headerText || (!existing && !headerText.includes("</dl>"))) {
      throw new Error(`record is missing its header list — edit it by hand:\n${safePath}`);
    }
    const transformed = statusTransforms(text, "superseded", safePath);
    const transformedHeader = transformed.match(/<header>[\s\S]*?<\/header>/)[0];
    const patched = existing
      ? transformedHeader.replace(
          rowPattern,
          () => `<dt>Superseded by</dt><dd>${anchor}</dd>`,
        )
      : transformedHeader.replace(
          "</dl>",
          `  <dt>Superseded by</dt><dd>${anchor}</dd>\n      </dl>`,
        );
    return transformed.replace(transformedHeader, () => patched);
  });
  console.log(`superseded: ${oldPath}`);
  console.log(`by:         ${newPath}`);
}

const PROTO_USAGE = "proto <record> <new [variant] | view | promote <variant> | clean>";

function laneVariants(lane) {
  return readdirSync(lane, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function withOwnedLane(recordState, { create = false, remove = false } = {}, operation) {
  const lane = lanePath(recordState.path);
  const laneName = basename(lane);
  return withBoundChildDirectory(
    recordState.directory,
    recordState.directoryIdentity,
    ".",
    {},
    () => {
      let created = false;
      let laneIdentity;
      try {
        laneIdentity = lstatSync(laneName, { bigint: true });
      } catch (error) {
        if (error?.code !== "ENOENT" || !create) {
          if (error?.code === "ENOENT" && remove) {
            throw new Error(`no prototype lane to remove for:\n${recordState.path}`);
          }
          throw new Error(`no prototype lane for this record — create one: proto <record> new [variant]`);
        }
        mkdirSync(laneName);
        created = true;
        laneIdentity = lstatSync(laneName, { bigint: true });
      }
      if (laneIdentity.isSymbolicLink() || !laneIdentity.isDirectory()) {
        throw new Error(`lane path is a symlink or non-directory — refusing to touch it:\n${lane}`);
      }

      const projectIdentity = lstatSync(".", { bigint: true });
      const result = withBoundChildDirectory(
        ".",
        projectIdentity,
        laneName,
        {},
        () => {
          if (created) {
            writeFileSync(
              LANE_MARKER,
              `${JSON.stringify({ record: laneRecordId(recordState.path), owner: "decision-shelf proto" })}\n`,
              { flag: "wx" },
            );
          } else if (!laneMarkerValid(".", recordState.path)) {
            throw new Error(
              `a directory exists at the lane path but was not created by proto for this record — refusing to touch it:\n${lane}`,
            );
          }
          return operation({ lane, created });
        },
      );

      if (remove) {
        const current = lstatSync(laneName, { bigint: true });
        if (!sameFileIdentity(laneIdentity, current)) {
          throw new Error(`lane identity changed before cleanup — refusing:\n${lane}`);
        }
        const trash = `.decision-shelf-quarantine-${randomUUID()}`;
        renameSync(laneName, trash);
        const quarantined = lstatSync(trash, { bigint: true });
        if (!sameFileIdentity(laneIdentity, quarantined)) {
          if (!existsSync(laneName)) renameSync(trash, laneName);
          throw new Error(`lane identity changed during cleanup — refusing:\n${lane}`);
        }
        return {
          result,
          quarantine: join(recordState.directory, trash),
        };
      }
      return result;
    },
  );
}

// One line per variant: the name to promote, and the URL to open.
function printVariants(lane, variants) {
  const width = Math.max(...variants.map((name) => name.length));
  for (const name of variants) {
    const entry = join(lane, name, "index.html");
    const target = existsSync(entry) ? pathToFileURL(entry).href : join(lane, name);
    console.log(`${name.padEnd(width)}   ${target}`);
  }
}

function commandProto(shelf, project, rest) {
  const [recordQuery, action, ...args] = rest;
  if (!recordQuery || !action) throw new Error(`usage: ${PROTO_USAGE}`);
  const resolvedRecord = resolveRecord(shelf, project, recordQuery, PROTO_USAGE);
  const recordState = validateProjectRecord(shelf, project, resolvedRecord);
  const recordPath = recordState.path;
  const lane = lanePath(recordPath);
  const variantArg = slugify(args.join(" ").trim() || "");
  // Variants are compared side by side, so `new` takes them all at once: one
  // command builds the whole comparison and prints how to view each one.
  const variantNames = args.map((name) => slugify(name)).filter(Boolean);

  if (action === "new") {
    const entries = withOwnedLane(recordState, { create: true }, ({ lane: boundLane }) => {
      if (!variantNames.length) return [boundLane];
      if (new Set(variantNames).size !== variantNames.length) {
        throw new Error(`name each variant once: ${variantNames.join(" ")}`);
      }
      // Preflight every name before writing anything, so a clashing variant
      // refuses the whole command instead of leaving half a comparison.
      for (const name of variantNames) {
        if (existsSync(name)) {
          throw new Error(`variant already exists: ${join(boundLane, name)}`);
        }
      }
      const laneIdentity = lstatSync(".", { bigint: true });
      return variantNames.map((name) =>
        withBoundChildDirectory(".", laneIdentity, name, { create: true }, () => {
          writeFileSync(
            "index.html",
            [
              "<!doctype html>",
              '<meta charset="utf-8">',
              `<title>${name} — disposable prototype</title>`,
              `<p>Disposable prototype variant "${name}". Replace this stub;`,
              "the lane is deleted after the decision — durable outcome goes in the record.</p>",
              "",
            ].join("\n"),
            { flag: "wx" },
          );
          return join(boundLane, name, "index.html");
        }),
      );
    });
    // A comparison is built to be opened, so creating several variants ends
    // with the same viewable lines `view` prints; a single variant or a bare
    // lane just reports what was created.
    if (variantNames.length > 1) {
      printVariants(lane, variantNames);
      locator(recordPath);
    } else for (const entry of entries) console.log(entry);
  } else if (action === "view") {
    const variants = withOwnedLane(recordState, {}, () => laneVariants("."));
    if (variants.length === 0) {
      console.log(`(empty lane) ${lane}`);
      return;
    }
    printVariants(lane, variants);
    locator(recordPath);
  } else if (action === "promote") {
    if (!args.length) throw new Error(`provide the surviving variant: ${PROTO_USAGE}`);
    const directory = join(lane, variantArg);
    // Only a real variant directory can be promoted — a plain file or a
    // symlink at that path is not something view would ever list.
    withOwnedLane(recordState, {}, () => {
      let variantStat = null;
      try {
        variantStat = lstatSync(variantArg);
      } catch {
        variantStat = null;
      }
      if (!variantStat || variantStat.isSymbolicLink() || !variantStat.isDirectory()) {
        throw new Error(
          `no variant "${variantArg}" in the lane (see: decision-shelf proto <record> view)`,
        );
      }
    });
    // One read, full preflight, one write: a record missing any field the
    // promotion touches is refused, never partially rewritten. Each field
    // is validated and patched inside its owning section — the evidence row
    // in the comparison table, the Prototype field in the Bridge, the
    // visible date in the header — so a duplicate label elsewhere neither
    // satisfies the preflight nor receives the mutation.
    mutateProjectRecord(shelf, project, recordPath, (text, safePath) => {
      const comparison = text.match(
        /<section aria-labelledby="comparison">[\s\S]*?<\/section>/,
      );
      const bridge = text.match(/<section aria-labelledby="bridge">[\s\S]*?<\/section>/);
      const headerText = text.match(/<header>[\s\S]*?<\/header>/)?.[0];
      if (
        !comparison ||
        !comparison[0].includes("</tbody>") ||
        !bridge ||
        !/<dt>Prototype<\/dt><dd>[\s\S]*?<\/dd>/.test(bridge[0]) ||
        !headerText ||
        !/<dt>Updated<\/dt><dd>[^<]*<\/dd>/.test(headerText) ||
        !/data-updated="[^"]*"/.test(text)
      ) {
        throw new Error(
          `record is missing expected structure (Bridge Prototype field, Options and evidence table, data-updated, header Updated row) — edit it by hand:\n${safePath}`,
        );
      }
      const today = new Date().toISOString().slice(0, 10);
      const relative = `./${basename(lane)}/${variantArg}/`;
      const relativeHtml = escapeHtml(relative);
      const row =
        `          <tr><td>Prototype: ${variantArg}</td><td>${relativeHtml}</td>` +
        `<td>${today}</td><td>Promoted surviving variant from the proto lane</td></tr>\n        </tbody>`;
      const patchedComparison = comparison[0].replace(/(\s*)<\/tbody>/, `\n${row}`);
      const patchedBridge = bridge[0].replace(
        /(<dt>Prototype<\/dt><dd>)[\s\S]*?(<\/dd>)/,
        `$1${relativeHtml}$2`,
      );
      const patchedHeader = headerText.replace(
        /(<dt>Updated<\/dt><dd>)[^<]*(<\/dd>)/,
        `$1${today}$2`,
      );
      return text
        .replace(comparison[0], () => patchedComparison)
        .replace(bridge[0], () => patchedBridge)
        .replace(headerText, () => patchedHeader)
        .replace(/data-updated="[^"]*"/, `data-updated="${today}"`);
    });
    console.log(`promoted: ${variantArg}`);
    console.log(`record updated: ${recordPath}`);
  } else if (action === "clean") {
    const cleaned = withOwnedLane(
      recordState,
      { remove: true },
      () => laneVariants(".").length,
    );
    console.log(
      `removed ${lane} (${cleaned.result} variant${cleaned.result === 1 ? "" : "s"})`,
    );
    console.log(`recoverable quarantine: ${cleaned.quarantine}`);
  } else {
    throw new Error(`unknown proto action: ${action} (usage: ${PROTO_USAGE})`);
  }
}

function commandBridge(shelf, project, query, cwd = process.cwd()) {
  const recordPath = resolveRecord(shelf, project, query, "bridge <record>");
  const criteria = extractBridgeCriteria(readProjectRecord(shelf, project, recordPath));
  if (criteria.length === 0) {
    throw new Error(
      `the record's Bridge has no concrete acceptance criteria yet — edit it first:\n${recordPath}`,
    );
  }
  const testPath = scaffoldBridgeTests(recordPath, criteria, cwd);
  if (testPath) {
    console.log(testPath);
    console.log(
      "Scaffolded failing tests, one per acceptance criterion. They must stay red until each criterion is genuinely verified.",
    );
  } else {
    console.log(
      "No node:test-based test script detected here — write these criteria as failing tests in this repository's framework:",
    );
    for (const criterion of criteria) console.log(`- ${criterion}`);
  }
}

function commandFind(shelf, text) {
  if (!text) throw new Error("provide text to find: find <text>");
  const needle = text.toLowerCase();
  const matches = [];
  if (existsSync(shelf)) {
    for (const entry of readdirSync(shelf, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      for (const record of listRecords(join(shelf, entry.name))) {
        if (
          basename(record).toLowerCase().includes(needle) ||
          readFileSync(record, "utf8").toLowerCase().includes(needle)
        ) {
          matches.push(record);
        }
      }
    }
  }
  if (matches.length === 0) console.log("No matching records.");
  for (const record of matches) printRecord(record);
}

const PLAN_TREE_PATTERN = /<section\b[^>]*id="plan-tree"[^>]*>[\s\S]*?<\/section>/;
const PLAN_BRANCHES_PATTERN =
  /<ul\b[^>]*class="plan-branches"[^>]*>[\s\S]*?<\/ul>/;
const PLAN_CURRENT_PATTERN =
  /<ul\b[^>]*class="plan-current-changes"[^>]*>[\s\S]*?<\/ul>/;
const PLAN_HISTORY_PATTERN =
  /<ol\b[^>]*class="plan-history"[^>]*>[\s\S]*?<\/ol>/;

function uniquePlanMatch(text, pattern, label, recordPath) {
  const flags = `${pattern.flags.replaceAll("g", "")}g`;
  const matches = [...text.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length !== 1) {
    throw new Error(
      `record plan tree must contain exactly one ${label} — edit it by hand:\n${recordPath}`,
    );
  }
  return matches[0];
}

function planRecordState(text, recordPath) {
  const article = uniquePlanMatch(text, /<article\b[^>]*>/, "article header", recordPath)[0];
  const status = article.match(/data-status="([^"]*)"/)?.[1];
  if (status !== "selected") {
    throw new Error(
      `plan changes require a selected record; found ${status || "unknown"}:\n${recordPath}`,
    );
  }
  const revision = Number(article.match(/data-plan-revision="(\d+)"/)?.[1]);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error(`record has no valid plan revision — edit it by hand:\n${recordPath}`);
  }
  const tree = uniquePlanMatch(text, PLAN_TREE_PATTERN, "plan-tree section", recordPath)[0];
  const currentRevision = uniquePlanMatch(
    tree,
    /<span\b[^>]*data-current-revision[^>]*>\s*(\d+)\s*<\/span>/,
    "current revision marker",
    recordPath,
  );
  if (Number(currentRevision[1]) !== revision) {
    throw new Error(`record plan revisions disagree — edit it by hand:\n${recordPath}`);
  }
  return {
    article,
    branches: uniquePlanMatch(tree, PLAN_BRANCHES_PATTERN, "open branch list", recordPath)[0],
    current: uniquePlanMatch(tree, PLAN_CURRENT_PATTERN, "current change list", recordPath)[0],
    currentRevision: currentRevision[0],
    history: uniquePlanMatch(tree, PLAN_HISTORY_PATTERN, "plan history", recordPath)[0],
    revision,
    tree,
  };
}

function appendPlanItem(list, item, recordPath) {
  const closing = list.match(/(\s*)<\/(ul|ol)>\s*$/);
  if (!closing) {
    throw new Error(`record plan list has no closing tag — edit it by hand:\n${recordPath}`);
  }
  const spacing = closing[1].includes("\n") ? closing[1] : "\n          ";
  return `${list.slice(0, closing.index)}${spacing}${item}${spacing}</${closing[2]}>`;
}

function mutatePlanRecord(shelf, project, recordPath, transform, mutate) {
  let output;
  mutate(shelf, project, recordPath, (text, safePath) => {
    const result = transform(text, planRecordState(text, safePath), safePath);
    if (!result || typeof result.text !== "string") {
      throw new Error("plan mutation must return complete record text");
    }
    output = result.output;
    return result.text;
  });
  return output;
}

function proposalPattern(id) {
  return new RegExp(
    `<li data-proposal-id="${id}" data-proposal-status="open">([\\s\\S]*?)<\\/li>`,
  );
}

function proposalText(item) {
  return item
    .replace(/<strong>P\d+<\/strong>\s*·\s*/, "")
    .replace(/<span class="proposal-status">[\s\S]*?<\/span>/, "")
    .replace(/<[^>]+>/g, "")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&")
    .replace(/\s+/g, " ")
    .trim();
}

function touchSelected(text, recordPath) {
  return statusTransforms(text, "selected", recordPath);
}

export function proposePlan(
  shelf,
  project,
  recordPath,
  change,
  mutate = mutateProjectRecord,
) {
  return mutatePlanRecord(
    shelf,
    project,
    recordPath,
    (text, plan, safePath) => {
      const ids = [...plan.branches.matchAll(/data-proposal-id="P(\d+)"/g)].map((match) =>
        Number(match[1]),
      );
      const id = `P${Math.max(0, ...ids) + 1}`;
      const item = `<li data-proposal-id="${id}" data-proposal-status="open"><strong>${id}</strong> · ${escapeHtml(change)} <span class="proposal-status">open</span></li>`;
      const withoutEmpty = plan.branches.replace(
        /\s*<li class="empty">[\s\S]*?<\/li>/,
        "",
      );
      const branches = appendPlanItem(withoutEmpty, item, safePath);
      const tree = plan.tree.replace(plan.branches, () => branches);
      return {
        output: { change, id },
        text: touchSelected(text.replace(plan.tree, () => tree), safePath),
      };
    },
    mutate,
  );
}

function commandPropose(shelf, project, rest) {
  const [query, ...changeParts] = rest;
  const change = changeParts.join(" ").trim();
  if (!query || !change) throw new Error('usage: propose <record> "<change>"');
  const recordPath = resolveRecord(shelf, project, query, 'propose <record> "<change>"');
  const result = proposePlan(shelf, project, recordPath, change);
  console.log(`${result.id}: ${result.change}`);
  console.log(recordPath);
}

export function checkpointPlan(
  shelf,
  project,
  recordPath,
  id,
  mutate = mutateProjectRecord,
) {
  return mutatePlanRecord(
    shelf,
    project,
    recordPath,
    (text, plan, safePath) => {
      const pattern = proposalPattern(id);
      const match = plan.branches.match(pattern);
      if (!match) throw new Error(`open proposal ${id} was not found:\n${safePath}`);
      const nextRevision = plan.revision + 1;
      const change = proposalText(match[1]);
      let branches = plan.branches.replace(pattern, "");
      if (!/data-proposal-status="open"/.test(branches)) {
        branches = appendPlanItem(
          branches,
          '<li class="empty">No open branches</li>',
          safePath,
        );
      }
      const current = appendPlanItem(
        plan.current,
        `<li data-accepted-revision="${nextRevision}">${escapeHtml(change)}</li>`,
        safePath,
      );
      const history = appendPlanItem(
        plan.history,
        `<li data-plan-revision="${nextRevision}">Revision ${nextRevision} · accepted ${escapeHtml(change)}</li>`,
        safePath,
      );
      const tree = plan.tree
        .replace(plan.branches, () => branches)
        .replace(plan.current, () => current)
        .replace(
          plan.currentRevision,
          () => `<span data-current-revision>${nextRevision}</span>`,
        )
        .replace(plan.history, () => history);
      const article = plan.article.replace(
        /data-plan-revision="\d+"/,
        `data-plan-revision="${nextRevision}"`,
      );
      const next = text
        .replace(plan.article, () => article)
        .replace(plan.tree, () => tree);
      return {
        output: { change, id, revision: nextRevision },
        text: touchSelected(next, safePath),
      };
    },
    mutate,
  );
}

function commandCheckpoint(shelf, project, rest) {
  const [query, rawId] = rest;
  const id = rawId?.toUpperCase();
  if (!query || !/^P\d+$/.test(id || "") || rest.length !== 2) {
    throw new Error("usage: checkpoint <record> <proposal-id>");
  }
  const recordPath = resolveRecord(shelf, project, query, "checkpoint <record> <proposal-id>");
  const result = checkpointPlan(shelf, project, recordPath, id);
  console.log(`revision ${result.revision}: accepted ${result.id}`);
  console.log(recordPath);
}

export function rejectPlan(
  shelf,
  project,
  recordPath,
  id,
  reason,
  mutate = mutateProjectRecord,
) {
  return mutatePlanRecord(
    shelf,
    project,
    recordPath,
    (text, plan, safePath) => {
      const pattern = proposalPattern(id);
      const match = plan.branches.match(pattern);
      if (!match) throw new Error(`open proposal ${id} was not found:\n${safePath}`);
      const change = proposalText(match[1]);
      let branches = plan.branches.replace(pattern, "");
      if (!/data-proposal-status="open"/.test(branches)) {
        branches = appendPlanItem(
          branches,
          '<li class="empty">No open branches</li>',
          safePath,
        );
      }
      const history = appendPlanItem(
        plan.history,
        `<li data-rejected-proposal="${id}">Rejected ${id} · ${escapeHtml(change)} — ${escapeHtml(reason)}</li>`,
        safePath,
      );
      const tree = plan.tree
        .replace(plan.branches, () => branches)
        .replace(plan.history, () => history);
      return {
        output: { change, id, reason },
        text: touchSelected(text.replace(plan.tree, () => tree), safePath),
      };
    },
    mutate,
  );
}

function commandReject(shelf, project, rest) {
  const [query, rawId, ...reasonParts] = rest;
  const id = rawId?.toUpperCase();
  const reason = reasonParts.join(" ").trim();
  if (!query || !/^P\d+$/.test(id || "") || !reason) {
    throw new Error('usage: reject <record> <proposal-id> "<reason>"');
  }
  const recordPath = resolveRecord(shelf, project, query, 'reject <record> <proposal-id> "<reason>"');
  const result = rejectPlan(shelf, project, recordPath, id, reason);
  console.log(`rejected ${result.id}: ${result.reason}`);
  console.log(recordPath);
}

function commandView(shelf, project, query) {
  const recordPath = resolveRecord(shelf, project, query, "view <record>");
  if (!PLAN_TREE_PATTERN.test(readProjectRecord(shelf, project, recordPath))) {
    throw new Error(`record has no visual plan tree:\n${recordPath}`);
  }
  console.log(recordPath);
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(HELP);
    return;
  }
  const shelf = resolveShelf();
  const project = projectFolder();
  if (command === "path") commandPath(shelf, project);
  else if (command === "list")
    commandList(shelf, project, {
      all: rest.includes("--all"),
      stale: rest.includes("--stale"),
    });
  else if (command === "new") {
    const { args, status } = takeStatusFlag(rest);
    commandNew(shelf, project, args.join(" ").trim(), process.cwd(), status);
  }
  else if (command === "status") commandStatus(shelf, project, rest);
  else if (command === "supersede") commandSupersede(shelf, project, rest);
  else if (command === "proto") commandProto(shelf, project, rest);
  else if (command === "find") commandFind(shelf, rest.join(" ").trim());
  else if (command === "propose") commandPropose(shelf, project, rest);
  else if (command === "checkpoint") commandCheckpoint(shelf, project, rest);
  else if (command === "reject") commandReject(shelf, project, rest);
  else if (command === "view") commandView(shelf, project, rest.join(" ").trim());
  else if (command === "bridge") commandBridge(shelf, project, rest.join(" ").trim());
  else throw new Error(`unknown command: ${command} (try: decision-shelf help)`);
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(`decision-shelf: ${error.message}`);
    process.exitCode = 1;
  }
}

export { STATUSES };
