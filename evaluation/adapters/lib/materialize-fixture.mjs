import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { ensureAuditLog } from "./audit-log.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const fixturesRoot = join(repoRoot, "evaluation", "fixtures", "skill-behavior-v1");

function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}

function initGit(projectDir) {
  const run = (args) =>
    spawnSync("git", args, {
      cwd: projectDir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "skill-behavior",
        GIT_AUTHOR_EMAIL: "skill-behavior@example.com",
        GIT_COMMITTER_NAME: "skill-behavior",
        GIT_COMMITTER_EMAIL: "skill-behavior@example.com",
      },
    });
  if (run(["init"]).status !== 0) return null;
  run(["add", "."]);
  const commit = run(["commit", "-m", "fixture seed"]);
  if (commit.status !== 0) return null;
  const head = run(["rev-parse", "HEAD"]);
  return head.status === 0 ? head.stdout.trim() : null;
}

function applyOverlay(scenarioId, projectDir) {
  const overlay = join(fixturesRoot, "overlays", scenarioId);
  if (existsSync(overlay)) copyDir(overlay, projectDir);
}

function seedShelf(context, shelfDir, projectName) {
  mkdirSync(join(shelfDir, projectName), { recursive: true });
  if (!context?.matching_record_exists) return null;
  const seeded = join(shelfDir, projectName, "existing-decision.html");
  writeFileSync(
    seeded,
    `<!doctype html>
<html>
  <head><title>Existing Decision</title></head>
  <body>
    <h1>Existing Decision</h1>
    <ul>
      <li>Status: selected</li>
      <li>Updated: 2026-01-01</li>
    </ul>
    <p>Seeded shelf record for resume scenarios.</p>
  </body>
</html>
`,
  );
  return seeded;
}

export function materializeFixture({ scenario, skills, runRoot } = {}) {
  if (!scenario?.id) throw new Error("scenario.id is required");
  const root =
    runRoot ||
    mkdtempSync(join(tmpdir(), `skill-behavior-${scenario.id.replace(/[^a-z0-9.-]+/gi, "-")}-`));
  const projectDir = join(root, "project");
  const shelfDir = join(root, "shelf");
  const skillsDir = join(root, "skills");
  const auditLog = join(root, "audit.jsonl");
  const contextPath = join(root, "CONTEXT.json");
  const answersPath = join(root, "answers.json");

  mkdirSync(projectDir, { recursive: true });
  mkdirSync(shelfDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });
  ensureAuditLog(auditLog);

  const repository = scenario.context?.repository || "package";
  const template = join(fixturesRoot, "repositories", repository);
  if (existsSync(template)) {
    copyDir(template, projectDir);
  } else {
    writeFileSync(join(projectDir, "README.md"), `# ${repository}\n`);
  }

  applyOverlay(scenario.id, projectDir);

  if (Array.isArray(scenario.context?.independent_files)) {
    for (const relative of scenario.context.independent_files) {
      const target = join(projectDir, relative);
      mkdirSync(dirname(target), { recursive: true });
      if (!existsSync(target)) {
        writeFileSync(target, `fixture ${relative}\n`);
      }
    }
  }

  if (scenario.context?.stray_file) {
    const target = join(projectDir, scenario.context.stray_file);
    mkdirSync(dirname(target), { recursive: true });
    if (!existsSync(target)) writeFileSync(target, "# stray planning file\n");
  }

  for (const skill of skills || []) {
    const skillDir = join(skillsDir, skill.name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), skill.text);
    const ompSkillDir = join(projectDir, ".agents", "skills", skill.name);
    mkdirSync(ompSkillDir, { recursive: true });
    writeFileSync(join(ompSkillDir, "SKILL.md"), skill.text);
  }

  writeFileSync(contextPath, `${JSON.stringify(scenario.context || {}, null, 2)}\n`);
  if (Array.isArray(scenario.context?.scripted_answers)) {
    writeFileSync(answersPath, `${JSON.stringify(scenario.context.scripted_answers, null, 2)}\n`);
  }

  const projectName = repository === "none" ? "service" : repository;
  const seededRecord = seedShelf(scenario.context, shelfDir, projectName);
  const head = initGit(projectDir);

  writeFileSync(
    join(root, "run.json"),
    `${JSON.stringify(
      {
        id: scenario.id,
        repository,
        projectDir,
        shelfDir,
        skillsDir,
        auditLog,
        contextPath,
        answersPath: existsSync(answersPath) ? answersPath : null,
        seededRecord,
        head,
      },
      null,
      2,
    )}\n`,
  );

  return {
    root,
    projectDir,
    shelfDir,
    skillsDir,
    auditLog,
    contextPath,
    answersPath: existsSync(answersPath) ? answersPath : null,
    seededRecord,
    head,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export function fixtureRoots() {
  return { repoRoot, fixturesRoot };
}
