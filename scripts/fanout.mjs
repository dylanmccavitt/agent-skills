#!/usr/bin/env node
/**
 * Turn the latest gate report into ready-to-dispatch subagent briefs.
 *
 *   node scripts/fanout.mjs                 one brief per failing skill (default)
 *   node scripts/fanout.mjs --by scenario   one brief per failing scenario
 *   node scripts/fanout.mjs --mode live     read the live report instead of plumbing
 *   node scripts/fanout.mjs --json          machine-readable briefs
 *
 * Each brief is self-contained: it names the scenarios, the exact failing
 * assertions, the reproduce command, and the acceptance gate. Paste one into a
 * subagent call, or consume --json from a harness.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const valueOf = (flag, fallback) => {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const by = valueOf("--by", "skill");
const mode = valueOf("--mode", "plumbing");
const asJson = argv.includes("--json");

const reportPath = join(root, "evaluation", "reports", `latest-${mode}.json`);
if (!existsSync(reportPath)) {
  console.error(`fanout: no report at ${reportPath}\nRun: node scripts/gate.mjs${mode === "live" ? " --live" : ""}`);
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportPath, "utf8"));
if (!report.failures?.length) {
  console.log(`No failing scenarios in ${mode} report from ${report.timestamp}. Nothing to fan out.`);
  process.exit(0);
}

const REPRO = "node evaluation/skill-behavior-v1.mjs --runner evaluation/adapters/skill-behavior-cli.mjs --measure";
const GATE = "node scripts/gate.mjs";

function brief(title, scenarios) {
  const detail = scenarios.map((s) =>
    `- ${s.id}\n${s.assertions.map((a) => `    ${a}`).join("\n") || "    (no assertion detail)"}`).join("\n");
  const skills = [...new Set(scenarios.map((s) => s.skill))];
  return {
    name: `fix-${title}`.slice(0, 40),
    skills,
    scenario_ids: scenarios.map((s) => s.id),
    prompt: [
      `Improve the ${skills.join(" and ")} skill in the agent-skills repository at ${root}.`,
      ``,
      `These skill-behavior-v1 scenarios currently fail:`,
      detail,
      ``,
      `Rules:`,
      `- Read the failing assertion names in evaluation/skill-behavior-v1.mjs to learn the exact contract each one checks.`,
      `- Fix the SKILL.md guidance or the supporting CLI, not the evaluator or the scenarios. Changing the test to pass is a failure.`,
      `- Keep skills short guides; mechanics belong in the tooling.`,
      `- Preserve unrelated worktree changes and do not commit.`,
      ``,
      `Reproduce:  ${REPRO}`,
      `Acceptance: ${GATE} passes with no REGRESSION line, and these scenario ids no longer appear under [FAIL].`,
      ``,
      `Reply to the parent with: scenarios fixed, files changed, gate metric deltas, and anything you could not fix.`,
    ].join("\n"),
  };
}

const groups = new Map();
for (const f of report.failures) {
  const key = by === "scenario" ? f.id : f.skill;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(f);
}
const briefs = [...groups.entries()].map(([key, scenarios]) => brief(key, scenarios));

if (asJson) {
  process.stdout.write(`${JSON.stringify({ mode, source: report.timestamp, briefs }, null, 2)}\n`);
} else {
  console.log(`${briefs.length} brief(s) from the ${mode} report of ${report.timestamp}\n`);
  for (const b of briefs) {
    console.log(`=== ${b.name} (${b.scenario_ids.length} scenario(s)) ===`);
    console.log(b.prompt);
    console.log();
  }
  console.log("Dispatch from a Prime Agent kernel:");
  console.log(`  briefs = json.loads(subprocess.run(["node","scripts/fanout.mjs","--json"],`);
  console.log(`                      capture_output=True, text=True, cwd="${root}").stdout)["briefs"]`);
  console.log(`  for b in briefs: await rlm(b["prompt"], name=b["name"])`);
}
