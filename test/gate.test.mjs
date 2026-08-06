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
