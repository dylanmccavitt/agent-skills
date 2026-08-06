#!/usr/bin/env node
/**
 * Live agent bridge for skill-behavior-cli.
 *
 * Invoked via:
 *   SKILL_BEHAVIOR_AGENT_CMD='["node","evaluation/adapters/omp-print-agent.mjs"]'
 *
 * Reads evaluator-provided env:
 *   SKILL_BEHAVIOR_PROMPT
 *   SKILL_BEHAVIOR_SKILLS_DIR
 *   SKILL_BEHAVIOR_CONTEXT_PATH
 *   SKILL_BEHAVIOR_ANSWERS_PATH
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

const skillNames = existsSync(skillsDir)
  ? readdirSync(skillsDir).filter((name) => existsSync(join(skillsDir, name, "SKILL.md")))
  : [];

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
  "omp",
  "-p",
  "--no-session",
  "--auto-approve",
  "--max-time",
  process.env.SKILL_BEHAVIOR_OMP_MAX_TIME || "3m",
  "--thinking",
  process.env.SKILL_BEHAVIOR_OMP_THINKING || "low",
  instructions,
];

const run = spawnSync(argv[0], argv.slice(1), {
  cwd: process.cwd(),
  encoding: "utf8",
  env: process.env,
  maxBuffer: 8 * 1024 * 1024,
});

if (run.stdout) process.stdout.write(run.stdout);
if (run.stderr) process.stderr.write(run.stderr);
process.exit(run.status ?? 1);
