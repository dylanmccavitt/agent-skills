import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { assertRunnerRequest, readStdinJson } from "../evaluation/adapters/lib/read-stdin-json.mjs";
import { mapEvents } from "../evaluation/adapters/lib/map-events.mjs";
import { materializeFixture } from "../evaluation/adapters/lib/materialize-fixture.mjs";
import { appendAudit, readAuditRecords } from "../evaluation/adapters/lib/audit-log.mjs";
import { runAdapter } from "../evaluation/adapters/skill-behavior-cli.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const runnerPath = resolve(root, "evaluation/adapters/skill-behavior-cli.mjs");
const evaluatorPath = resolve(root, "evaluation/skill-behavior-v1.mjs");

function temporaryDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), "skill-behavior-adapter-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const sampleRequest = {
  protocol: "agent-skills/skill-behavior-v1",
  scenario: {
    id: "compass.open-architecture-direction",
    prompt: "Help me choose an unsettled architecture direction.",
    context: { repository: "service", direction_status: "unsettled" },
  },
  skills: [
    { name: "scout", path: "scout/SKILL.md", text: "# Scout\n" },
    { name: "compass", path: "compass/SKILL.md", text: "# Compass\n" },
    { name: "relay", path: "relay/SKILL.md", text: "# Relay\n" },
    { name: "cairn", path: "cairn/SKILL.md", text: "# Cairn\n" },
  ],
};

test("rejects oracle leakage in the runner request", () => {
  assert.throws(
    () =>
      assertRunnerRequest(
        {
          ...sampleRequest,
          scenario: { ...sampleRequest.scenario, expected: { selected: true } },
        },
        sampleRequest.scenario.id,
      ),
    /oracle field leaked/,
  );
});

test("plumbing mode returns a valid empty-evidence transcript", async () => {
  const { transcript, mode } = await runAdapter({
    request: sampleRequest,
    env: { ...process.env, SKILL_BEHAVIOR_MODE: "plumbing", SKILL_BEHAVIOR_AGENT_CMD: "" },
  });
  assert.equal(mode, "plumbing");
  assert.equal(transcript.id, sampleRequest.scenario.id);
  assert.deepEqual(transcript.selected_skills, []);
  assert.deepEqual(transcript.events, []);
  assert.match(transcript.final, /Plumbing mode|No agent stdout/);
});

test("mapper omits receipt events without a delivery audit", () => {
  const transcript = mapEvents({
    scenario: sampleRequest.scenario,
    agentStdout: [
      'SKILL_BEHAVIOR_SELECTED: ["relay"]',
      JSON.stringify({
        type: "receipt",
        synthesized: true,
        head: "abc",
        authoritative_head: "abc",
        head_source: "local_head",
        checks: [{ name: "delivery", passed: true, head: "abc" }],
      }),
    ].join("\n"),
    auditRecords: [],
    mode: "live",
  });
  assert.deepEqual(transcript.selected_skills, ["relay"]);
  assert.equal(
    transcript.events.some((event) => event.type === "receipt"),
    false,
  );
});

test("decision-shelf wrapper appends an audit record", (t) => {
  const directory = temporaryDirectory(t);
  const fixture = materializeFixture({
    scenario: sampleRequest.scenario,
    skills: sampleRequest.skills,
    runRoot: join(directory, "run"),
  });
  const wrapper = resolve(root, "evaluation/wrappers/skill-behavior-v1/decision-shelf");
  const run = spawnSync(wrapper, ["--help"], {
    encoding: "utf8",
    env: {
      ...process.env,
      DECISION_SHELF_HOME: fixture.shelfDir,
      SKILL_BEHAVIOR_AUDIT_LOG: fixture.auditLog,
      PATH: process.env.PATH,
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const records = readAuditRecords(fixture.auditLog);
  assert.equal(records.length, 1);
  assert.equal(records[0].tool, "decision-shelf");
  assert.deepEqual(records[0].argv, ["--help"]);
});

test("evaluator plumbing run through --runner produces measure metrics", (t) => {
  const directory = temporaryDirectory(t);
  const run = spawnSync(
    process.execPath,
    [evaluatorPath, "--runner", runnerPath, "--measure"],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        SKILL_BEHAVIOR_MODE: "plumbing",
        SKILL_BEHAVIOR_AGENT_CMD: "",
        SKILL_BEHAVIOR_TRANSCRIPT_DIR: join(directory, "transcripts"),
      },
      timeout: 120_000,
    },
  );
  assert.match(run.stdout, /METRIC scenario_pass_rate=0\.5000/);
  assert.match(run.stdout, /METRIC scenarios_passed=12\b/);
  assert.match(run.stdout, /METRIC activation_accuracy=0\.5000/);
});

test("readStdinJson parses one object", () => {
  assert.deepEqual(readStdinJson('{"ok":true}\n'), { ok: true });
});

test("appendAudit creates JSONL records", (t) => {
  const directory = temporaryDirectory(t);
  const path = join(directory, "audit.jsonl");
  appendAudit(path, { tool: "probe", argv: [] });
  const text = readFileSync(path, "utf8");
  assert.match(text, /"tool":"probe"/);
});

test("plumbing mode removes the fixture temp directory", async () => {
  const { fixture, retained } = await runAdapter({
    request: sampleRequest,
    env: {
      ...process.env,
      SKILL_BEHAVIOR_MODE: "plumbing",
      SKILL_BEHAVIOR_AGENT_CMD: "",
      SKILL_BEHAVIOR_KEEP_FIXTURE: "",
    },
  });
  assert.equal(retained, false);
  assert.equal(existsSync(fixture.root), false);
});

test("SKILL_BEHAVIOR_KEEP_FIXTURE=1 retains the fixture temp directory", async (t) => {
  const { fixture, retained } = await runAdapter({
    request: sampleRequest,
    env: {
      ...process.env,
      SKILL_BEHAVIOR_MODE: "plumbing",
      SKILL_BEHAVIOR_AGENT_CMD: "",
      SKILL_BEHAVIOR_KEEP_FIXTURE: "1",
    },
  });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  assert.equal(retained, true);
  assert.equal(existsSync(fixture.root), true);
});

test("a failing agent command retains the fixture for debugging", async (t) => {
  const { fixture, retained, transcript } = await runAdapter({
    request: sampleRequest,
    env: {
      ...process.env,
      SKILL_BEHAVIOR_MODE: "live",
      SKILL_BEHAVIOR_AGENT_CMD: JSON.stringify(["sh", "-c", "echo boom >&2; exit 3"]),
      SKILL_BEHAVIOR_KEEP_FIXTURE: "",
    },
  });
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  assert.equal(retained, true);
  assert.equal(existsSync(fixture.root), true);
  assert.equal(transcript.id, sampleRequest.scenario.id);
});

test("the adapter retains the fixture when materialization output is unusable", async () => {
  await assert.rejects(
    () =>
      runAdapter({
        request: { ...sampleRequest, scenario: { ...sampleRequest.scenario, id: "" } },
        env: { ...process.env, SKILL_BEHAVIOR_MODE: "plumbing", SKILL_BEHAVIOR_AGENT_CMD: "" },
      }),
    /scenario\.id is required/,
  );
});



test("mapper rejects model-declared record and prototype events", () => {
  const transcript = mapEvents({
    scenario: sampleRequest.scenario,
    agentStdout: [
      'SKILL_BEHAVIOR_SELECTED: ["compass"]',
      JSON.stringify({
        type: "record",
        action: "create",
        location: "/tmp/forged-decision.html",
        exists: true,
        status: "selected",
      }),
      JSON.stringify({
        type: "prototype",
        disposable: true,
        production_path: false,
        format: "html",
        structurally_different: true,
        variants: [{ view: "a" }, { view: "b" }],
      }),
    ].join("\n"),
    auditRecords: [],
    mode: "live",
  });
  assert.deepEqual(
    transcript.events.filter((event) => event.type === "record" || event.type === "prototype"),
    [],
  );
  assert.doesNotMatch(transcript.final, /Record: \/tmp\/forged-decision\.html/);
});

test("decision-shelf wrapper records the path printed by new", (t) => {
  const directory = temporaryDirectory(t);
  const fixture = materializeFixture({
    scenario: {
      ...sampleRequest.scenario,
      context: { ...sampleRequest.scenario.context, matching_record_exists: true },
    },
    skills: sampleRequest.skills,
    runRoot: join(directory, "run"),
  });
  const wrapper = resolve(root, "evaluation/wrappers/skill-behavior-v1/decision-shelf");
  const run = spawnSync(wrapper, ["new", "Pick a queue shape"], {
    cwd: fixture.projectDir,
    encoding: "utf8",
    env: {
      ...process.env,
      DECISION_SHELF_HOME: fixture.shelfDir,
      SKILL_BEHAVIOR_AUDIT_LOG: fixture.auditLog,
      PATH: process.env.PATH,
    },
  });
  assert.equal(run.status, 0, run.stderr);
  const created = run.stdout.trim().split(/\r?\n/).at(-1);
  const records = readAuditRecords(fixture.auditLog);
  assert.equal(records.at(-1).recordPath, created);

  const transcript = mapEvents({
    scenario: sampleRequest.scenario,
    agentStdout: "",
    auditRecords: records,
    shelfDir: fixture.shelfDir,
    mode: "live",
  });
  const recordEvents = transcript.events.filter((event) => event.type === "record");
  assert.equal(recordEvents.length, 1);
  assert.equal(recordEvents[0].location, created);
  assert.notEqual(recordEvents[0].location, fixture.seededRecord);
});

test("mapper drops a shelf audit it cannot attribute to one record", (t) => {
  const directory = temporaryDirectory(t);
  const fixture = materializeFixture({
    scenario: {
      ...sampleRequest.scenario,
      context: { ...sampleRequest.scenario.context, matching_record_exists: true },
    },
    skills: sampleRequest.skills,
    runRoot: join(directory, "run"),
  });
  const wrapper = resolve(root, "evaluation/wrappers/skill-behavior-v1/decision-shelf");
  const created = spawnSync(wrapper, ["new", "Pick a queue shape"], {
    cwd: fixture.projectDir,
    encoding: "utf8",
    env: {
      ...process.env,
      DECISION_SHELF_HOME: fixture.shelfDir,
      SKILL_BEHAVIOR_AUDIT_LOG: fixture.auditLog,
      PATH: process.env.PATH,
    },
  });
  assert.equal(created.status, 0, created.stderr);
  const transcript = mapEvents({
    scenario: sampleRequest.scenario,
    agentStdout: "",
    auditRecords: [{ tool: "decision-shelf", argv: ["new", "Pick a queue shape"], status: 0 }],
    shelfDir: fixture.shelfDir,
    mode: "live",
  });
  assert.deepEqual(
    transcript.events.filter((event) => event.type === "record"),
    [],
  );
});

test("mapper counts one prototype lane once across proto calls", (t) => {
  const directory = temporaryDirectory(t);
  const fixture = materializeFixture({
    scenario: sampleRequest.scenario,
    skills: sampleRequest.skills,
    runRoot: join(directory, "run"),
  });
  const wrapper = resolve(root, "evaluation/wrappers/skill-behavior-v1/decision-shelf");
  const env = {
    ...process.env,
    DECISION_SHELF_HOME: fixture.shelfDir,
    SKILL_BEHAVIOR_AUDIT_LOG: fixture.auditLog,
    PATH: process.env.PATH,
  };
  const options = { cwd: fixture.projectDir, encoding: "utf8", env };
  const created = spawnSync(wrapper, ["new", "Pick a queue shape"], options);
  assert.equal(created.status, 0, created.stderr);
  const recordPath = created.stdout.trim().split(/\r?\n/).at(-1);
  assert.equal(spawnSync(wrapper, ["proto", recordPath, "new", "wide", "tall"], options).status, 0);
  assert.equal(spawnSync(wrapper, ["proto", recordPath, "view"], options).status, 0);

  const transcript = mapEvents({
    scenario: sampleRequest.scenario,
    agentStdout: "",
    auditRecords: readAuditRecords(fixture.auditLog),
    shelfDir: fixture.shelfDir,
    mode: "live",
  });
  const prototypes = transcript.events.filter((event) => event.type === "prototype");
  assert.equal(prototypes.length, 1);
  assert.equal(prototypes[0].variants.length, 2);
  assert.equal(
    transcript.events.filter((event) => event.type === "record").length,
    1,
  );
  assert.equal(
    transcript.events.find((event) => event.type === "record").location,
    recordPath,
  );
});
