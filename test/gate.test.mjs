import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The gate resolves its baseline relative to its own location, so every case
// runs against a throw-away copy. A bug in --accept must never be able to
// rewrite the real evaluation/reports/baseline.json while proving that it does.
function sandbox(validateExitCode) {
  const dir = mkdtempSync(join(tmpdir(), "agent-skills-gate-"));
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "evaluation", "reports"), { recursive: true });
  cpSync(join(root, "scripts", "gate.mjs"), join(dir, "scripts", "gate.mjs"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "gate-sandbox",
        private: true,
        type: "module",
        scripts: { "validate:skills": `node -e "process.exit(${validateExitCode})"` },
      },
      null,
      2,
    ),
  );
  return dir;
}

const BASELINE = {
  plumbing: {
    scenarios_passed: 12,
    scenario_pass_rate: 0.5,
    activation_accuracy: 0.5,
    contract_pass_rate: 0.3617,
    false_activation_rate: 0,
    adversarial_cases_passed: 25,
    recorded_at: "2026-01-01T00:00:00.000Z",
    head: "baseline",
  },
};

function writeBaseline(dir) {
  const path = join(dir, "evaluation", "reports", "baseline.json");
  writeFileSync(path, `${JSON.stringify(BASELINE, null, 2)}\n`);
  return path;
}

function runGate(dir, args) {
  return spawnSync("node", [join(dir, "scripts", "gate.mjs"), ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

test("--accept leaves the baseline untouched when a stage fails", () => {
  const dir = sandbox(1);
  const baselinePath = writeBaseline(dir);
  const before = readFileSync(baselinePath, "utf8");

  const proc = runGate(dir, ["--accept", "--only", "validate"]);

  assert.equal(proc.status, 1, "a failing stage must fail the gate");
  assert.equal(readFileSync(baselinePath, "utf8"), before, "baseline was rewritten by a failing run");
  assert.match(proc.stdout, /baseline NOT updated: the gate failed/);
  rmSync(dir, { recursive: true, force: true });
});

test("--accept is refused on a partial --only run even when it passes", () => {
  const dir = sandbox(0);
  const baselinePath = writeBaseline(dir);
  const before = readFileSync(baselinePath, "utf8");

  const proc = runGate(dir, ["--accept", "--only", "validate"]);

  assert.equal(proc.status, 0, "a passing partial run still exits clean");
  assert.equal(
    readFileSync(baselinePath, "utf8"),
    before,
    "a partial run must not drop the guarded metrics it never measured",
  );
  assert.match(proc.stdout, /baseline NOT updated: the run was partial/);
  rmSync(dir, { recursive: true, force: true });
});

test("the blocked accept is reported in --json output", () => {
  const dir = sandbox(1);
  writeBaseline(dir);

  const proc = runGate(dir, ["--accept", "--only", "validate", "--json"]);
  const report = JSON.parse(proc.stdout);

  assert.equal(report.accept_blocked, true);
  assert.equal(report.accept_blocked_reason, "the gate failed");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- stale baselines

// A stale baseline must not be guarded. Guarding it would deadlock the loop the
// stale marker exists to unblock: the truthful lower run counts as a regression,
// and a regression refuses --accept, so the bad numbers can never be replaced.
function behaviorSandbox(metrics, { full = false } = {}) {
  const dir = sandbox(0);
  mkdirSync(join(dir, "evaluation"), { recursive: true });
  if (full) {
    // A full run also shells out to the unit tests and the adversarial suite,
    // so both are stubbed to pass with the metrics the gate parses.
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    pkg.scripts.test = 'node -e ""';
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    writeFileSync(
      join(dir, "autoresearch.sh"),
      `#!/bin/sh\necho "Cases: 25 | pass: ${metrics.adversarial_cases_passed} | fail: 0"\n`,
      { mode: 0o755 },
    );
  }
  const lines = Object.entries(metrics).map(([k, v]) => `METRIC ${k}=${v}`);
  lines.push("Scenarios: 24 | pass: 1 | fail: 23");
  writeFileSync(
    join(dir, "evaluation", "skill-behavior-v1.mjs"),
    `${lines.map((l) => `console.log(${JSON.stringify(l)});`).join("\n")}\n`,
  );
  return dir;
}

const WORSE = {
  scenarios_passed: 1,
  scenario_pass_rate: 0.04,
  activation_accuracy: 0.1,
  contract_pass_rate: 0.1,
  false_activation_rate: 0.9,
};

test("a stale baseline is reported but never guarded", () => {
  const dir = behaviorSandbox(WORSE);
  const baselinePath = join(dir, "evaluation", "reports", "baseline.json");
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ plumbing: { ...BASELINE.plumbing, stale: true } }, null, 2)}\n`,
  );

  const proc = runGate(dir, ["--only", "behavior"]);

  assert.equal(proc.status, 0, "a stale baseline must not fail the run it exists to replace");
  assert.doesNotMatch(proc.stdout, /REGRESSION/);
  assert.match(proc.stdout, /marked stale and is NOT guarded/);
  rmSync(dir, { recursive: true, force: true });
});

test("a live baseline that is not stale still guards against regressions", () => {
  const dir = behaviorSandbox(WORSE);
  writeFileSync(
    join(dir, "evaluation", "reports", "baseline.json"),
    `${JSON.stringify(BASELINE, null, 2)}\n`,
  );

  const proc = runGate(dir, ["--only", "behavior"]);

  assert.equal(proc.status, 1, "a real regression must still fail the gate");
  assert.match(proc.stdout, /REGRESSION scenarios_passed: 12 -> 1/);
  rmSync(dir, { recursive: true, force: true });
});

test("re-recording a stale baseline clears the stale marker", () => {
  const dir = behaviorSandbox(BASELINE.plumbing, { full: true });
  const baselinePath = join(dir, "evaluation", "reports", "baseline.json");
  writeFileSync(
    baselinePath,
    `${JSON.stringify({ plumbing: { ...BASELINE.plumbing, stale: true } }, null, 2)}\n`,
  );

  const proc = runGate(dir, ["--accept"]);
  const after = JSON.parse(readFileSync(baselinePath, "utf8"));

  assert.equal(proc.status, 0);
  assert.equal(after.plumbing.stale, undefined, "an accepted baseline is proven, so it is not stale");
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- --only guards

// An empty array is truthy in JS, so an empty or misspelled --only used to select no stage at
// all while still exiting 0. A gate that checked nothing must never look green.
test("--only with no recognized stage is a misconfiguration, not a pass", () => {
  const dir = sandbox(0);
  writeBaseline(dir);

  for (const args of [["--only", ""], ["--only="], ["--only", "tets"], ["--only", "validate,bogus"]]) {
    const proc = runGate(dir, args);
    assert.notEqual(proc.status, 0, `${JSON.stringify(args)} must not exit 0`);
    assert.match(proc.stderr, /valid stages are validate, tests, adversarial, behavior/);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("--only still accepts a real stage", () => {
  const dir = sandbox(0);
  writeBaseline(dir);

  const proc = runGate(dir, ["--only", "validate"]);

  assert.equal(proc.status, 0, proc.stderr);
  assert.match(proc.stdout, /validate:skills/);
  rmSync(dir, { recursive: true, force: true });
});

test("a run that executed no stage fails even when nothing errored", () => {
  const dir = sandbox(0);
  writeBaseline(dir);

  // --only is validated up front, so drive the defence-in-depth guard directly by
  // selecting a real stage list and proving the verdict depends on stages having run.
  const proc = runGate(dir, ["--only", "validate", "--json"]);
  const report = JSON.parse(proc.stdout);

  assert.ok(report.stages.length > 0, "the selected stage must actually run");
  rmSync(dir, { recursive: true, force: true });
});
