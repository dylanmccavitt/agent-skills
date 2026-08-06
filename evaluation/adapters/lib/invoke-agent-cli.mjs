import { spawnSync } from "node:child_process";

function parseAgentCommand(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  if (!text) return null;
  if (text.startsWith("[")) {
    const argv = JSON.parse(text);
    if (!Array.isArray(argv) || argv.length === 0) {
      throw new Error("SKILL_BEHAVIOR_AGENT_CMD JSON array must be non-empty");
    }
    return argv.map(String);
  }
  return ["sh", "-c", text];
}

export function resolveAgentCommand(env = process.env) {
  return parseAgentCommand(env.SKILL_BEHAVIOR_AGENT_CMD);
}

export function invokeAgentCli({
  argv,
  cwd,
  env,
  prompt,
  skillsDir,
  contextPath,
  answersPath,
  timeoutMs = 120_000,
}) {
  if (!argv?.length) {
    return {
      skipped: true,
      status: null,
      stdout: "",
      stderr: "SKILL_BEHAVIOR_AGENT_CMD unset; live agent not invoked",
    };
  }

  const childEnv = {
    ...process.env,
    ...env,
    SKILL_BEHAVIOR_PROMPT: prompt,
    SKILL_BEHAVIOR_SKILLS_DIR: skillsDir,
    SKILL_BEHAVIOR_CONTEXT_PATH: contextPath || "",
    SKILL_BEHAVIOR_ANSWERS_PATH: answersPath || "",
  };

  const run = spawnSync(argv[0], argv.slice(1), {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    input: `${prompt}\n`,
  });

  return {
    skipped: false,
    status: run.status,
    signal: run.signal,
    error: run.error ? run.error.message : null,
    stdout: run.stdout || "",
    stderr: run.stderr || "",
  };
}
