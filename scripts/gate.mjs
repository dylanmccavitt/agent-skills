#!/usr/bin/env node
/**
 * Improvement-loop gate for agent-skills.
 *
 * One command that runs every documented check, records a timestamped report,
 * and fails when a tracked metric regresses against the recorded baseline.
 *
 *   node scripts/gate.mjs             plumbing behavior baseline (deterministic, free)
 *   node scripts/gate.mjs --live      score the skills against a real Prime Agent
 *   node scripts/gate.mjs --accept    write the current run as the new baseline
 *   node scripts/gate.mjs --json      machine-readable summary on stdout
 *   node scripts/gate.mjs --only behavior[,adversarial,tests,validate]
 *
 * Reports land in evaluation/reports/. The baseline lives in
 * evaluation/reports/baseline.json and is committed on purpose: it is the
 * record of what this package already proved.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportsDir = join(root, "evaluation", "reports");
const baselinePath = join(reportsDir, "baseline.json");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const live = has("--live");
const asJson = has("--json");
const accept = has("--accept");
const STAGE_NAMES = ["validate", "tests", "adversarial", "behavior"];
const onlyArg = argv.find((a) => a.startsWith("--only"));
const only = onlyArg
  ? (onlyArg.includes("=") ? onlyArg.split("=")[1] : argv[argv.indexOf(onlyArg) + 1] || "")
      .split(",").map((s) => s.trim()).filter(Boolean)
  : null;
// An empty array is truthy, so an empty or misspelled --only would silently select no stage
// and the gate would report success having checked nothing. A selection that names no real
// stage is a misconfiguration, not a pass.
if (only) {
  const unknown = only.filter((s) => !STAGE_NAMES.includes(s));
  if (only.length === 0 || unknown.length > 0) {
    const detail = only.length === 0
      ? "--only needs at least one stage"
      : `unknown stage(s): ${unknown.join(", ")}`;
    console.error(`gate: ${detail}\ngate: valid stages are ${STAGE_NAMES.join(", ")}`);
    process.exit(2);
  }
}
const wants = (stage) => !only || only.includes(stage);

const EXPECTED_SCENARIOS = 24;

// Metrics that must never go down (or up, for rates that measure failure).
const GUARDED = {
  scenarios_passed: "up",
  scenario_pass_rate: "up",
  activation_accuracy: "up",
  contract_pass_rate: "up",
  false_activation_rate: "down",
  adversarial_cases_passed: "up",
};

function run(name, cmd, args, env = {}) {
  const started = Date.now();
  const proc = spawnSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${proc.stdout || ""}${proc.stderr || ""}`;
  return { name, ok: proc.status === 0, code: proc.status ?? -1, out, ms: Date.now() - started };
}

function parseMetrics(text) {
  const metrics = {};
  for (const line of text.split("\n")) {
    const m = /^METRIC ([a-z0-9_]+)=(.+)$/.exec(line.trim());
    if (!m) continue;
    const value = m[2] === "null" ? null : Number(m[2]);
    metrics[m[1]] = Number.isNaN(value) ? m[2] : value;
  }
  return metrics;
}

function parseFailures(text) {
  const failures = [];
  let current = null;
  for (const raw of text.split("\n")) {
    const fail = /^\[FAIL\] (\S+)/.exec(raw);
    if (fail) {
      current = { id: fail[1], skill: fail[1].split(".")[0], assertions: [] };
      failures.push(current);
      continue;
    }
    if (/^\[PASS\]/.test(raw)) { current = null; continue; }
    if (current && /^\s{2,}\S/.test(raw)) current.assertions.push(raw.trim());
  }
  return failures;
}

// ---------------------------------------------------------------- stages

const stages = [];
const metrics = {};
let failures = [];
let report_infra = [];
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

if (wants("validate")) stages.push(run("validate:skills", "npm", ["run", "--silent", "validate:skills"]));
if (wants("tests")) stages.push(run("unit tests", "npm", ["test", "--silent"]));

if (wants("adversarial")) {
  const adv = run("adversarial-v1", "./autoresearch.sh", []);
  Object.assign(metrics, parseMetrics(adv.out));
  const cases = /Cases: (\d+) \| pass: (\d+) \| fail: (\d+)/.exec(adv.out);
  if (cases) {
    metrics.adversarial_cases_total = Number(cases[1]);
    metrics.adversarial_cases_passed = Number(cases[2]);
  }
  stages.push(adv);
}

if (wants("behavior")) {
  const env = {};
  if (live) {
    // The adapter runs with cwd set to a throw-away fixture project, so the
    // command must be absolute or node cannot find it.
    env.SKILL_BEHAVIOR_AGENT_CMD =
      process.env.SKILL_BEHAVIOR_AGENT_CMD ||
      JSON.stringify(["node", join(root, "evaluation", "adapters", "prime-agent-print.mjs")]);
    env.SKILL_BEHAVIOR_MODE = "live";
    // Persist transcripts so an infrastructure failure (adapter timeout,
    // spawn error) is distinguishable from a skill that was not selected.
    env.SKILL_BEHAVIOR_TRANSCRIPT_DIR =
      process.env.SKILL_BEHAVIOR_TRANSCRIPT_DIR || join(reportsDir, "transcripts", stamp);
  }
  // One invocation only. A live run is nondeterministic and costs model
  // tokens, so metrics and per-scenario failures must come from the same run.
  const beh = run(live ? "skill-behavior-v1 (live)" : "skill-behavior-v1 (plumbing)",
    "node", ["evaluation/skill-behavior-v1.mjs", "--runner",
             "evaluation/adapters/skill-behavior-cli.mjs", "--measure"], env);
  Object.assign(metrics, parseMetrics(beh.out));
  failures = parseFailures(beh.out);
  metrics.behavior_mode = live ? "live" : "plumbing";

  const counted = /Scenarios: (\d+) \| pass: (\d+) \| fail: (\d+)/.exec(beh.out);
  if (!counted) {
    beh.ok = false;
    beh.out += "\ngate: scenario summary line missing";
  } else {
    metrics.scenarios_total = Number(counted[1]);
    if (Number(counted[1]) !== EXPECTED_SCENARIOS) {
      beh.ok = false;
      beh.out += `\ngate: expected ${EXPECTED_SCENARIOS} scenarios, saw ${counted[1]}`;
    }
  }
  stages.push(beh);

  // Separate infrastructure failures from behavior failures. An adapter
  // timeout loses the agent's stdout, which otherwise scores as "skill not
  // selected" and silently understates activation.
  const tdir = env.SKILL_BEHAVIOR_TRANSCRIPT_DIR;
  if (tdir && existsSync(tdir)) {
    const infra = [];
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.name.endsWith(".json")) continue;
        let doc;
        try { doc = JSON.parse(readFileSync(full, "utf8")); } catch { continue; }
        const final = String(doc.final || "");
        const m = /Agent invoke error: (.+)/.exec(final);
        if (m) infra.push({ id: doc.id, error: m[1].trim() });
        else if (/No agent stdout for/.test(final)) infra.push({ id: doc.id, error: "empty stdout" });
      }
    };
    walk(tdir);
    metrics.agent_invoke_failures = infra.length;
    report_infra = infra;
  }
}

// ---------------------------------------------------------------- report

const mode = live ? "live" : "plumbing";
const head = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" })
  .stdout?.trim() || "unknown";
const dirty = (spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
  .stdout || "").trim().length > 0;

const report = {
  timestamp: new Date().toISOString(),
  mode, head, dirty,
  stages: stages.map(({ name, ok, code, ms }) => ({ name, ok, code, ms })),
  metrics,
  failures,
  failing_ids: failures.map((f) => f.id),
  infrastructure_failures: report_infra,
  failing_by_skill: failures.reduce((acc, f) => {
    (acc[f.skill] ||= []).push(f.id);
    return acc;
  }, {}),
};

mkdirSync(reportsDir, { recursive: true });
writeFileSync(join(reportsDir, `gate-${mode}-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(join(reportsDir, `latest-${mode}.json`), `${JSON.stringify(report, null, 2)}\n`);

// ---------------------------------------------------------------- verdict

const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : null;
const regressions = [];
const gains = [];
// A baseline marked stale describes behavior that a later change invalidated, so
// guarding against it would block the very run meant to replace it: truthful
// lower scores would count as regressions, and a regression refuses --accept.
// A stale entry is therefore reported but never guarded.
const baselineStale = Boolean(baseline?.[mode]?.stale);
if (baseline?.[mode] && !baselineStale) {
  for (const [key, direction] of Object.entries(GUARDED)) {
    const was = baseline[mode][key];
    const now = metrics[key];
    if (typeof was !== "number" || typeof now !== "number") continue;
    const worse = direction === "up" ? now < was : now > was;
    const better = direction === "up" ? now > was : now < was;
    if (worse) regressions.push({ metric: key, was, now });
    if (better) gains.push({ metric: key, was, now });
  }
}
report.regressions = regressions;
report.gains = gains;
report.baseline_stale = baselineStale;

const stageFailed = stages.filter((s) => !s.ok);
// Defence in depth: whatever the selection, a run that executed no stage proved nothing.
const ranNothing = stages.length === 0;
const failed = stageFailed.length > 0 || regressions.length > 0 || ranNothing;

// A baseline is the record of proven behavior, so it is only rewritten when the
// run actually proved something: every stage passed and no guarded metric
// regressed. Writing first and failing afterwards would leave a worse baseline
// on disk even though the gate reported failure.
// A partial run cannot prove a baseline either: the skipped stages contribute no
// metrics, so accepting one would drop the guarded keys it never measured.
const partialRun = Boolean(only);
const acceptBlockedReason = failed
  ? "the gate failed"
  : partialRun
    ? "the run was partial (--only)"
    : null;
const acceptBlocked = accept && acceptBlockedReason !== null;
report.accept_blocked = acceptBlocked;
report.accept_blocked_reason = acceptBlocked ? acceptBlockedReason : null;
if (accept && !acceptBlocked) {
  const next = baseline || {};
  next[mode] = Object.fromEntries(
    Object.keys(GUARDED).filter((k) => typeof metrics[k] === "number").map((k) => [k, metrics[k]]));
  next[mode].recorded_at = new Date().toISOString();
  next[mode].head = head;
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const line = (s) => `  ${s.ok ? "ok  " : "FAIL"}  ${s.name} (${(s.ms / 1000).toFixed(1)}s)`;
  console.log(`\nagent-skills gate · ${mode} · ${head}${dirty ? " (dirty)" : ""}`);
  stages.forEach((s) => console.log(line(s)));
  const keys = Object.keys(GUARDED).filter((k) => metrics[k] !== undefined);
  if (keys.length) {
    console.log("\n  metrics");
    keys.forEach((k) => console.log(`    ${k.padEnd(24)} ${metrics[k]}`));
  }
  if (failures.length) {
    console.log(`\n  ${failures.length} failing scenario(s):`);
    for (const [skill, ids] of Object.entries(report.failing_by_skill)) {
      console.log(`    ${skill.padEnd(8)} ${ids.length}  ${ids.join(", ")}`);
    }
  }
  if (report_infra.length) {
    console.log(`\n  ${report_infra.length} infrastructure failure(s) (NOT skill behavior):`);
    report_infra.forEach((i) => console.log(`    ${i.id}: ${i.error}`));
  }
  gains.forEach((g) => console.log(`  gain  ${g.metric}: ${g.was} -> ${g.now}`));
  regressions.forEach((r) => console.log(`  REGRESSION ${r.metric}: ${r.was} -> ${r.now}`));
  if (!baseline) console.log("\n  no baseline recorded yet; run with --accept to set one");
  if (ranNothing) console.log("\n  FAIL: no stage ran, so nothing was proven");
  if (baselineStale) {
    console.log(`\n  baseline for ${mode} is marked stale and is NOT guarded; re-record it with --accept`);
  }
  if (acceptBlocked) {
    console.log(`\n  baseline NOT updated: ${acceptBlockedReason}, so --accept was refused`);
  }
  console.log(`\n  report: evaluation/reports/latest-${mode}.json`);
  stageFailed.forEach((s) => console.log(`\n--- ${s.name} output ---\n${s.out.trim().slice(-2000)}`));
}

process.exit(failed ? 1 : 0);
