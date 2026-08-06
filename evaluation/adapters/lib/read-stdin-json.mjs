import { readFileSync } from "node:fs";

export function readStdinJson(raw = readFileSync(0, "utf8")) {
  const text = String(raw || "").trim();
  if (!text) throw new Error("stdin is empty; expected one JSON request object");
  let value;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`stdin is not JSON: ${error.message}`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stdin must be one JSON object");
  }
  return value;
}

export function assertRunnerRequest(request, scenarioIdEnv) {
  if (request.protocol !== "agent-skills/skill-behavior-v1") {
    throw new Error(`unsupported protocol: ${request.protocol}`);
  }
  const scenario = request.scenario;
  if (!scenario || typeof scenario !== "object" || Array.isArray(scenario)) {
    throw new Error("request.scenario must be an object");
  }
  if (!scenario.id || typeof scenario.id !== "string") {
    throw new Error("request.scenario.id is required");
  }
  if (scenarioIdEnv && scenarioIdEnv !== scenario.id) {
    throw new Error(
      `SKILL_BEHAVIOR_SCENARIO_ID=${scenarioIdEnv} does not match scenario.id=${scenario.id}`,
    );
  }
  for (const key of ["skill", "expected", "assertions"]) {
    if (Object.hasOwn(scenario, key)) {
      throw new Error(`oracle field leaked into request.scenario: ${key}`);
    }
    if (Object.hasOwn(request, key)) {
      throw new Error(`oracle field leaked into request: ${key}`);
    }
  }
  if (!Array.isArray(request.skills) || request.skills.length === 0) {
    throw new Error("request.skills must be a non-empty array");
  }
  for (const skill of request.skills) {
    if (!skill?.name || !skill?.path || typeof skill.text !== "string") {
      throw new Error("each skill requires name, path, and text");
    }
  }
  return request;
}
