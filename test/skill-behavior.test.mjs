import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  gradeScenarios,
  loadScenarios,
  loadTranscripts,
  runScenarios,
  summarize,
  validateScenarios,
} from "../evaluation/skill-behavior-v1.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const evaluatorPath = resolve(root, "evaluation", "skill-behavior-v1.mjs");
const fixedScenariosPath = resolve(root, "evaluation", "skill-behavior-v1.scenarios.json");

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "skill-behavior-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function transcript(id, selectedSkills = [], overrides = {}) {
  return {
    id,
    selected_skills: selectedSkills,
    events: [],
    final: "Completed.",
    ...overrides,
  };
}

function compactScenarios() {
  return [
    {
      id: "synthetic.compass-positive",
      skill: "compass",
      prompt: "Help me choose an unsettled architecture direction.",
      expected: {
        selected: true,
        assertions: ["compass_one_native_question", "compass_no_implementation"],
      },
    },
    {
      id: "synthetic.relay-negative",
      skill: "relay",
      prompt: "Answer one local factual question.",
      expected: { selected: false, assertions: [] },
    },
  ];
}

function passingCompactTranscripts() {
  return [
    transcript("synthetic.compass-positive", ["compass"], {
      events: [
        {
          type: "ask",
          native: true,
          options: ["Database queue", "Managed queue"],
          recommended: 0,
        },
      ],
    }),
    transcript("synthetic.relay-negative", ["compass"]),
  ];
}

test("loads the fixed 24-case suite with balanced activation coverage per skill", () => {
  const scenarios = loadScenarios(fixedScenariosPath);
  const coverage = Object.fromEntries(
    ["scout", "compass", "relay", "cairn"].map((skill) => [
      skill,
      {
        positive: scenarios.filter(
          (scenario) => scenario.skill === skill && scenario.expected.selected,
        ).length,
        negative: scenarios.filter(
          (scenario) => scenario.skill === skill && !scenario.expected.selected,
        ).length,
      },
    ]),
  );

  assert.equal(scenarios.length, 24);
  assert.deepEqual(coverage, {
    scout: { positive: 3, negative: 3 },
    compass: { positive: 3, negative: 3 },
    relay: { positive: 3, negative: 3 },
    cairn: { positive: 3, negative: 3 },
  });
});

test("rejects duplicate, unknown, and malformed scenario contracts", () => {
  const cases = [
    {
      name: "duplicate id",
      mutate(scenarios) {
        scenarios[1].id = scenarios[0].id;
      },
      error: /scenario id must be non-empty and unique/,
    },
    {
      name: "unknown skill",
      mutate(scenarios) {
        scenarios[0].skill = "unknown";
      },
      error: /unknown skill unknown/,
    },
    {
      name: "non-boolean selection oracle",
      mutate(scenarios) {
        scenarios[0].expected.selected = "yes";
      },
      error: /expected\.selected must be boolean/,
    },
    {
      name: "unknown behavioral assertion",
      mutate(scenarios) {
        scenarios[0].expected.assertions = ["compass_nonexistent_contract"];
      },
      error: /unknown assertion compass_nonexistent_contract/,
    },
    {
      name: "missing prompt",
      mutate(scenarios) {
        scenarios[0].prompt = " ";
      },
      error: /prompt must be non-empty/,
    },
    {
      name: "unknown excluded skill",
      mutate(scenarios) {
        scenarios[0].expected.excluded = ["unknown"];
      },
      error: /expected\.excluded must contain unique competing skills/,
    },
    {
      name: "target skill excluded",
      mutate(scenarios) {
        scenarios[0].expected.excluded = [scenarios[0].skill];
      },
      error: /expected\.excluded must contain unique competing skills/,
    },
    {
      name: "duplicate excluded skill",
      mutate(scenarios) {
        scenarios[0].expected.excluded = ["compass", "compass"];
      },
      error: /expected\.excluded must contain unique competing skills/,
    },
    {
      name: "non-array excluded skills",
      mutate(scenarios) {
        scenarios[0].expected.excluded = "compass";
      },
      error: /expected\.excluded must contain unique competing skills/,
    },
  ];

  for (const { name, mutate, error } of cases) {
    const scenarios = structuredClone(loadScenarios(fixedScenariosPath));
    mutate(scenarios);
    assert.throws(() => validateScenarios(scenarios), error, name);
  }
});

test("grades target-skill selection and behavioral assertions from transcript outcomes", () => {
  const scenarios = compactScenarios();
  const passing = gradeScenarios(scenarios, passingCompactTranscripts());

  assert.deepEqual(
    passing.map((result) => ({
      id: result.id,
      selected: result.selected,
      activationPassed: result.activationPassed,
      checks: result.checks.map(({ name, passed }) => ({ name, passed })),
      passed: result.passed,
    })),
    [
      {
        id: "synthetic.compass-positive",
        selected: true,
        activationPassed: true,
        checks: [
          { name: "compass_one_native_question", passed: true },
          { name: "compass_no_implementation", passed: true },
        ],
        passed: true,
      },
      {
        id: "synthetic.relay-negative",
        selected: false,
        activationPassed: true,
        checks: [],
        passed: true,
      },
    ],
  );

  const failing = gradeScenarios(scenarios, [
    transcript("synthetic.compass-positive", ["compass"], {
      events: [
        {
          type: "ask",
          native: false,
          options: ["Only choice"],
          recommended: 1,
        },
        { type: "production_change" },
      ],
      metrics: { input_tokens: 10, output_tokens: 4, total_cost_usd: 0.01 },
    }),
    transcript("synthetic.relay-negative", ["relay"], {
      metrics: { input_tokens: 5, total_cost_usd: 0.02 },
    }),
  ]);

  assert.equal(failing[0].activationPassed, true);
  assert.deepEqual(
    failing[0].checks.map(({ name, passed }) => ({ name, passed })),
    [
      { name: "compass_one_native_question", passed: false },
      { name: "compass_no_implementation", passed: false },
    ],
  );
  assert.equal(failing[0].passed, false);
  assert.equal(failing[1].selected, true);
  assert.equal(failing[1].activationPassed, false);
  assert.equal(failing[1].passed, false);

  assert.deepEqual(summarize(failing), {
    scenariosPassed: 0,
    scenariosTotal: 2,
    scenarioPassRate: 0,
    activationAccuracy: 0.5,
    falseActivationRate: 1,
    contractPassRate: 0,
    inputTokens: 15,
    outputTokens: null,
    totalCostUsd: 0.03,
  });
});

test("co-selecting the excluded Scout or Compass candidate fails activation", () => {
  for (const { target, excluded } of [
    { target: "scout", excluded: "compass" },
    { target: "compass", excluded: "scout" },
  ]) {
    const scenario = {
      id: `synthetic.${target}-with-${excluded}`,
      skill: target,
      prompt: `Use ${target}, not ${excluded}.`,
      expected: { selected: true, excluded: [excluded], assertions: [] },
    };
    const [result] = gradeScenarios(
      [scenario],
      [transcript(scenario.id, [target, excluded])],
    );

    assert.equal(result.selected, true);
    assert.deepEqual(result.excludedSelected, [excluded]);
    assert.equal(result.activationPassed, false);
    assert.equal(result.passed, false);
  }
});

test("keeps provider metrics null unless every transcript reports them", () => {
  const scenarios = compactScenarios();
  const results = gradeScenarios(
    scenarios,
    passingCompactTranscripts().map((value, index) => ({
      ...value,
      metrics: index === 0 ? { input_tokens: 8, output_tokens: 3 } : {},
    })),
  );

  const summary = summarize(results);
  assert.equal(summary.inputTokens, null);
  assert.equal(summary.outputTokens, null);
  assert.equal(summary.totalCostUsd, null);
});

test("rejects incomplete, duplicate, and mismatched transcript sets", (t) => {
  const directory = temporaryDirectory(t);
  const scenarios = compactScenarios();
  const valid = passingCompactTranscripts();
  const path = join(directory, "transcripts.json");

  writeFileSync(path, JSON.stringify([valid[0]]));
  assert.throws(
    () => loadTranscripts(path, scenarios),
    /expected 2 transcripts, received 1/,
  );

  writeFileSync(path, JSON.stringify([valid[0], valid[0]]));
  assert.throws(() => loadTranscripts(path, scenarios), /transcript ids must be unique/);

  writeFileSync(
    path,
    JSON.stringify([valid[0], transcript("synthetic.unexpected", [])]),
  );
  assert.throws(
    () => loadTranscripts(path, scenarios),
    /missing transcript for synthetic\.relay-negative/,
  );

  assert.throws(
    () => gradeScenarios(scenarios, [valid[1], valid[0]]),
    /synthetic\.compass-positive: transcript id mismatch/,
  );
});

test("runner protocol exposes every candidate skill while withholding the target oracle", (t) => {
  const directory = temporaryDirectory(t);
  const runnerPath = join(directory, "runner.mjs");
  writeFileSync(
    runnerPath,
    `#!/usr/bin/env node
import { readFileSync } from "node:fs";
const payload = JSON.parse(readFileSync(0, "utf8"));
if (Object.hasOwn(payload, "expected") || Object.hasOwn(payload.scenario, "expected")) {
  console.error("expected selection or assertion oracle leaked to runner");
  process.exit(23);
}
if (Object.hasOwn(payload, "skill") || Object.hasOwn(payload.scenario, "skill")) {
  console.error("target skill oracle leaked to runner");
  process.exit(24);
}
if (Object.hasOwn(payload.scenario, "assertions")) {
  console.error("assertion oracle leaked to runner");
  process.exit(25);
}
const skills = payload.skills.map(({ name, path, text }) => ({
  name,
  path,
  hasSkillText:
    typeof text === "string" &&
    text.length > 0 &&
    text === readFileSync(path, "utf8"),
}));
const final = JSON.stringify({
  protocol: payload.protocol,
  scenarioKeys: Object.keys(payload.scenario).sort(),
  prompt: payload.scenario.prompt,
  context: payload.scenario.context,
  skills,
});
process.stdout.write(JSON.stringify({
  id: process.env.SKILL_BEHAVIOR_SCENARIO_ID,
  selected_skills: [payload.skills.find(({ name }) => name === "compass").name],
  events: [{ type: "runner-output", scenarioId: payload.scenario.id }],
  final,
  metrics: { input_tokens: 7, output_tokens: 2, total_cost_usd: 0.004 },
}));
`,
  );
  chmodSync(runnerPath, 0o755);

  const scenario = {
    id: "runner.protocol",
    skill: "compass",
    prompt: "Choose a queue architecture.",
    context: { repository: "service" },
    expected: { selected: false, assertions: ["compass_no_implementation"] },
  };
  const [output] = runScenarios([scenario], runnerPath);

  assert.deepEqual(output.selected_skills, ["compass"]);
  assert.deepEqual(output.events, [{ type: "runner-output", scenarioId: "runner.protocol" }]);
  assert.deepEqual(output.metrics, {
    input_tokens: 7,
    output_tokens: 2,
    total_cost_usd: 0.004,
  });
  assert.deepEqual(JSON.parse(output.final), {
    protocol: "agent-skills/skill-behavior-v1",
    scenarioKeys: ["context", "id", "prompt"],
    prompt: "Choose a queue architecture.",
    context: { repository: "service" },
    skills: [
      { name: "scout", path: "scout/SKILL.md", hasSkillText: true },
      { name: "compass", path: "compass/SKILL.md", hasSkillText: true },
      { name: "relay", path: "relay/SKILL.md", hasSkillText: true },
      { name: "cairn", path: "cairn/SKILL.md", hasSkillText: true },
    ],
  });
});

test("CLI fails behavior checks by default and --measure reports metrics with exit zero", (t) => {
  const directory = temporaryDirectory(t);
  const scenarioPath = join(directory, "scenarios.json");
  const transcriptPath = join(directory, "transcripts.json");
  const scenarios = ["scout", "compass", "relay", "cairn"].flatMap((skill) => [
    {
      id: `${skill}.positive`,
      skill,
      prompt: `Use ${skill} for this matching request.`,
      expected: { selected: true, assertions: [] },
    },
    {
      id: `${skill}.negative`,
      skill,
      prompt: `Do not use ${skill} for this non-matching request.`,
      expected: { selected: false, assertions: [] },
    },
  ]);
  const transcripts = scenarios.map((scenario) => transcript(scenario.id));
  writeFileSync(scenarioPath, JSON.stringify(scenarios));
  writeFileSync(transcriptPath, JSON.stringify(transcripts));

  const args = [
    evaluatorPath,
    "--scenarios",
    scenarioPath,
    "--transcripts",
    transcriptPath,
  ];
  const strict = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(strict.status, 1, strict.stdout);
  assert.match(strict.stdout, /Scenarios: 8 \| pass: 4 \| fail: 4/);
  assert.match(strict.stdout, /\[FAIL\] compass\.positive/);
  assert.match(strict.stdout, /METRIC scenario_pass_rate=0\.5000/);

  const measure = spawnSync(process.execPath, [...args, "--measure"], { encoding: "utf8" });
  assert.equal(measure.status, 0, measure.stderr);
  assert.match(measure.stdout, /Scenarios: 8 \| pass: 4 \| fail: 4/);
  assert.match(measure.stdout, /METRIC scenario_pass_rate=0\.5000/);
  assert.match(measure.stdout, /METRIC activation_accuracy=0\.5000/);
  assert.match(measure.stdout, /METRIC false_activation_rate=0\.0000/);
  assert.match(measure.stdout, /METRIC contract_pass_rate=1\.0000/);
  assert.match(measure.stdout, /METRIC input_tokens=null/);
  assert.match(measure.stdout, /METRIC output_tokens=null/);
  assert.match(measure.stdout, /METRIC total_cost_usd=null/);
});
