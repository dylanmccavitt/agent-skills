#!/usr/bin/env node
/**
 * Prime Agent bridge for skill-behavior-cli.
 *
 * Invoked via:
 *   SKILL_BEHAVIOR_AGENT_CMD='["node","evaluation/adapters/prime-agent-print.mjs"]'
 *
 * Reads evaluator-provided env:
 *   SKILL_BEHAVIOR_PROMPT
 *   SKILL_BEHAVIOR_SKILLS_DIR
 *   SKILL_BEHAVIOR_CONTEXT_PATH
 *   SKILL_BEHAVIOR_ANSWERS_PATH
 *
 * Optional overrides:
 *   SKILL_BEHAVIOR_PRIME_BIN       binary name (default: prime-agent)
 *   SKILL_BEHAVIOR_PRIME_THINKING  reasoning level (default: low)
 *   SKILL_BEHAVIOR_PRIME_MODEL     model id passed to --model
 *   SKILL_BEHAVIOR_PRIME_PROVIDER  provider passed to --provider
 *
 * The run is hermetic on purpose: skill discovery is disabled and only the
 * fixture's candidate skills are loaded with explicit --skill paths, so the
 * operator's installed skills cannot contaminate a score.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

function readJson(path, fallback = null) {
  if (!path || !existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

const prompt = process.env.SKILL_BEHAVIOR_PROMPT || "";
const skillsDir = process.env.SKILL_BEHAVIOR_SKILLS_DIR || "";
const context = readJson(process.env.SKILL_BEHAVIOR_CONTEXT_PATH, {});
const answers = readJson(process.env.SKILL_BEHAVIOR_ANSWERS_PATH, null);

const skillDirs = existsSync(skillsDir)
  ? readdirSync(skillsDir)
      .map((name) => join(skillsDir, name))
      .filter((path) => existsSync(join(path, "SKILL.md")))
  : [];
const skillNames = skillDirs.map((path) => path.split("/").pop());

const instructions = `You are being scored by agent-skills/skill-behavior-v1.
Candidate skills are already present in .agents/skills (${skillNames.join(", ") || "none"}).
Choose zero or more skills based on the user prompt and context. Do not assume an expected target.
When you select skills, print exactly one line:
SKILL_BEHAVIOR_SELECTED: ["skill-a","skill-b"]
For interactive asks, print JSON event lines with type "ask" (native:true, 2-3 options, recommended:0). Scout asks also need turn.
Only claim record/prototype/receipt events if you actually invoked decision-shelf or delivery via PATH.
Context JSON: ${JSON.stringify(context)}
${answers ? `Scripted answers available for interactive turns (use in order when asking): ${JSON.stringify(answers)}` : ""}
User prompt:
${prompt}
`;

const argv = [
  process.env.SKILL_BEHAVIOR_PRIME_BIN || "prime-agent",
  "-p",
  "--no-session",
  "--no-skills",
  "--no-extensions",
  "--no-context-files",
  "--thinking",
  process.env.SKILL_BEHAVIOR_PRIME_THINKING || "low",
];

for (const dir of skillDirs) argv.push("--skill", dir);
if (process.env.SKILL_BEHAVIOR_PRIME_PROVIDER) {
  argv.push("--provider", process.env.SKILL_BEHAVIOR_PRIME_PROVIDER);
}
if (process.env.SKILL_BEHAVIOR_PRIME_MODEL) {
  argv.push("--model", process.env.SKILL_BEHAVIOR_PRIME_MODEL);
}
argv.push("--", instructions);

const run = spawnSync(argv[0], argv.slice(1), {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
  maxBuffer: 8 * 1024 * 1024,
});

if (run.error) {
  process.stderr.write(`prime-agent adapter: ${run.error.message}\n`);
  process.exit(1);
}
if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
process.exit(run.status ?? 1);
