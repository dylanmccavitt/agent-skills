#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultScenarioPath = resolve(root, "evaluation", "skill-behavior-v1.scenarios.json");
const skillNames = new Set(["scout", "compass", "relay", "cairn"]);
const properHomes = new Set(["tracker", "pr", "decision-shelf", "memory", "commit"]);
const authoritativeHeadSources = new Set([
  "pull_request_head",
  "origin_main",
  "tag_commit",
  "local_head",
]);
const planningNames = /^(?:plan|handoff|notes)(?:[-_.].*)?\.md$/i;
const decisionNames = /^(?:decision|decisions|adr|architecture)(?:[-_.].*)?\.md$/i;
const scoutTerritories = ["scope", "shape", "data", "edges", "seams", "done-looks-like"];

function eventsOf(transcript, type) {
  return transcript.events.filter((event) => event.type === type);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasFields(value, fields) {
  return value && fields.every((field) => nonEmpty(value[field]));
}

const assertions = {
  scout_one_question_per_turn(transcript) {
    const asks = eventsOf(transcript, "ask");
    const turns = asks.map((ask) => ask.turn);
    const passed =
      asks.length > 0 &&
      new Set(turns).size === turns.length &&
      asks.every(
        (ask) =>
          (nonEmpty(ask.turn) || Number.isInteger(ask.turn)) &&
          ask.native === true &&
          Array.isArray(ask.options) &&
          ask.options.length >= 2 &&
          ask.options.length <= 3 &&
          ask.options.every(nonEmpty) &&
          ask.recommended === 0,
      );
    return { passed, observed: `${asks.length} ask event(s), ${new Set(turns).size} turn(s)` };
  },
  scout_ledger_after_answers(transcript) {
    const asks = eventsOf(transcript, "ask");
    const ledgers = eventsOf(transcript, "ledger");
    const passed =
      asks.length > 0 &&
      ledgers.length === asks.length &&
      ledgers.every(
        (ledger, index) =>
          ledger.turn === asks[index].turn &&
          /^✓\d+ decided · ● .+ · ○ .+$/.test(ledger.text || ""),
      );
    return { passed, observed: `${ledgers.length} ledger(s) for ${asks.length} ask(s)` };
  },
  scout_fixed_sweep(transcript) {
    const sweeps = eventsOf(transcript, "scout_sweep");
    const territories = sweeps[0]?.territories;
    const passed =
      sweeps.length === 1 &&
      Array.isArray(territories) &&
      territories.length === scoutTerritories.length &&
      territories.every(
        (entry, index) =>
          entry.name === scoutTerritories[index] &&
          ["grilled", "skipped"].includes(entry.status) &&
          (entry.status !== "skipped" || nonEmpty(entry.reason)),
      );
    return { passed, observed: `${sweeps.length} sweep(s), ${territories?.length || 0} territories` };
  },
  scout_advisor_borders(transcript) {
    const reviews = eventsOf(transcript, "advisor_review");
    const names = reviews.map((review) => review.territory);
    const passed =
      reviews.length === scoutTerritories.length &&
      names.every((name, index) => name === scoutTerritories[index]) &&
      reviews.every(
        (review) =>
          Number.isInteger(review.bonus_turns) &&
          review.bonus_turns >= 0 &&
          review.bonus_turns <= 2,
      );
    return { passed, observed: `${reviews.length} advisor review(s)` };
  },
  scout_decision_brief(transcript) {
    const briefs = eventsOf(transcript, "decision_brief");
    const brief = briefs[0];
    const records = eventsOf(transcript, "record");
    const record = records.at(-1);
    const lines = transcript.final.split(/\r?\n/);
    const passed =
      briefs.length === 1 &&
      Array.isArray(brief.decisions) &&
      brief.decisions.length > 0 &&
      brief.decisions.every(nonEmpty) &&
      Array.isArray(brief.spikes) &&
      hasFields(brief, ["now", "next", "later"]) &&
      records.length === 1 &&
      record.status === "selected" &&
      record.exists === true &&
      isAbsolute(record.location || "") &&
      lines.at(-1) === `Record: ${record.location}`;
    return { passed, observed: `${briefs.length} brief(s), ${records.length} record(s)` };
  },
  scout_named_spike(transcript) {
    const briefs = eventsOf(transcript, "decision_brief");
    const spikes = briefs[0]?.spikes;
    const passed = briefs.length === 1 && Array.isArray(spikes) && spikes.some(nonEmpty);
    return { passed, observed: `${spikes?.length || 0} spike(s)` };
  },
  scout_no_implementation(transcript) {
    const changes = eventsOf(transcript, "production_change");
    return { passed: changes.length === 0, observed: `${changes.length} production change(s)` };
  },
  compass_one_native_question(transcript) {
    const asks = eventsOf(transcript, "ask");
    const ask = asks[0];
    const passed =
      asks.length === 1 &&
      ask.native === true &&
      Array.isArray(ask.options) &&
      ask.options.length >= 2 &&
      ask.options.length <= 3 &&
      ask.options.every(nonEmpty) &&
      ask.recommended === 0;
    return { passed, observed: `${asks.length} ask event(s)` };
  },
  compass_visual_variants(transcript) {
    const prototypes = eventsOf(transcript, "prototype");
    const prototype = prototypes[0];
    const passed =
      prototypes.length === 1 &&
      prototype.disposable === true &&
      prototype.production_path === false &&
      prototype.format === "html" &&
      prototype.structurally_different === true &&
      Array.isArray(prototype.variants) &&
      prototype.variants.length >= 2 &&
      prototype.variants.length <= 3 &&
      prototype.variants.every((variant) => nonEmpty(variant.view));
    return { passed, observed: `${prototypes.length} prototype event(s)` };
  },
  compass_record_locator(transcript) {
    const records = eventsOf(transcript, "record");
    const lines = transcript.final.split(/\r?\n/);
    const locators = lines.filter((line) => line.startsWith("Record: "));
    const record = records.at(-1);
    const passed =
      records.length > 0 &&
      record.exists === true &&
      isAbsolute(record.location || "") &&
      locators.length === 1 &&
      lines.at(-1) === `Record: ${record.location}`;
    return { passed, observed: `${locators.length} locator line(s)` };
  },
  compass_resumes_record(transcript) {
    const records = eventsOf(transcript, "record");
    const passed =
      records.length === 1 &&
      records[0].action === "resume" &&
      records[0].refreshed === true;
    return { passed, observed: records.map((record) => record.action).join(",") || "none" };
  },
  compass_no_implementation(transcript) {
    const changes = eventsOf(transcript, "production_change");
    return { passed: changes.length === 0, observed: `${changes.length} production change(s)` };
  },
  compass_no_repo_decision_file(transcript) {
    const writes = eventsOf(transcript, "repo_write").filter(
      (event) =>
        decisionNames.test(basename(event.path || "")) ||
        ["decision", "planning"].includes(event.purpose),
    );
    return { passed: writes.length === 0, observed: `${writes.length} decision write(s)` };
  },
  relay_bounded_brief(transcript) {
    const briefs = eventsOf(transcript, "brief");
    const passed =
      briefs.length === 1 &&
      hasFields(briefs[0], ["objective", "out_of_scope", "authority", "deliverable"]);
    return { passed, observed: `${briefs.length} brief event(s)` };
  },
  relay_parallel_independent_lanes(transcript) {
    const delegations = eventsOf(transcript, "delegate");
    const delegation = delegations[0];
    const lanes = delegation?.lanes;
    const owners = Array.isArray(lanes) ? lanes.map((lane) => lane.owner) : [];
    const files = Array.isArray(lanes) ? lanes.flatMap((lane) => lane.files || []) : [];
    const passed =
      delegations.length === 1 &&
      delegation.parallel === true &&
      Array.isArray(lanes) &&
      lanes.length >= 2 &&
      lanes.every(
        (lane) =>
          nonEmpty(lane.owner) &&
          nonEmpty(lane.target) &&
          Array.isArray(lane.files) &&
          lane.files.length > 0 &&
          lane.files.every(nonEmpty),
      ) &&
      new Set(owners).size === owners.length &&
      new Set(files).size === files.length;
    return { passed, observed: `${delegations.length} delegation(s), ${lanes?.length || 0} lane(s)` };
  },
  relay_serial_or_local_execution(transcript) {
    const delegations = eventsOf(transcript, "delegate");
    const delegation = delegations[0];
    const lanes = delegation?.lanes;
    const passed =
      delegations.length === 0 ||
      (delegations.length === 1 &&
        delegation.parallel === false &&
        Array.isArray(lanes) &&
        lanes.length === 1 &&
        nonEmpty(lanes[0].owner) &&
        nonEmpty(lanes[0].target));
    return { passed, observed: `${delegations.length} delegation(s), ${lanes?.length || 0} lane(s)` };
  },
  relay_receipt(transcript) {
    const receipts = eventsOf(transcript, "receipt");
    const receipt = receipts[0];
    const checks = receipt?.checks;
    const passed =
      receipts.length === 1 &&
      receipt.synthesized === true &&
      nonEmpty(receipt.head) &&
      receipt.authoritative_head === receipt.head &&
      authoritativeHeadSources.has(receipt.head_source) &&
      Array.isArray(checks) &&
      checks.length > 0 &&
      checks.every(
        (check) => nonEmpty(check.name) && check.passed === true && check.head === receipt.head,
      );
    return { passed, observed: `${receipts.length} receipt(s), ${checks?.length || 0} check(s)` };
  },
  relay_no_external_effect(transcript) {
    const effects = eventsOf(transcript, "external_effect");
    return { passed: effects.length === 0, observed: `${effects.length} external effect(s)` };
  },
  cairn_proper_home(transcript) {
    const updates = eventsOf(transcript, "state_update");
    const update = updates[0];
    const fields = update?.fields;
    const required = ["current_state", "proof", "open_risks", "next_action"];
    const passed =
      updates.length === 1 &&
      properHomes.has(update.home) &&
      Array.isArray(fields) &&
      required.every((field) => fields.includes(field));
    return { passed, observed: `${updates.length} update(s), home=${update?.home || "none"}` };
  },
  cairn_no_repo_planning_file(transcript) {
    const writes = eventsOf(transcript, "repo_write").filter(
      (event) => planningNames.test(basename(event.path || "")) || event.purpose === "planning",
    );
    return { passed: writes.length === 0, observed: `${writes.length} planning write(s)` };
  },
  cairn_live_refresh(transcript) {
    const refreshes = eventsOf(transcript, "live_refresh");
    const sources = refreshes[0]?.sources;
    const passed =
      refreshes.length === 1 &&
      Array.isArray(sources) &&
      sources.includes("files") &&
      sources.some((source) => ["branch", "pr", "checks"].includes(source));
    return { passed, observed: `${refreshes.length} refresh(es)` };
  },
  cairn_resume_sections(transcript) {
    const summaries = eventsOf(transcript, "resume_summary");
    const sections = summaries[0]?.sections;
    const passed =
      summaries.length === 1 &&
      Array.isArray(sections) &&
      ["settled", "open", "stale"].every((section) => sections.includes(section));
    return { passed, observed: `${summaries.length} resume summary event(s)` };
  },
  cairn_cleanup_offer(transcript) {
    const offers = eventsOf(transcript, "cleanup_offer");
    const offer = offers[0];
    const passed =
      offers.length === 1 &&
      nonEmpty(offer.path) &&
      properHomes.has(offer.destination) &&
      offer.remove === true &&
      offer.authorized !== true;
    return { passed, observed: `${offers.length} cleanup offer(s)` };
  },
};

export function validateScenarios(scenarios) {
  if (!Array.isArray(scenarios) || scenarios.length === 0) {
    throw new Error("scenario file must contain a non-empty array");
  }
  const ids = new Set();
  const coverage = new Map([...skillNames].map((skill) => [skill, { positive: 0, negative: 0 }]));
  for (const scenario of scenarios) {
    if (!nonEmpty(scenario.id) || ids.has(scenario.id)) {
      throw new Error(`scenario id must be non-empty and unique: ${scenario.id || "<missing>"}`);
    }
    ids.add(scenario.id);
    if (!skillNames.has(scenario.skill)) throw new Error(`${scenario.id}: unknown skill ${scenario.skill}`);
    if (!nonEmpty(scenario.prompt)) throw new Error(`${scenario.id}: prompt must be non-empty`);
    if (typeof scenario.expected?.selected !== "boolean") {
      throw new Error(`${scenario.id}: expected.selected must be boolean`);
    }
    if (!Array.isArray(scenario.expected.assertions)) {
      throw new Error(`${scenario.id}: expected.assertions must be an array`);
    }
    const excluded = scenario.expected.excluded || [];
    if (
      !Array.isArray(excluded) ||
      excluded.some((skill) => !skillNames.has(skill) || skill === scenario.skill) ||
      new Set(excluded).size !== excluded.length
    ) {
      throw new Error(`${scenario.id}: expected.excluded must contain unique competing skills`);
    }
    for (const assertion of scenario.expected.assertions) {
      if (!Object.hasOwn(assertions, assertion)) {
        throw new Error(`${scenario.id}: unknown assertion ${assertion}`);
      }
    }
    coverage.get(scenario.skill)[scenario.expected.selected ? "positive" : "negative"] += 1;
  }
  for (const [skill, counts] of coverage) {
    if (counts.positive === 0 || counts.negative === 0) {
      throw new Error(`${skill}: scenarios must include positive and negative activation cases`);
    }
  }
  return scenarios;
}

export function loadScenarios(path = defaultScenarioPath) {
  return validateScenarios(JSON.parse(readFileSync(path, "utf8")));
}

function validateTranscript(transcript, scenario) {
  if (!transcript || typeof transcript !== "object" || Array.isArray(transcript)) {
    throw new Error(`${scenario.id}: runner must return one JSON object`);
  }
  if (transcript.id !== scenario.id) {
    throw new Error(`${scenario.id}: transcript id mismatch (${transcript.id || "missing"})`);
  }
  if (!Array.isArray(transcript.selected_skills)) {
    throw new Error(`${scenario.id}: selected_skills must be an array`);
  }
  if (transcript.selected_skills.some((skill) => !skillNames.has(skill))) {
    throw new Error(`${scenario.id}: selected_skills contains an unknown skill`);
  }
  if (!Array.isArray(transcript.events)) throw new Error(`${scenario.id}: events must be an array`);
  if (!nonEmpty(transcript.final)) throw new Error(`${scenario.id}: final must be non-empty`);
  return transcript;
}

function runnerPayload(scenario) {
  return {
    protocol: "agent-skills/skill-behavior-v1",
    scenario: {
      id: scenario.id,
      prompt: scenario.prompt,
      context: scenario.context || {},
    },
    skills: [...skillNames].map((name) => ({
      name,
      path: `${name}/SKILL.md`,
      text: readFileSync(resolve(root, name, "SKILL.md"), "utf8"),
    })),
  };
}

export function runScenarios(scenarios, runner) {
  if (!nonEmpty(runner)) throw new Error("provide --runner <executable> or SKILL_BEHAVIOR_RUNNER");
  return scenarios.map((scenario) => {
    const run = spawnSync(runner, [], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, SKILL_BEHAVIOR_SCENARIO_ID: scenario.id },
      input: `${JSON.stringify(runnerPayload(scenario))}\n`,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (run.error) throw new Error(`${scenario.id}: runner failed: ${run.error.message}`);
    if (run.status !== 0) {
      throw new Error(`${scenario.id}: runner exited ${run.status}: ${run.stderr.trim()}`);
    }
    let transcript;
    try {
      transcript = JSON.parse(run.stdout);
    } catch {
      throw new Error(`${scenario.id}: runner stdout is not one JSON object`);
    }
    return validateTranscript(transcript, scenario);
  });
}

export function loadTranscripts(path, scenarios) {
  const text = readFileSync(path, "utf8").trim();
  let values;
  try {
    const parsed = JSON.parse(text);
    values = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    values = text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`transcript line ${index + 1} is not valid JSON`);
      }
    });
  }
  const byId = new Map(values.map((value) => [value.id, value]));
  if (byId.size !== values.length) throw new Error("transcript ids must be unique");
  if (values.length !== scenarios.length) {
    throw new Error(`expected ${scenarios.length} transcripts, received ${values.length}`);
  }
  return scenarios.map((scenario) => {
    const transcript = byId.get(scenario.id);
    if (!transcript) throw new Error(`missing transcript for ${scenario.id}`);
    return validateTranscript(transcript, scenario);
  });
}

export function gradeScenarios(scenarios, transcripts) {
  if (scenarios.length !== transcripts.length) throw new Error("scenario/transcript length mismatch");
  return scenarios.map((scenario, index) => {
    const transcript = validateTranscript(transcripts[index], scenario);
    const selected = transcript.selected_skills.includes(scenario.skill);
    const excludedSelected = (scenario.expected.excluded || []).filter((skill) =>
      transcript.selected_skills.includes(skill),
    );
    const activationPassed =
      selected === scenario.expected.selected && excludedSelected.length === 0;
    const checks = scenario.expected.assertions.map((name) => ({
      name,
      ...assertions[name](transcript),
    }));
    return {
      id: scenario.id,
      skill: scenario.skill,
      expectedSelected: scenario.expected.selected,
      selected,
      excludedSelected,
      activationPassed,
      checks,
      passed: activationPassed && checks.every((check) => check.passed),
      metrics: transcript.metrics || {},
    };
  });
}

function ratio(numerator, denominator) {
  return denominator === 0 ? 1 : numerator / denominator;
}

export function summarize(results) {
  const scenariosPassed = results.filter((result) => result.passed).length;
  const activationPassed = results.filter((result) => result.activationPassed).length;
  const negative = results.filter((result) => !result.expectedSelected);
  const falseActivations = negative.filter((result) => result.selected).length;
  const checks = results.flatMap((result) => result.checks);
  const checksPassed = checks.filter((check) => check.passed).length;
  const metricValues = (name) => results.map((result) => result.metrics[name]);
  const completeSum = (name) => {
    const values = metricValues(name);
    return values.every((value) => Number.isFinite(value))
      ? values.reduce((sum, value) => sum + value, 0)
      : null;
  };
  return {
    scenariosPassed,
    scenariosTotal: results.length,
    scenarioPassRate: ratio(scenariosPassed, results.length),
    activationAccuracy: ratio(activationPassed, results.length),
    falseActivationRate: ratio(falseActivations, negative.length),
    contractPassRate: ratio(checksPassed, checks.length),
    inputTokens: completeSum("input_tokens"),
    outputTokens: completeSum("output_tokens"),
    totalCostUsd: completeSum("total_cost_usd"),
  };
}

function parseArgs(argv) {
  const options = { scenarioPath: defaultScenarioPath, strict: true, validate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--strict") options.strict = true;
    else if (arg === "--measure") options.strict = false;
    else if (arg === "--validate") options.validate = true;
    else if (["--runner", "--transcripts", "--scenarios"].includes(arg)) {
      const value = argv[index + 1];
      if (!value) throw new Error(`${arg} requires a value`);
      index += 1;
      if (arg === "--runner") options.runner = value;
      else if (arg === "--transcripts") options.transcriptPath = resolve(value);
      else options.scenarioPath = resolve(value);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (options.runner && options.transcriptPath) {
    throw new Error("use either --runner or --transcripts, not both");
  }
  return options;
}

function printSummary(results, summary) {
  console.log("Skill behavior evaluation v1");
  console.log(
    `Scenarios: ${summary.scenariosTotal} | pass: ${summary.scenariosPassed} | fail: ${summary.scenariosTotal - summary.scenariosPassed}`,
  );
  for (const result of results) {
    console.log(`${result.passed ? "[PASS]" : "[FAIL]"} ${result.id}`);
    if (!result.activationPassed) {
      console.log(
        `  activation: expected selected=${result.expectedSelected}, observed selected=${result.selected}` +
          `${result.excludedSelected.length ? `; excluded selected=${result.excludedSelected.join(",")}` : ""}`,
      );
    }
    for (const check of result.checks.filter((entry) => !entry.passed)) {
      console.log(`  ${check.name}: ${check.observed}`);
    }
  }
  console.log(`METRIC scenario_pass_rate=${summary.scenarioPassRate.toFixed(4)}`);
  console.log(`METRIC activation_accuracy=${summary.activationAccuracy.toFixed(4)}`);
  console.log(`METRIC false_activation_rate=${summary.falseActivationRate.toFixed(4)}`);
  console.log(`METRIC contract_pass_rate=${summary.contractPassRate.toFixed(4)}`);
  console.log(`METRIC scenarios_passed=${summary.scenariosPassed}`);
  console.log(`METRIC input_tokens=${summary.inputTokens ?? "null"}`);
  console.log(`METRIC output_tokens=${summary.outputTokens ?? "null"}`);
  console.log(`METRIC total_cost_usd=${summary.totalCostUsd ?? "null"}`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const scenarios = loadScenarios(options.scenarioPath);
  if (options.validate) {
    console.log(`Validated ${scenarios.length} fixed skill-behavior scenarios.`);
    return;
  }
  const runner = options.runner || process.env.SKILL_BEHAVIOR_RUNNER;
  if (!runner && !options.transcriptPath) {
    throw new Error("provide --runner <executable>, --transcripts <path>, or --validate");
  }
  const transcripts = options.transcriptPath
    ? loadTranscripts(options.transcriptPath, scenarios)
    : runScenarios(scenarios, runner);
  const results = gradeScenarios(scenarios, transcripts);
  const summary = summarize(results);
  printSummary(results, summary);
  if (options.strict && summary.scenariosPassed !== summary.scenariosTotal) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`skill-behavior-v1: ${error.message}`);
    process.exitCode = 1;
  }
}
