#!/usr/bin/env node
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readAuditRecords } from "./lib/audit-log.mjs";
import { invokeAgentCli, resolveAgentCommand } from "./lib/invoke-agent-cli.mjs";
import { mapEvents } from "./lib/map-events.mjs";
import { materializeFixture } from "./lib/materialize-fixture.mjs";
import { persistTranscript } from "./lib/persist-transcript.mjs";
import { assertRunnerRequest, readStdinJson } from "./lib/read-stdin-json.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const wrappersDir = join(repoRoot, "evaluation", "wrappers", "skill-behavior-v1");

function modeFromEnv(env = process.env) {
  if (env.SKILL_BEHAVIOR_MODE === "plumbing") return "plumbing";
  if (!env.SKILL_BEHAVIOR_AGENT_CMD) return "plumbing";
  return "live";
}

export async function runAdapter({
  request = assertRunnerRequest(readStdinJson(), process.env.SKILL_BEHAVIOR_SCENARIO_ID),
  env = process.env,
} = {}) {
  const mode = modeFromEnv(env);
  const fixture = materializeFixture({
    scenario: request.scenario,
    skills: request.skills,
  });

  const agentArgv = mode === "live" ? resolveAgentCommand(env) : null;
  const agent = invokeAgentCli({
    argv: agentArgv,
    cwd: fixture.projectDir,
    env: {
      ...env,
      PATH: `${wrappersDir}:${env.PATH || ""}`,
      DECISION_SHELF_HOME: fixture.shelfDir,
      SKILL_BEHAVIOR_AUDIT_LOG: fixture.auditLog,
      SKILL_BEHAVIOR_RUN_ROOT: fixture.root,
    },
    prompt: request.scenario.prompt,
    skillsDir: fixture.skillsDir,
    contextPath: fixture.contextPath,
    answersPath: fixture.answersPath,
  });

  const transcript = mapEvents({
    scenario: request.scenario,
    agentStdout: agent.stdout,
    agentStderr: agent.stderr,
    auditRecords: readAuditRecords(fixture.auditLog),
    shelfDir: fixture.shelfDir,
    mode: agent.skipped ? "plumbing" : mode,
  });

  if (!agent.skipped && agent.error) {
    transcript.final = `${transcript.final}\nAgent invoke error: ${agent.error}`;
  }

  const persisted = persistTranscript(env.SKILL_BEHAVIOR_TRANSCRIPT_DIR, transcript);
  if (persisted) {
    transcript.metrics = transcript.metrics || {};
  }

  return { transcript, fixture, agent, mode: agent.skipped ? "plumbing" : mode };
}

async function main() {
  try {
    const { transcript } = await runAdapter();
    process.stdout.write(`${JSON.stringify(transcript)}\n`);
  } catch (error) {
    console.error(error?.stack || String(error));
    process.exit(1);
  }
}

const isMain =
  Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  await main();
}
