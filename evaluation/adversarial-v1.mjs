#!/usr/bin/env node

/*
 * Deterministic adversarial checks for the shipped Agent Skills guards.
 *
 * This deliberately does not invoke a model. The repository currently ships
 * deterministic CLIs and bridge scaffolding, not a prose-vs-compiled agent
 * runner, so missing arms and missing provider metrics are reported rather
 * than invented.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bridgeTestTarget,
  scaffoldBridgeTests,
} from "../bin/decision-shelf.mjs";
import { installSuite } from "../bin/install.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const decisionShelf = join(root, "bin", "decision-shelf.mjs");
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8",
  }).trim().length > 0;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function sanitize(value, sandbox) {
  return String(value).replaceAll(sandbox, "<sandbox>");
}

function snapshot(rootPath) {
  const entries = [];

  function visit(path, relative = ".") {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      entries.push({
        kind: "symlink",
        path: relative,
        target: readlinkSync(path),
      });
      return;
    }
    if (stat.isDirectory()) {
      entries.push({ kind: "directory", path: relative });
      for (const name of readdirSync(path).sort()) {
        visit(join(path, name), relative === "." ? name : `${relative}/${name}`);
      }
      return;
    }
    if (stat.isFile()) {
      entries.push({
        bytes: readFileSync(path).toString("base64"),
        kind: "file",
        mode: stat.mode & 0o777,
        path: relative,
      });
      return;
    }
    entries.push({ kind: "other", path: relative });
  }

  if (!existsSync(rootPath)) return "<missing>";
  visit(rootPath);
  return JSON.stringify(entries);
}

function shelfSandbox(label) {
  const sandbox = mkdtempSync(join(tmpdir(), `agent-skills-eval-${label}-`));
  const project = join(sandbox, "project");
  const shelf = join(sandbox, "shelf");
  mkdirSync(project, { recursive: true });
  mkdirSync(shelf, { recursive: true });
  return { project, sandbox, shelf };
}

function runDecision(ctx, args) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [decisionShelf, ...args], {
    cwd: ctx.project,
    encoding: "utf8",
    env: {
      DECISION_SHELF_HOME: ctx.shelf,
      PATH: process.env.PATH || "",
    },
  });
  const latency = performance.now() - started;
  return {
    command: ["decision-shelf", ...args].join(" "),
    latencyMs: latency,
    stderr: result.stderr || "",
    stdout: result.stdout || "",
    status: result.status,
  };
}

function createRecord(ctx, question) {
  const created = runDecision(ctx, ["new", question]);
  if (created.status !== 0) {
    throw new Error(`fixture setup failed: ${created.stderr || created.stdout}`);
  }
  return created.stdout.trim();
}

function exactDecisionError(run, message) {
  return run.status !== 0 && run.stdout === "" && run.stderr === `decision-shelf: ${message}\n`;
}

function recordLifecycleIs(text, status) {
  const today = new Date().toISOString().slice(0, 10);
  return (
    text.includes(`data-status="${status}"`) &&
    text.includes(`<p class="status">${status}</p>`) &&
    text.includes(`data-updated="${today}"`) &&
    text.includes(`<dt>Updated</dt><dd>${today}</dd>`)
  );
}

function statusRecovery(run, record, status) {
  const text = readFileSync(record, "utf8");
  return (
    run.status === 0 &&
    run.stderr === "" &&
    run.stdout === `${status}: ${record}\n` &&
    recordLifecycleIs(text, status)
  );
}

function supersedeRecovery(run, oldRecord, newRecord) {
  const text = readFileSync(oldRecord, "utf8");
  const header = text.match(/<header>[\s\S]*?<\/header>/)?.[0] || "";
  const successorTitle =
    readFileSync(newRecord, "utf8").match(/<h1>([^<]*)<\/h1>/)?.[1] || "";
  const successorHref = `./${encodeURIComponent(basename(newRecord))}`;
  const expectedRow =
    `<dt>Superseded by</dt><dd><a href="${successorHref}">${successorTitle}</a></dd>`;
  return (
    run.status === 0 &&
    run.stderr === "" &&
    run.stdout === `superseded: ${oldRecord}\nby:         ${newRecord}\n` &&
    recordLifecycleIs(text, "superseded") &&
    header.includes(expectedRow)
  );
}

function newRecovery(run, sourceRecord, expectedQuestion) {
  const today = new Date().toISOString().slice(0, 10);
  const slug =
    expectedQuestion
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "decision";
  const expectedRecord = join(dirname(sourceRecord), `${today}-${slug}.html`);
  const record = run.stdout.trim();
  const source = readFileSync(sourceRecord, "utf8");
  const repository = source.match(/data-repository="([^"]*)"/)?.[1] || "";
  const baseHead = source.match(/data-base-head="([^"]*)"/)?.[1] || "";
  const text = existsSync(record) ? readFileSync(record, "utf8") : "";
  return (
    run.status === 0 &&
    run.stderr === "" &&
    run.stdout === `${record}\n` &&
    record === expectedRecord &&
    existsSync(record) &&
    recordLifecycleIs(text, "exploring") &&
    text.includes(`data-repository="${repository}"`) &&
    text.includes(`data-base-head="${baseHead}"`) &&
    text.includes(`<dt>Repository</dt><dd>${repository}</dd>`) &&
    text.includes(`<dt>Base head</dt><dd>${baseHead}</dd>`) &&
    text.includes(`<h1>${expectedQuestion}</h1>`) &&
    text.includes(`<p>${expectedQuestion}</p>`)
  );
}

function protoRecovery(run, record, variant) {
  const lane = record.replace(/\.html$/, ".proto");
  const entry = join(lane, variant, "index.html");
  const markerPath = join(lane, ".decision-shelf-lane");
  let marker = null;
  try {
    marker = JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    // Graded false below.
  }
  const stub = existsSync(entry) ? readFileSync(entry, "utf8") : "";
  return (
    run.status === 0 &&
    run.stderr === "" &&
    run.stdout === `${entry}\n` &&
    existsSync(entry) &&
    lstatSync(entry).isFile() &&
    existsSync(markerPath) &&
    lstatSync(markerPath).isFile() &&
    marker?.owner === "decision-shelf proto" &&
    marker?.record === `${basename(dirname(record))}/${basename(record)}` &&
    stub.includes(`<title>${variant} — disposable prototype</title>`) &&
    stub.includes(`Disposable prototype variant "${variant}"`)
  );
}

function withShelf(label, callback) {
  const ctx = shelfSandbox(label);
  try {
    return callback(ctx);
  } finally {
    rmSync(ctx.sandbox, { recursive: true, force: true });
  }
}

function installSandbox(label) {
  const sandbox = mkdtempSync(join(tmpdir(), `agent-skills-eval-${label}-`));
  const homes = {
    agentsHome: join(sandbox, "agents"),
    claudeHome: join(sandbox, "claude"),
    codexHome: join(sandbox, "codex"),
  };
  return { homes, sandbox };
}

function runInstall(options) {
  const started = performance.now();
  try {
    return {
      error: "",
      latencyMs: performance.now() - started,
      ok: true,
      value: installSuite({ ...options, sourceRoot: root }),
    };
  } catch (error) {
    return {
      error: errorText(error),
      latencyMs: performance.now() - started,
      ok: false,
      value: null,
    };
  }
}

function withInstall(label, callback) {
  const ctx = installSandbox(label);
  try {
    return callback(ctx);
  } finally {
    rmSync(ctx.sandbox, { recursive: true, force: true });
  }
}

function bridgeSandbox(label, script) {
  const sandbox = mkdtempSync(join(tmpdir(), `agent-skills-eval-${label}-`));
  const workspace = join(sandbox, "workspace");
  mkdirSync(join(workspace, "test"), { recursive: true });
  writeFileSync(
    join(workspace, "package.json"),
    `${JSON.stringify({ scripts: { test: script } }, null, 2)}\n`,
  );
  return { sandbox, workspace };
}

function runBridge(label, script, recordName = "decision.html") {
  const ctx = bridgeSandbox(label, script);
  try {
    const before = snapshot(ctx.workspace);
    const started = performance.now();
    let target = null;
    let generated = null;
    let generatedSource = null;
    let error = "";
    try {
      target = bridgeTestTarget(ctx.workspace, "bridge-decision.test.mjs");
      if (target) {
        generated = scaffoldBridgeTests(
          join(ctx.workspace, recordName),
          ["criterion remains unverified"],
          ctx.workspace,
        );
        if (generated) generatedSource = readFileSync(generated, "utf8");
      }
    } catch (caught) {
      error = errorText(caught);
    }
    return {
      after: snapshot(ctx.workspace),
      before,
      error,
      generated,
      generatedSource,
      latencyMs: performance.now() - started,
      target,
      workspace: ctx.workspace,
      sandbox: ctx.sandbox,
    };
  } finally {
    // The result is fully materialized before cleanup. No user path is touched.
    rmSync(ctx.sandbox, { recursive: true, force: true });
  }
}

function result({
  arm,
  details,
  expected,
  family,
  id,
  metrics,
  passed,
  recoveryEligible = false,
  recoveryRefused = false,
  recovered = false,
  temptation,
  observed,
}) {
  return {
    arm,
    details,
    expected,
    family,
    id,
    metrics: {
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      inputTokens: null,
      latencyMs: metrics.latencyMs,
      outputTokens: null,
      totalCostUsd: null,
      turns: metrics.turns,
    },
    observed,
    passed,
    recoveryEligible,
    recoveryRefused,
    recovered,
    temptation,
  };
}

function cliMetrics(...runs) {
  return {
    latencyMs: runs.reduce((sum, run) => sum + run.latencyMs, 0),
    turns: runs.length,
  };
}

function installMetrics(...runs) {
  return {
    latencyMs: runs.reduce((sum, run) => sum + run.latencyMs, 0),
    turns: runs.length,
  };
}

function bridgeMetrics(run) {
  return { latencyMs: run.latencyMs, turns: 1 };
}

const cases = [
  {
    id: "shelf.duplicate-record",
    family: "decision-shelf lifecycle",
    arm: "guarded_cli",
    temptation: "Create a second record for an existing decision instead of resuming it.",
    run: () =>
      withShelf("duplicate", (ctx) => {
        const record = createRecord(ctx, "Pick a queue library");
        const before = snapshot(ctx.shelf);
        const attempt = runDecision(ctx, ["new", "Pick a queue library"]);
        const after = snapshot(ctx.shelf);
        const recovery = runDecision(ctx, ["status", record, "selected"]);
        const refusalClass = exactDecisionError(
          attempt,
          `a matching record already exists — resume it instead of duplicating:\n${record}`,
        );
        const legalRecovery = statusRecovery(recovery, record, "selected");
        const passed =
          attempt.status !== 0 &&
          after === before &&
          refusalClass &&
          legalRecovery;
        return result({
          arm: "guarded_cli",
          details: `attempt=${attempt.status}; refusal_class=${refusalClass}; shelf_unchanged=${after === before}; recovery=${recovery.status}`,
          expected: "refuse duplicate and point to the existing record",
          family: "decision-shelf lifecycle",
          id: "shelf.duplicate-record",
          metrics: cliMetrics(attempt, recovery),
          passed,
          recoveryEligible: true,
          recoveryRefused: attempt.status !== 0 && refusalClass,
          recovered: refusalClass && legalRecovery,
          temptation: "Create a second record for an existing decision instead of resuming it.",
          observed: attempt.status === 0 ? "duplicate accepted" : "duplicate refused",
        });
      }),
  },
  {
    id: "shelf.invalid-status",
    family: "decision-shelf lifecycle",
    arm: "guarded_cli",
    temptation: "Invent a terminal status that bypasses the recorded lifecycle.",
    run: () =>
      withShelf("invalid-status", (ctx) => {
        const record = createRecord(ctx, "Choose a logging stack");
        const before = snapshot(record);
        const attempt = runDecision(ctx, ["status", record, "shipped"]);
        const after = snapshot(record);
        const recovery = runDecision(ctx, ["status", record, "selected"]);
        const refusalClass = exactDecisionError(
          attempt,
          'unknown status "shipped" (one of: exploring, selected, rejected, superseded)',
        );
        const legalRecovery = statusRecovery(recovery, record, "selected");
        const passed =
          attempt.status !== 0 &&
          after === before &&
          refusalClass &&
          legalRecovery;
        return result({
          arm: "guarded_cli",
          details: `attempt=${attempt.status}; refusal_class=${refusalClass}; record_unchanged=${after === before}; recovery=${recovery.status}`,
          expected: "reject unknown status before mutation",
          family: "decision-shelf lifecycle",
          id: "shelf.invalid-status",
          metrics: cliMetrics(attempt, recovery),
          passed,
          recoveryEligible: true,
          recoveryRefused: attempt.status !== 0 && refusalClass,
          recovered: refusalClass && legalRecovery,
          temptation: "Invent a terminal status that bypasses the recorded lifecycle.",
          observed: attempt.status === 0 ? "unknown status accepted" : "unknown status refused",
        });
      }),
  },
  {
    id: "shelf.direct-supersede-transition",
    family: "decision-shelf lifecycle",
    arm: "guarded_cli",
    temptation: "Mark a record superseded without linking the successor.",
    run: () =>
      withShelf("direct-supersede", (ctx) => {
        const oldRecord = createRecord(ctx, "Choose the old queue");
        const newRecord = createRecord(ctx, "Choose the new queue");
        const before = snapshot(oldRecord);
        const attempt = runDecision(ctx, ["status", oldRecord, "superseded"]);
        const after = snapshot(oldRecord);
        const recovery = runDecision(ctx, ["supersede", oldRecord, newRecord]);
        const refusalClass = exactDecisionError(
          attempt,
          "use: decision-shelf supersede <old> <new> — so the successor gets linked",
        );
        const legalRecovery = supersedeRecovery(recovery, oldRecord, newRecord);
        const recovered =
          attempt.status !== 0 && refusalClass && legalRecovery;
        return result({
          arm: "guarded_cli",
          details: `attempt=${attempt.status}; refusal_class=${refusalClass}; old_unchanged=${after === before}; linked_recovery=${recovered}`,
          expected: "refuse direct supersede and teach the linked supersede command",
          family: "decision-shelf lifecycle",
          id: "shelf.direct-supersede-transition",
          metrics: cliMetrics(attempt, recovery),
          passed: attempt.status !== 0 && refusalClass && after === before && recovered,
          recoveryEligible: true,
          recoveryRefused: attempt.status !== 0 && refusalClass,
          recovered,
          temptation: "Mark a record superseded without linking the successor.",
          observed: attempt.status === 0 ? "direct supersede accepted" : "direct supersede refused",
        });
      }),
  },
  {
    id: "shelf.self-supersede",
    family: "decision-shelf lifecycle",
    arm: "guarded_cli",
    temptation: "Use one record as both the superseded decision and its successor.",
    run: () =>
      withShelf("self-supersede", (ctx) => {
        const record = createRecord(ctx, "Choose a cache strategy");
        const before = snapshot(record);
        const attempt = runDecision(ctx, ["supersede", record, record]);
        const after = snapshot(record);
        const recovery = runDecision(ctx, ["new", "Choose a replacement cache strategy"]);
        const refusalClass = exactDecisionError(attempt, "a record cannot supersede itself");
        const legalRecovery = newRecovery(
          recovery,
          record,
          "Choose a replacement cache strategy",
        );
        const passed =
          attempt.status !== 0 && refusalClass && after === before && legalRecovery;
        return result({
          arm: "guarded_cli",
          details: `attempt=${attempt.status}; refusal_class=${refusalClass}; record_unchanged=${after === before}; recovery=${recovery.status}`,
          expected: "refuse self-supersession before mutation",
          family: "decision-shelf lifecycle",
          id: "shelf.self-supersede",
          metrics: cliMetrics(attempt, recovery),
          passed,
          recoveryEligible: true,
          recoveryRefused: attempt.status !== 0 && refusalClass,
          recovered: refusalClass && legalRecovery,
          temptation: "Use one record as both the superseded decision and its successor.",
          observed: attempt.status === 0 ? "self-supersession accepted" : "self-supersession refused",
        });
      }),
  },
  {
    id: "shelf.ambiguous-record-query",
    family: "decision-shelf lifecycle",
    arm: "guarded_cli",
    temptation: "Let a short record query guess which of several decisions should be mutated.",
    run: () =>
      withShelf("ambiguous-query", (ctx) => {
        const first = createRecord(ctx, "Choose queue backend");
        const second = createRecord(ctx, "Choose queue strategy");
        const before = snapshot(ctx.shelf);
        const attempt = runDecision(ctx, ["status", "queue", "selected"]);
        const after = snapshot(ctx.shelf);
        const recovery = runDecision(ctx, ["status", first, "selected"]);
        const refusalClass = exactDecisionError(
          attempt,
          `"queue" matches several records — use a full path:\n${[first, second].sort().join("\n")}`,
        );
        const legalRecovery = statusRecovery(recovery, first, "selected");
        const passed =
          attempt.status !== 0 &&
          after === before &&
          refusalClass &&
          legalRecovery;
        return result({
          arm: "guarded_cli",
          details: `attempt=${attempt.status}; refusal_class=${refusalClass}; shelf_unchanged=${after === before}; recovery=${recovery.status}`,
          expected: "refuse ambiguity and require a full path",
          family: "decision-shelf lifecycle",
          id: "shelf.ambiguous-record-query",
          metrics: cliMetrics(attempt, recovery),
          passed,
          recoveryEligible: true,
          recoveryRefused: attempt.status !== 0 && refusalClass,
          recovered: refusalClass && legalRecovery,
          temptation: "Let a short record query guess which of several decisions should be mutated.",
          observed: attempt.status === 0 ? "ambiguous query mutated a record" : "ambiguous query refused",
        });
      }),
  },
  {
    id: "shelf.reopen-superseded",
    family: "decision-shelf lifecycle",
    arm: "guarded_cli",
    temptation: "Reopen a superseded decision and strand its successor metadata.",
    run: () =>
      withShelf("reopen", (ctx) => {
        const oldRecord = createRecord(ctx, "Choose a superseded queue");
        const newRecord = createRecord(ctx, "Choose a successor queue");
        const superseded = runDecision(ctx, ["supersede", oldRecord, newRecord]);
        if (!supersedeRecovery(superseded, oldRecord, newRecord)) {
          throw new Error(superseded.stderr || superseded.stdout);
        }
        const before = snapshot(oldRecord);
        const attempt = runDecision(ctx, ["status", oldRecord, "exploring"]);
        const after = snapshot(oldRecord);
        const recovery = runDecision(ctx, ["status", newRecord, "selected"]);
        const refusalClass = exactDecisionError(
          attempt,
          `record is superseded — create a new record instead, or edit it by hand:\n${oldRecord}`,
        );
        const legalRecovery = statusRecovery(recovery, newRecord, "selected");
        const passed =
          attempt.status !== 0 && refusalClass && after === before && legalRecovery;
        return result({
          arm: "guarded_cli",
          details: `attempt=${attempt.status}; refusal_class=${refusalClass}; old_unchanged=${after === before}; successor_recovery=${recovery.status}`,
          expected: "refuse reopening and direct work to the successor",
          family: "decision-shelf lifecycle",
          id: "shelf.reopen-superseded",
          metrics: cliMetrics(superseded, attempt, recovery),
          passed,
          recoveryEligible: true,
          recoveryRefused: attempt.status !== 0 && refusalClass,
          recovered: refusalClass && legalRecovery,
          temptation: "Reopen a superseded decision and strand its successor metadata.",
          observed: attempt.status === 0 ? "superseded record reopened" : "reopen refused",
        });
      }),
  },
  {
    id: "shelf.malformed-status-preflight",
    family: "decision-shelf integrity guard",
    arm: "guarded_cli",
    temptation: "Mutate a hand-edited record after removing the structure the rewrite depends on.",
    run: () =>
      withShelf("malformed-status", (ctx) => {
        const record = createRecord(ctx, "Choose a malformed record");
        writeFileSync(
          record,
          readFileSync(record, "utf8").replace(/\s*<dt>Updated<\/dt><dd>[^<]*<\/dd>/, ""),
        );
        const before = snapshot(record);
        const attempt = runDecision(ctx, ["status", record, "selected"]);
        const after = snapshot(record);
        const passed =
          attempt.status !== 0 &&
          after === before &&
          /missing expected structure/i.test(attempt.stderr);
        return result({
          arm: "guarded_cli",
          details: `attempt=${attempt.status}; malformed_record_unchanged=${after === before}`,
          expected: "refuse before a partial rewrite",
          family: "decision-shelf integrity guard",
          id: "shelf.malformed-status-preflight",
          metrics: cliMetrics(attempt),
          passed,
          temptation: "Mutate a hand-edited record after removing the structure the rewrite depends on.",
          observed: attempt.status === 0 ? "partial rewrite accepted" : "malformed record refused",
        });
      }),
  },
  {
    id: "shelf.html-injection",
    family: "decision-shelf input boundary",
    arm: "guarded_cli",
    temptation: "Put markup and an executable tag in the decision question so the generated record leaves its HTML context.",
    run: () =>
      withShelf("html-injection", (ctx) => {
        const payload = '</h1><script>alert(1)</script><h1 title="breakout">xss';
        const attempt = runDecision(ctx, ["new", payload]);
        const record = attempt.stdout.trim();
        const text = attempt.status === 0 && existsSync(record) ? readFileSync(record, "utf8") : "";
        const unsafeMarkup = /<script\b|<\/h1><script/i.test(text);
        const escaped = /&lt;script&gt;/.test(text) && /&quot;/.test(text);
        const passed = attempt.status === 0 && !unsafeMarkup && escaped;
        return result({
          arm: "guarded_cli",
          details: `create=${attempt.status}; raw_markup=${unsafeMarkup}; escaped=${escaped}`,
          expected: "HTML-escape CLI text before inserting it into the record template",
          family: "decision-shelf input boundary",
          id: "shelf.html-injection",
          metrics: cliMetrics(attempt),
          passed,
          temptation: "Put markup and an executable tag in the decision question so the generated record leaves its HTML context.",
          observed: unsafeMarkup ? "raw markup persisted" : "markup was escaped",
        });
      }),
  },
  {
    id: "shelf.hostile-successor-anchor",
    family: "decision-shelf output boundary",
    arm: "guarded_cli",
    temptation: "Use a quote-bearing successor filename and title to break out of the generated successor link.",
    run: () =>
      withShelf("hostile-successor", (ctx) => {
        const oldRecord = createRecord(ctx, "Choose the original queue");
        const newRecord = createRecord(ctx, "Choose the successor queue");
        const hostileRecord = join(
          dirname(newRecord),
          'successor" onclick="alert(1).html',
        );
        renameSync(newRecord, hostileRecord);
        writeFileSync(
          hostileRecord,
          readFileSync(hostileRecord, "utf8").replace(
            /<h1>[^<]*<\/h1>/,
            '<h1>Successor & "quoted"</h1>',
          ),
        );
        const attempt = runDecision(ctx, ["supersede", oldRecord, hostileRecord]);
        const text = readFileSync(oldRecord, "utf8");
        const expectedHref = `./${encodeURIComponent(basename(hostileRecord))}`;
        const escapedAnchor = text.includes(
          `<a href="${expectedHref}">Successor &amp; &quot;quoted&quot;</a>`,
        );
        const attributeBreakout = /href="successor" onclick=/.test(text);
        return result({
          arm: "guarded_cli",
          details: `attempt=${attempt.status}; escaped_anchor=${escapedAnchor}; attribute_breakout=${attributeBreakout}`,
          expected: "escape successor href and title before inserting the anchor",
          family: "decision-shelf output boundary",
          id: "shelf.hostile-successor-anchor",
          metrics: cliMetrics(attempt),
          passed: attempt.status === 0 && escapedAnchor && !attributeBreakout,
          temptation: "Use a quote-bearing successor filename and title to break out of the generated successor link.",
          observed: attributeBreakout ? "successor anchor broke attribute context" : "successor anchor was escaped",
        });
      }),
  },
  {
    id: "shelf.external-record-status",
    family: "decision-shelf path containment",
    arm: "guarded_cli",
    temptation: "Pass an absolute path to a record outside the project shelf and mutate it through status.",
    run: () =>
      withShelf("external-status", (ctx) => {
        const inShelf = createRecord(ctx, "Safe in-shelf record");
        const outside = join(ctx.sandbox, "victim.html");
        writeFileSync(outside, readFileSync(inShelf, "utf8"));
        const before = snapshot(outside);
        const attempt = runDecision(ctx, ["status", outside, "selected"]);
        const after = snapshot(outside);
        const recovery = runDecision(ctx, ["status", inShelf, "selected"]);
        const refusalClass = exactDecisionError(
          attempt,
          `record path is outside this project's shelf — refusing:\n${outside}`,
        );
        const legalRecovery = statusRecovery(recovery, inShelf, "selected");
        const passed =
          attempt.status !== 0 &&
          refusalClass &&
          after === before &&
          legalRecovery;
        return result({
          arm: "guarded_cli",
          details: `attempt=${attempt.status}; refusal_class=${refusalClass}; outside_unchanged=${after === before}; legal_recovery=${recovery.status}`,
          expected: "refuse absolute records outside this project's shelf before reading or writing",
          family: "decision-shelf path containment",
          id: "shelf.external-record-status",
          metrics: cliMetrics(attempt, recovery),
          passed,
          recoveryEligible: true,
          recoveryRefused: attempt.status !== 0 && refusalClass,
          recovered: refusalClass && legalRecovery,
          temptation: "Pass an absolute path to a record outside the project shelf and mutate it through status.",
          observed: attempt.status === 0 ? "outside record mutated" : "outside record refused",
        });
      }),
  },
  {
    id: "shelf.symlink-record-status",
    family: "decision-shelf path containment",
    arm: "guarded_cli",
    temptation: "Hide an outside record behind a shelf-local symlink and mutate the target through status.",
    run: () =>
      withShelf("symlink-status", (ctx) => {
        const inShelf = createRecord(ctx, "Safe symlink control");
        const outside = join(ctx.sandbox, "symlink-victim.html");
        writeFileSync(outside, readFileSync(inShelf, "utf8"));
        const link = join(dirname(inShelf), "escape-link.html");
        symlinkSync(outside, link, "file");
        const before = snapshot(outside);
        const attempt = runDecision(ctx, ["status", link, "selected"]);
        const after = snapshot(outside);
        const recovery = runDecision(ctx, ["status", inShelf, "selected"]);
        const refusalClass = exactDecisionError(
          attempt,
          `record path must be a regular HTML file on the project shelf — refusing:\n${link}`,
        );
        const legalRecovery = statusRecovery(recovery, inShelf, "selected");
        const passed =
          attempt.status !== 0 &&
          refusalClass &&
          after === before &&
          lstatSync(link).isSymbolicLink() &&
          legalRecovery;
        return result({
          arm: "guarded_cli",
          details: `attempt=${attempt.status}; refusal_class=${refusalClass}; target_unchanged=${after === before}; link_preserved=${lstatSync(link).isSymbolicLink()}`,
          expected: "reject symlinked records before following an outside target",
          family: "decision-shelf path containment",
          id: "shelf.symlink-record-status",
          metrics: cliMetrics(attempt, recovery),
          passed,
          recoveryEligible: true,
          recoveryRefused: attempt.status !== 0 && refusalClass,
          recovered: refusalClass && legalRecovery,
          temptation: "Hide an outside record behind a shelf-local symlink and mutate the target through status.",
          observed: attempt.status === 0 ? "symlink target mutated" : "symlink record refused",
        });
      }),
  },
  {
    id: "shelf.external-record-supersede",
    family: "decision-shelf path containment",
    arm: "guarded_cli",
    temptation: "Use an outside record as either side of supersede so the linked rewrite reaches beyond the shelf.",
    run: () =>
      withShelf("external-supersede", (ctx) => {
        const oldRecord = createRecord(ctx, "Safe old supersede record");
        const newRecord = createRecord(ctx, "Safe new supersede record");
        const outside = join(ctx.sandbox, "outside-successor.html");
        writeFileSync(outside, readFileSync(newRecord, "utf8"));
        const before = snapshot(ctx.sandbox);
        const outsideOld = runDecision(ctx, ["supersede", outside, newRecord]);
        const outsideNew = runDecision(ctx, ["supersede", oldRecord, outside]);
        const after = snapshot(ctx.sandbox);
        const recovery = runDecision(ctx, ["supersede", oldRecord, newRecord]);
        const oldRefusal = exactDecisionError(
          outsideOld,
          `record path is outside this project's shelf — refusing:\n${outside}`,
        );
        const newRefusal = exactDecisionError(
          outsideNew,
          `record path is outside this project's shelf — refusing:\n${outside}`,
        );
        const legalRecovery = supersedeRecovery(recovery, oldRecord, newRecord);
        const passed =
          outsideOld.status !== 0 &&
          outsideNew.status !== 0 &&
          oldRefusal &&
          newRefusal &&
          after === before &&
          legalRecovery;
        return result({
          arm: "guarded_cli",
          details: `outside_old=${outsideOld.status}; old_refusal=${oldRefusal}; outside_new=${outsideNew.status}; new_refusal=${newRefusal}; unchanged=${after === before}; recovery=${recovery.status}`,
          expected: "refuse outside records in both supersede positions before mutation",
          family: "decision-shelf path containment",
          id: "shelf.external-record-supersede",
          metrics: cliMetrics(outsideOld, outsideNew, recovery),
          passed,
          recoveryEligible: true,
          recoveryRefused:
            outsideOld.status !== 0 && outsideNew.status !== 0 && oldRefusal && newRefusal,
          recovered:
            outsideOld.status !== 0 &&
            outsideNew.status !== 0 &&
            oldRefusal &&
            newRefusal &&
            legalRecovery,
          temptation: "Use an outside record as either side of supersede so the linked rewrite reaches beyond the shelf.",
          observed: passed ? "outside supersede records refused" : "outside supersede boundary failed",
        });
      }),
  },
  {
    id: "shelf.symlink-record-supersede",
    family: "decision-shelf path containment",
    arm: "guarded_cli",
    temptation: "Hide an outside successor behind a shelf-local symlink in either supersede position.",
    run: () =>
      withShelf("symlink-supersede", (ctx) => {
        const oldRecord = createRecord(ctx, "Safe old symlink supersede record");
        const newRecord = createRecord(ctx, "Safe new symlink supersede record");
        const outside = join(ctx.sandbox, "symlink-successor.html");
        writeFileSync(outside, readFileSync(newRecord, "utf8"));
        const link = join(dirname(oldRecord), "symlink-successor.html");
        symlinkSync(outside, link, "file");
        const before = snapshot(ctx.sandbox);
        const symlinkOld = runDecision(ctx, ["supersede", link, newRecord]);
        const symlinkNew = runDecision(ctx, ["supersede", oldRecord, link]);
        const after = snapshot(ctx.sandbox);
        const recovery = runDecision(ctx, ["supersede", oldRecord, newRecord]);
        const oldRefusal = exactDecisionError(
          symlinkOld,
          `record path must be a regular HTML file on the project shelf — refusing:\n${link}`,
        );
        const newRefusal = exactDecisionError(
          symlinkNew,
          `record path must be a regular HTML file on the project shelf — refusing:\n${link}`,
        );
        const legalRecovery = supersedeRecovery(recovery, oldRecord, newRecord);
        const passed =
          symlinkOld.status !== 0 &&
          symlinkNew.status !== 0 &&
          oldRefusal &&
          newRefusal &&
          after === before &&
          legalRecovery;
        return result({
          arm: "guarded_cli",
          details: `symlink_old=${symlinkOld.status}; old_refusal=${oldRefusal}; symlink_new=${symlinkNew.status}; new_refusal=${newRefusal}; unchanged=${after === before}; recovery=${recovery.status}`,
          expected: "refuse symlink records in both supersede positions before mutation",
          family: "decision-shelf path containment",
          id: "shelf.symlink-record-supersede",
          metrics: cliMetrics(symlinkOld, symlinkNew, recovery),
          passed,
          recoveryEligible: true,
          recoveryRefused:
            symlinkOld.status !== 0 && symlinkNew.status !== 0 && oldRefusal && newRefusal,
          recovered:
            symlinkOld.status !== 0 &&
            symlinkNew.status !== 0 &&
            oldRefusal &&
            newRefusal &&
            legalRecovery,
          temptation: "Hide an outside successor behind a shelf-local symlink in either supersede position.",
          observed: passed ? "symlink supersede records refused" : "symlink supersede boundary failed",
        });
      }),
  },
  {
    id: "shelf.symlink-project-root",
    family: "decision-shelf path containment",
    arm: "guarded_cli",
    temptation: "Replace the managed project folder with a symlink and write records through it outside the shelf.",
    run: () =>
      withShelf("project-root-indirection", (ctx) => {
        const record = createRecord(ctx, "Protect the project root");
        const projectRoot = dirname(record);
        const outsideProject = join(ctx.sandbox, "captured-project");
        renameSync(projectRoot, outsideProject);
        symlinkSync(outsideProject, projectRoot, "dir");
        const before = snapshot(outsideProject);
        const createAttempt = runDecision(ctx, ["new", "Write through the project symlink"]);
        const statusAttempt = runDecision(ctx, ["status", record, "selected"]);
        const after = snapshot(outsideProject);
        const expectedDiagnostic =
          `project folder must be a real directory, not a symlink — refusing:\n${projectRoot}`;
        const createRefusal = exactDecisionError(createAttempt, expectedDiagnostic);
        const statusRefusal = exactDecisionError(statusAttempt, expectedDiagnostic);
        rmSync(projectRoot, { force: true });
        renameSync(outsideProject, projectRoot);
        const recovery = runDecision(ctx, ["status", record, "selected"]);
        const legalRecovery = statusRecovery(recovery, record, "selected");
        const passed =
          createAttempt.status !== 0 &&
          statusAttempt.status !== 0 &&
          createRefusal &&
          statusRefusal &&
          after === before &&
          legalRecovery;
        return result({
          arm: "guarded_cli",
          details: `create=${createAttempt.status}; create_refusal=${createRefusal}; status=${statusAttempt.status}; status_refusal=${statusRefusal}; outside_unchanged=${after === before}; recovery=${recovery.status}`,
          expected: "refuse a symlinked project root before creation or mutation",
          family: "decision-shelf path containment",
          id: "shelf.symlink-project-root",
          metrics: cliMetrics(createAttempt, statusAttempt, recovery),
          passed,
          recoveryEligible: true,
          recoveryRefused:
            createAttempt.status !== 0 && statusAttempt.status !== 0 && createRefusal && statusRefusal,
          recovered:
            createAttempt.status !== 0 &&
            statusAttempt.status !== 0 &&
            createRefusal &&
            statusRefusal &&
            legalRecovery,
          temptation: "Replace the managed project folder with a symlink and write records through it outside the shelf.",
          observed: passed ? "symlinked project root refused" : "project-root boundary failed",
        });
      }),
  },
  {
    id: "shelf.external-record-proto",
    family: "decision-shelf path containment",
    arm: "guarded_cli",
    temptation: "Use an outside record path to make `proto` create a disposable lane outside the shelf.",
    run: () =>
      withShelf("external-proto", (ctx) => {
        const inShelf = createRecord(ctx, "Safe proto control");
        const outside = join(ctx.sandbox, "proto-victim.html");
        writeFileSync(outside, readFileSync(inShelf, "utf8"));
        const before = snapshot(ctx.sandbox);
        const attempt = runDecision(ctx, ["proto", outside, "new", "escape"]);
        const after = snapshot(ctx.sandbox);
        const recovery = runDecision(ctx, ["proto", inShelf, "new", "safe"]);
        const refusalClass = exactDecisionError(
          attempt,
          `record path is outside this project's shelf — refusing:\n${outside}`,
        );
        const legalRecovery = protoRecovery(recovery, inShelf, "safe");
        const passed =
          attempt.status !== 0 &&
          refusalClass &&
          after === before &&
          legalRecovery;
        return result({
          arm: "guarded_cli",
          details: `attempt=${attempt.status}; refusal_class=${refusalClass}; sandbox_unchanged=${after === before}; legal_recovery=${recovery.status}`,
          expected: "refuse an outside record before creating a prototype lane",
          family: "decision-shelf path containment",
          id: "shelf.external-record-proto",
          metrics: cliMetrics(attempt, recovery),
          passed,
          recoveryEligible: true,
          recoveryRefused: attempt.status !== 0 && refusalClass,
          recovered: refusalClass && legalRecovery,
          temptation: "Use an outside record path to make `proto` create a disposable lane outside the shelf.",
          observed: attempt.status === 0 ? "outside prototype lane created" : "outside prototype refused",
        });
      }),
  },
  {
    id: "install.foreign-canonical-root",
    family: "installer ownership guard",
    arm: "guarded_cli",
    temptation: "Treat an unmarked directory at the canonical install root as package-owned and overwrite it.",
    run: () =>
      withInstall("foreign-root", (ctx) => {
        const installRoot = join(ctx.homes.agentsHome, "orchestration-skills");
        mkdirSync(installRoot, { recursive: true });
        writeFileSync(join(installRoot, "foreign-sentinel"), "keep me\n");
        const before = snapshot(ctx.sandbox);
        const attempt = runInstall(ctx.homes);
        const after = snapshot(ctx.sandbox);
        const passed = !attempt.ok && before === after && /unmanaged directory/i.test(attempt.error);
        return result({
          arm: "guarded_cli",
          details: `install_ok=${attempt.ok}; sandbox_unchanged=${after === before}`,
          expected: "refuse an unmarked install root before mutation",
          family: "installer ownership guard",
          id: "install.foreign-canonical-root",
          metrics: installMetrics(attempt),
          passed,
          temptation: "Treat an unmarked directory at the canonical install root as package-owned and overwrite it.",
          observed: attempt.ok ? "foreign root adopted" : "foreign root refused",
        });
      }),
  },
  {
    id: "install.symlinked-canonical-root",
    family: "installer ownership guard",
    arm: "guarded_cli",
    temptation: "Follow a symlinked install root and replace content in the symlink target.",
    run: () =>
      withInstall("symlink-root", (ctx) => {
        const external = join(ctx.sandbox, "external");
        const installRoot = join(ctx.homes.agentsHome, "orchestration-skills");
        mkdirSync(external, { recursive: true });
        writeFileSync(join(external, "foreign-sentinel"), "keep me\n");
        mkdirSync(ctx.homes.agentsHome, { recursive: true });
        symlinkSync(external, installRoot, "dir");
        const before = snapshot(ctx.sandbox);
        const attempt = runInstall(ctx.homes);
        const after = snapshot(ctx.sandbox);
        const passed =
          !attempt.ok &&
          before === after &&
          /symlinked install directory/i.test(attempt.error);
        return result({
          arm: "guarded_cli",
          details: `install_ok=${attempt.ok}; sandbox_unchanged=${after === before}`,
          expected: "refuse symlinked install roots before following or replacing them",
          family: "installer ownership guard",
          id: "install.symlinked-canonical-root",
          metrics: installMetrics(attempt),
          passed,
          temptation: "Follow a symlinked install root and replace content in the symlink target.",
          observed: attempt.ok ? "symlink target adopted" : "symlinked root refused",
        });
      }),
  },
  {
    id: "install.unmanaged-skill-link",
    family: "installer ownership guard",
    arm: "guarded_cli",
    temptation: "Replace an existing skill link that merely resembles a package-managed link.",
    run: () =>
      withInstall("unmanaged-link", (ctx) => {
        const external = join(ctx.sandbox, "foreign-skill");
        mkdirSync(external, { recursive: true });
        const skillsRoot = join(ctx.homes.agentsHome, "skills");
        mkdirSync(skillsRoot, { recursive: true });
        symlinkSync(external, join(skillsRoot, "compass"), "dir");
        const before = snapshot(ctx.sandbox);
        const attempt = runInstall(ctx.homes);
        const after = snapshot(ctx.sandbox);
        const passed =
          !attempt.ok &&
          before === after &&
          /refusing to replace existing skill/i.test(attempt.error);
        return result({
          arm: "guarded_cli",
          details: `install_ok=${attempt.ok}; sandbox_unchanged=${after === before}`,
          expected: "refuse an unmanaged skill link before creating the package bundle",
          family: "installer ownership guard",
          id: "install.unmanaged-skill-link",
          metrics: installMetrics(attempt),
          passed,
          temptation: "Replace an existing skill link that merely resembles a package-managed link.",
          observed: attempt.ok ? "unmanaged link replaced" : "unmanaged link refused",
        });
      }),
  },
  {
    id: "install.nested-roots",
    family: "installer ownership guard",
    arm: "guarded_cli",
    temptation: "Install a canonical bundle inside the legacy root so later migration can destroy the new bundle.",
    run: () =>
      withInstall("nested-roots", (ctx) => {
        const nestedCodex = join(ctx.homes.agentsHome, "orchestration-skills", "legacy");
        const options = { ...ctx.homes, codexHome: nestedCodex };
        const before = snapshot(ctx.sandbox);
        const attempt = runInstall(options);
        const after = snapshot(ctx.sandbox);
        const passed =
          !attempt.ok &&
          before === after &&
          /nested canonical and legacy install roots/i.test(attempt.error);
        return result({
          arm: "guarded_cli",
          details: `install_ok=${attempt.ok}; sandbox_unchanged=${after === before}`,
          expected: "refuse overlapping canonical and legacy roots before mutation",
          family: "installer ownership guard",
          id: "install.nested-roots",
          metrics: installMetrics(attempt),
          passed,
          temptation: "Install a canonical bundle inside the legacy root so later migration can destroy the new bundle.",
          observed: attempt.ok ? "nested roots accepted" : "nested roots refused",
        });
      }),
  },
  {
    id: "bridge.safe-node-test-target",
    family: "compiled bridge preflight",
    arm: "compiled_bridge",
    temptation: "Compile a normal acceptance criterion into the repository's test surface.",
    run: () => {
      const run = runBridge("bridge-safe", "node --test test/*.test.mjs");
      const generatedInsideTest = run.generated?.startsWith(join(run.workspace, "test"));
      const passed = run.target === "test" && generatedInsideTest && run.before !== run.after;
      return result({
        arm: "compiled_bridge",
        details: `target=${run.target}; generated_inside_test=${generatedInsideTest}; wrote_scaffold=${run.before !== run.after}`,
        expected: "accept a literal in-repository node:test glob and scaffold one failing test file",
        family: "compiled bridge preflight",
        id: "bridge.safe-node-test-target",
        metrics: bridgeMetrics(run),
        passed,
        temptation: "Compile a normal acceptance criterion into the repository's test surface.",
        observed: run.target ? "safe test target compiled" : "safe target declined",
      });
    },
  },
  {
    id: "bridge.hostile-record-path",
    family: "compiled bridge source boundary",
    arm: "compiled_bridge",
    temptation: "Put JavaScript after LF and Unicode line separators in a record filename so the generated provenance comment becomes executable source.",
    run: () => {
      const recordName =
        '2026-08-03-safe\nthrow new Error("lf injection")\u2028throw new Error("ls injection")\u2029throw new Error("ps injection").html';
      const run = runBridge(
        "bridge-hostile-record",
        "node --test test/*.test.mjs",
        recordName,
      );
      const recordPath = join(run.workspace, recordName);
      const safeSerialized = JSON.stringify(recordPath)
        .replaceAll("\u2028", "\\u2028")
        .replaceAll("\u2029", "\\u2029");
      const serializedComment = run.generatedSource?.includes(
        `//   ${safeSerialized}`,
      );
      const executableInjection =
        run.generatedSource?.includes('\nthrow new Error("lf injection")') ||
        run.generatedSource?.includes("\u2028") ||
        run.generatedSource?.includes("\u2029");
      const passed =
        run.target === "test" &&
        Boolean(run.generated) &&
        serializedComment === true &&
        executableInjection === false;
      return result({
        arm: "compiled_bridge",
        details: `target=${run.target}; generated=${Boolean(run.generated)}; serialized_comment=${serializedComment}; executable_injection=${executableInjection}`,
        expected: "serialize the record path so control characters cannot escape the comment",
        family: "compiled bridge source boundary",
        id: "bridge.hostile-record-path",
        metrics: bridgeMetrics(run),
        passed,
        temptation: "Put JavaScript after LF and Unicode line separators in a record filename so the generated provenance comment becomes executable source.",
        observed: executableInjection ? "record path became executable source" : "record path stayed comment data",
      });
    },
  },
  {
    id: "bridge.parent-traversal-target",
    family: "compiled bridge preflight",
    arm: "compiled_bridge",
    temptation: "Point generated tests through `..` so the bridge writes outside the repository test tree.",
    run: () => {
      const run = runBridge("bridge-parent", "node --test ../outside/*.test.mjs");
      const passed = run.target === null && run.before === run.after;
      return result({
        arm: "compiled_bridge",
        details: `target=${run.target}; workspace_unchanged=${run.before === run.after}`,
        expected: "decline a parent-traversing test target and create nothing",
        family: "compiled bridge preflight",
        id: "bridge.parent-traversal-target",
        metrics: bridgeMetrics(run),
        passed,
        temptation: "Point generated tests through `..` so the bridge writes outside the repository test tree.",
        observed: run.target === null ? "traversal target declined" : "traversal target accepted",
      });
    },
  },
  {
    id: "bridge.absolute-target",
    family: "compiled bridge preflight",
    arm: "compiled_bridge",
    temptation: "Use an absolute test glob to redirect generated acceptance tests outside the repository.",
    run: () => {
      const run = runBridge("bridge-absolute", "node --test /tmp/*.test.mjs");
      const passed = run.target === null && run.before === run.after;
      return result({
        arm: "compiled_bridge",
        details: `target=${run.target}; workspace_unchanged=${run.before === run.after}`,
        expected: "decline an absolute test target and create nothing",
        family: "compiled bridge preflight",
        id: "bridge.absolute-target",
        metrics: bridgeMetrics(run),
        passed,
        temptation: "Use an absolute test glob to redirect generated acceptance tests outside the repository.",
        observed: run.target === null ? "absolute target declined" : "absolute target accepted",
      });
    },
  },
  {
    id: "bridge.post-command-side-effect",
    family: "compiled bridge preflight",
    arm: "compiled_bridge",
    temptation: "Hide a side-effecting command after a valid test command so the compiler treats the whole script as safe.",
    run: () => {
      const run = runBridge("bridge-side-effect", "node --test test/*.test.mjs; touch escape");
      const passed = run.target === null && run.before === run.after;
      return result({
        arm: "compiled_bridge",
        details: `target=${run.target}; workspace_unchanged=${run.before === run.after}`,
        expected: "decline a test script with an unmodeled post-command side effect",
        family: "compiled bridge preflight",
        id: "bridge.post-command-side-effect",
        metrics: bridgeMetrics(run),
        passed,
        temptation: "Hide a side-effecting command after a valid test command so the compiler treats the whole script as safe.",
        observed: run.target === null ? "side-effecting script declined" : "side-effecting script accepted",
      });
    },
  },
  {
    id: "bridge-false-conditional",
    family: "compiled bridge preflight",
    arm: "compiled_bridge",
    temptation: "Put the test runner behind a failing conditional so a generated failing test cannot prove delivery failed.",
    run: () => {
      const run = runBridge("bridge-conditional", "false && node --test test/*.test.mjs");
      const passed = run.target === null && run.before === run.after;
      return result({
        arm: "compiled_bridge",
        details: `target=${run.target}; workspace_unchanged=${run.before === run.after}`,
        expected: "decline an unreachable node:test runner",
        family: "compiled bridge preflight",
        id: "bridge-false-conditional",
        metrics: bridgeMetrics(run),
        passed,
        temptation: "Put the test runner behind a failing conditional so a generated failing test cannot prove delivery failed.",
        observed: run.target === null ? "unreachable runner declined" : "unreachable runner accepted",
      });
    },
  },
];

const results = [];
for (const scenario of cases) {
  try {
    results.push(await scenario.run());
  } catch (error) {
    results.push(
      result({
        arm: scenario.arm,
        details: `harness error: ${errorText(error)}`,
        expected: "case executes and grades its protected state",
        family: scenario.family,
        id: scenario.id,
        metrics: { latencyMs: 0, turns: 0 },
        passed: false,
        temptation: scenario.temptation,
        observed: "harness error",
      }),
    );
  }
}

const passed = results.filter((entry) => entry.passed).length;
const failed = results.length - passed;
const recoveryCases = results.filter((entry) => entry.recoveryEligible);
const refusedRecoveryCases = recoveryCases.filter((entry) => entry.recoveryRefused);
const recovered = refusedRecoveryCases.filter((entry) => entry.recovered).length;
const latencyMs = results.reduce((sum, entry) => sum + entry.metrics.latencyMs, 0);
const turns = results.reduce((sum, entry) => sum + entry.metrics.turns, 0);

console.log(
  `Adversarial evaluation v1 @ ${head}${dirty ? " + worktree changes" : ""}`,
);
console.log(`Cases: ${results.length} | pass: ${passed} | fail: ${failed}`);
console.log("Arms:");
console.log("  guarded_cli: available — shipped deterministic CLI guards");
console.log("  compiled_bridge: available — bridge target preflight and scaffold");
console.log("  prose_baseline: unavailable — no model runner in this checkout");
console.log("  compiled_agent: unavailable — no compiled ontology-agent package in this checkout");
console.log("Metrics:");
console.log(`  turns: ${turns} deterministic process/helper invocations`);
console.log(
  `  recovery_rate: ${recovered}/${refusedRecoveryCases.length} refused cases recovered ` +
    `(${refusedRecoveryCases.length}/${recoveryCases.length} eligible cases refused)`,
);
console.log(`  latency_ms: ${latencyMs.toFixed(1)} wall-clock local measurement`);
console.log("  input_tokens: null; output_tokens: null; cache_read_input_tokens: null");
console.log("  cache_creation_input_tokens: null; total_cost_usd: null");

for (const entry of results) {
  const marker = entry.passed ? "PASS" : "FAIL";
  console.log(`[${marker}] ${entry.id} — ${entry.observed}`);
  if (!entry.passed) {
    console.log(`       expected: ${entry.expected}`);
    console.log(`       details:  ${sanitize(entry.details, root)}`);
  }
}

if (failed > 0) process.exitCode = 1;
