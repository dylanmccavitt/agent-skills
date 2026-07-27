#!/usr/bin/env node

// The decision shelf: durable, agent-agnostic decision records kept outside
// every repository. This CLI is the interface; its help text is the manual.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  decision-shelf new "<question>"   Create a record for one decision, print its path
  decision-shelf status <record> <status>
                                     Set a record's status (updates the chip,
                                     data-status, and updated date together)
  decision-shelf supersede <old> <new>
                                     Mark <old> superseded and link its successor
  decision-shelf find <text>         Find records matching text in name or content
  decision-shelf bridge <record>     Turn a record's acceptance criteria into failing tests
  decision-shelf proto <record> new [variant]
                                     Create the record's disposable prototype lane
                                     beside it (and a variant folder with a stub)
  decision-shelf proto <record> view Print one URL or path per variant
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
  - Finish agent responses that touched the shelf with one locator line:
    "Record: /absolute/path.html" (verified) or "Record: none".

Location: $DECISION_SHELF_HOME, else $XDG_DATA_HOME/decision-shelf, else
~/.local/share/decision-shelf.
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

export function resolveShelf(env = process.env, home = homedir()) {
  if (env.DECISION_SHELF_HOME) return resolve(env.DECISION_SHELF_HOME);
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  return join(dataHome, "decision-shelf");
}

export function projectFolder(cwd = process.cwd()) {
  const remote = git(["remote", "get-url", "origin"], cwd);
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
  const root = git(["rev-parse", "--show-toplevel"], cwd) || resolve(cwd);
  const hash = createHash("sha256").update(root).digest("hex").slice(0, 8);
  return `local--${basename(root)}--${hash}`;
}

function recordSummary(path) {
  const text = readFileSync(path, "utf8");
  const status = text.match(/data-status="([^"]*)"/)?.[1] || "unknown";
  const updated = text.match(/data-updated="([^"]*)"/)?.[1] || "";
  const title = text.match(/<h1>([^<]*)<\/h1>/)?.[1] || basename(path);
  // Only an actual successor anchor in the record's header counts as
  // linked — a hand-edited label with empty or plain-text content, or a
  // row misplaced outside the header, still leaves the record stale.
  const header = text.match(/<header>[\s\S]*?<\/header>/)?.[0] || "";
  const successor = header.match(/<dt>Superseded by<\/dt>\s*<dd>([\s\S]*?)<\/dd>/);
  const linked = Boolean(successor && SUCCESSOR_ANCHOR.test(successor[1]));
  const lane = laneOwned(lanePath(path), path);
  return { status, updated, title, linked, lane };
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
// symlinked or malformed marker, proves nothing and is refused.
function laneMarkerValid(lane, recordPath) {
  try {
    if (!lstatSync(join(lane, LANE_MARKER)).isFile()) return false;
    const marker = JSON.parse(readFileSync(join(lane, LANE_MARKER), "utf8"));
    return (
      marker.owner === "decision-shelf proto" && marker.record === basename(recordPath)
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
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".html"))
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

function printRecord(path, summary = recordSummary(path), reason = "") {
  const { status, updated, title } = summary;
  console.log(`${status.padEnd(11)} ${updated.padEnd(10)} ${title}`);
  console.log(`            ${path}`);
  if (reason) console.log(`            stale: ${reason}`);
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

function commandNew(shelf, project, question, cwd = process.cwd()) {
  if (!question) throw new Error('provide the decision question: new "<question>"');
  const slug = slugify(question);
  const directory = join(shelf, project);
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
  const repository =
    git(["remote", "get-url", "origin"], cwd) ||
    git(["rev-parse", "--show-toplevel"], cwd) ||
    resolve(cwd);
  const head = git(["rev-parse", "HEAD"], cwd) || "UNKNOWN";
  // The template marks CLI-filled slots with delimited {{TOKEN}} placeholders
  // so no replacement can collide with the prose placeholders left for hand
  // editing (TITLES OR NONE, NONE OR GIT SHA, the YYYY-MM-DD evidence cell).
  // The question is user text, so it is substituted last and never rescanned.
  const record = readFileSync(TEMPLATE, "utf8")
    .replaceAll("{{CREATED}}", today)
    .replaceAll("{{REPOSITORY}}", repository)
    .replaceAll("{{BASE_HEAD}}", head)
    .replaceAll("{{QUESTION}}", question);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path, record, { flag: "wx" });
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

// Lexical checks cannot see symlinks: a target directory that physically
// resolves outside the repository would let the scaffold write escape it.
// Resolve the deepest existing ancestor and require it to stay under the
// repository root; the still-missing components below it cannot be links.
function physicallyInside(base, directory) {
  let probe = resolve(base, directory);
  while (!existsSync(probe)) probe = dirname(probe);
  let real;
  let realBase;
  try {
    real = realpathSync(probe);
    realBase = realpathSync(base);
  } catch {
    return false;
  }
  return real === realBase || real.startsWith(`${realBase}${sep}`);
}

export function scaffoldBridgeTests(recordPath, criteria, cwd = process.cwd()) {
  const slug = basename(recordPath, ".html").replace(/^\d{4}-\d{2}-\d{2}-/, "");
  const fileName = `bridge-${slug}.test.mjs`;
  const directory = bridgeTestTarget(cwd, fileName);
  if (!directory) return null;
  if (!physicallyInside(cwd, directory)) return null;
  const testPath = join(cwd, directory, fileName);
  const body = [
    `// Executable spec scaffolded from the decision record:`,
    `//   ${recordPath}`,
    `// Each test states one acceptance criterion and fails until it is`,
    `// verified with a real assertion. Replace assert.fail, keep the name.`,
    "",
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    "",
    ...criteria.map((criterion) =>
      [
        `test(${JSON.stringify(criterion)}, () => {`,
        `  assert.fail(${JSON.stringify(`unverified: ${criterion}`)});`,
        "});",
        "",
      ].join("\n"),
    ),
  ].join("\n");
  mkdirSync(join(cwd, directory), { recursive: true });
  writeFileSync(testPath, body, { flag: "wx" });
  return testPath;
}

function resolveRecord(shelf, project, query, usage) {
  if (!query) throw new Error(`provide a record path or name: ${usage}`);
  if (query.endsWith(".html") && existsSync(query)) return resolve(query);
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
  return matches[0];
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

function commandStatus(shelf, project, rest) {
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
  const text = readFileSync(recordPath, "utf8");
  // Leaving superseded would strand the successor link as stale metadata,
  // and commandSupersede could never repair the lifecycle afterwards — so
  // the transition is refused rather than partially rewritten.
  if (/data-status="superseded"/.test(text)) {
    throw new Error(
      `record is superseded — create a new record instead, or edit it by hand:\n${recordPath}`,
    );
  }
  writeFileSync(recordPath, statusTransforms(text, status, recordPath));
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
  const text = readFileSync(oldPath, "utf8");
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
      `a Superseded by row exists outside the record's header — edit it by hand:\n${oldPath}`,
    );
  }
  // Only a valid successor anchor means "already superseded". A field label
  // with an empty or plain-text value is exactly the malformed state that
  // list --stale reports, so supersede repairs that row in place — refusing
  // it would leave the CLI unable to fix the condition it diagnoses.
  if (existing && SUCCESSOR_ANCHOR.test(existing[1])) {
    throw new Error(`already superseded — edit it by hand if the successor changed:\n${oldPath}`);
  }
  if (!headerText || (!existing && !headerText.includes("</dl>"))) {
    throw new Error(`record is missing its header list — edit it by hand:\n${oldPath}`);
  }
  const successor = recordSummary(newPath);
  const href = dirname(oldPath) === dirname(newPath) ? basename(newPath) : newPath;
  const anchor = `<a href="${href}">${successor.title}</a>`;
  const transformed = statusTransforms(text, "superseded", oldPath);
  const transformedHeader = transformed.match(/<header>[\s\S]*?<\/header>/)[0];
  const patched = existing
    ? transformedHeader.replace(rowPattern, () => `<dt>Superseded by</dt><dd>${anchor}</dd>`)
    : transformedHeader.replace(
        "</dl>",
        `  <dt>Superseded by</dt><dd>${anchor}</dd>\n      </dl>`,
      );
  writeFileSync(oldPath, transformed.replace(transformedHeader, () => patched));
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

function commandProto(shelf, project, rest) {
  const [recordQuery, action, ...args] = rest;
  if (!recordQuery || !action) throw new Error(`usage: ${PROTO_USAGE}`);
  const recordPath = resolveRecord(shelf, project, recordQuery, PROTO_USAGE);
  const lane = lanePath(recordPath);
  const variantArg = slugify(args.join(" ").trim() || "");

  // Anything on disk at the lane path — including a dangling symlink —
  // counts as present; whether it is ours is a separate, marker-backed
  // question. The filename alone never proves ownership.
  let laneOnDisk = true;
  try {
    lstatSync(lane);
  } catch {
    laneOnDisk = false;
  }
  const requireOwned = () => {
    if (lstatSync(lane).isSymbolicLink()) {
      throw new Error(`lane path is a symlink — refusing to touch it:\n${lane}`);
    }
    if (!laneMarkerValid(lane, recordPath)) {
      throw new Error(
        `a directory exists at the lane path but was not created by proto for this record — refusing to touch it:\n${lane}`,
      );
    }
  };

  if (action === "new") {
    if (laneOnDisk) {
      requireOwned();
    } else {
      mkdirSync(lane, { recursive: true });
      writeFileSync(
        join(lane, LANE_MARKER),
        `${JSON.stringify({ record: basename(recordPath), owner: "decision-shelf proto" })}\n`,
        { flag: "wx" },
      );
    }
    if (!args.length) {
      console.log(lane);
      return;
    }
    const directory = join(lane, variantArg);
    if (existsSync(directory)) {
      throw new Error(`variant already exists: ${directory}`);
    }
    mkdirSync(directory);
    const entry = join(directory, "index.html");
    writeFileSync(
      entry,
      [
        "<!doctype html>",
        '<meta charset="utf-8">',
        `<title>${variantArg} — disposable prototype</title>`,
        `<p>Disposable prototype variant "${variantArg}". Replace this stub;`,
        "the lane is deleted after the decision — durable outcome goes in the record.</p>",
        "",
      ].join("\n"),
      { flag: "wx" },
    );
    console.log(entry);
  } else if (action === "view") {
    if (!laneOnDisk) {
      throw new Error(`no prototype lane for this record — create one: proto <record> new [variant]`);
    }
    requireOwned();
    const variants = laneVariants(lane);
    if (variants.length === 0) {
      console.log(`(empty lane) ${lane}`);
      return;
    }
    const width = Math.max(...variants.map((name) => name.length));
    for (const name of variants) {
      const entry = join(lane, name, "index.html");
      const target = existsSync(entry) ? pathToFileURL(entry).href : join(lane, name);
      console.log(`${name.padEnd(width)}   ${target}`);
    }
  } else if (action === "promote") {
    if (!args.length) throw new Error(`provide the surviving variant: ${PROTO_USAGE}`);
    if (!laneOnDisk) {
      throw new Error(`no prototype lane for this record — create one: proto <record> new [variant]`);
    }
    requireOwned();
    const directory = join(lane, variantArg);
    if (!existsSync(directory)) {
      throw new Error(
        `no variant "${variantArg}" in the lane (see: decision-shelf proto <record> view)`,
      );
    }
    // One read, full preflight, one write: a record missing any field the
    // promotion touches is refused, never partially rewritten. The evidence
    // row goes into the comparison section's own table — a bare </tbody>
    // match could belong to a hand-added table elsewhere.
    const text = readFileSync(recordPath, "utf8");
    const comparison = text.match(
      /<section aria-labelledby="comparison">[\s\S]*?<\/section>/,
    );
    const required = [
      /<dt>Prototype<\/dt><dd>[\s\S]*?<\/dd>/,
      /data-updated="[^"]*"/,
      /<dt>Updated<\/dt><dd>[^<]*<\/dd>/,
    ];
    if (
      !comparison ||
      !comparison[0].includes("</tbody>") ||
      !required.every((pattern) => pattern.test(text))
    ) {
      throw new Error(
        `record is missing expected structure (Prototype field, Options and evidence table, data-updated, Updated row) — edit it by hand:\n${recordPath}`,
      );
    }
    const today = new Date().toISOString().slice(0, 10);
    const relative = `./${basename(lane)}/${variantArg}/`;
    const row =
      `          <tr><td>Prototype: ${variantArg}</td><td>${relative}</td>` +
      `<td>${today}</td><td>Promoted surviving variant from the proto lane</td></tr>\n        </tbody>`;
    const patchedComparison = comparison[0].replace(/(\s*)<\/tbody>/, `\n${row}`);
    writeFileSync(
      recordPath,
      text
        .replace(comparison[0], () => patchedComparison)
        .replace(/(<dt>Prototype<\/dt><dd>)[\s\S]*?(<\/dd>)/, `$1${relative}$2`)
        .replace(/data-updated="[^"]*"/, `data-updated="${today}"`)
        .replace(/(<dt>Updated<\/dt><dd>)[^<]*(<\/dd>)/, `$1${today}$2`),
    );
    console.log(`promoted: ${variantArg}`);
    console.log(`record updated: ${recordPath}`);
  } else if (action === "clean") {
    if (!laneOnDisk) throw new Error(`no prototype lane to remove for:\n${recordPath}`);
    requireOwned();
    const count = laneVariants(lane).length;
    rmSync(lane, { recursive: true });
    console.log(`removed ${lane} (${count} variant${count === 1 ? "" : "s"})`);
  } else {
    throw new Error(`unknown proto action: ${action} (usage: ${PROTO_USAGE})`);
  }
}

function commandBridge(shelf, project, query, cwd = process.cwd()) {
  const recordPath = resolveRecord(shelf, project, query, "bridge <record>");
  const criteria = extractBridgeCriteria(readFileSync(recordPath, "utf8"));
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
  else if (command === "new") commandNew(shelf, project, rest.join(" ").trim());
  else if (command === "status") commandStatus(shelf, project, rest);
  else if (command === "supersede") commandSupersede(shelf, project, rest);
  else if (command === "proto") commandProto(shelf, project, rest);
  else if (command === "find") commandFind(shelf, rest.join(" ").trim());
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
