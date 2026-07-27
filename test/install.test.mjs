import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { doctorSuite, installSuite, uninstallSuite } from "../bin/install.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const v1Skills = ["gepetto", "painter", "vigil", "checkpoint", "orchestrate"];
const currentSkills = ["compass", "relay", "cairn"];
const voiceHook = {
  matcher: ".*",
  hooks: [
    {
      type: "command",
      command:
        '/usr/bin/env python3 "${CODEX_HOME:-$HOME/.codex}/orchestration-skills/hooks/voice_state.py" hook',
      timeout: 15,
      statusMessage: "Checking voice-task tool authority",
    },
  ],
};

function temporaryHomes() {
  // realpath the fixture root so lexical assertions match canonicalized
  // homes (macOS tmpdir lives under /var, a symlink to /private/var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skills-v3-test-")));
  const homes = {
    codexHome: join(root, "Codex Home"),
    agentsHome: join(root, "agents"),
    claudeHome: join(root, "claude"),
  };
  mkdirSync(homes.codexHome, { recursive: true });
  return homes;
}

function allSkillRoots(homes) {
  return [
    join(homes.agentsHome, "skills"),
    join(homes.codexHome, "skills"),
    join(homes.claudeHome, "skills"),
  ];
}

function createManagedV1(codexHome) {
  const installRoot = join(codexHome, "orchestration-skills");
  const skillsRoot = join(codexHome, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  for (const skill of v1Skills) {
    mkdirSync(join(installRoot, skill), { recursive: true });
    writeFileSync(join(installRoot, skill, "SKILL.md"), `# ${skill}\n`);
    symlinkSync(
      join("..", "orchestration-skills", skill),
      join(skillsRoot, skill),
      "dir",
    );
  }
  mkdirSync(join(installRoot, "hooks"), { recursive: true });
  writeFileSync(join(installRoot, "hooks", "voice_state.py"), "# retired\n");
  writeFileSync(
    join(installRoot, ".codex-orchestration-install.json"),
    `${JSON.stringify({ package: "@dylanmccavitt/skills", version: "1.0.0" })}\n`,
  );
  writeFileSync(
    join(codexHome, "hooks.json"),
    `${JSON.stringify({
      custom: true,
      hooks: {
        PreToolUse: [
          voiceHook,
          {
            matcher: "foreign",
            hooks: [{ type: "command", command: "preserve-me" }],
          },
        ],
      },
    })}\n`,
  );
  return { installRoot, skillsRoot };
}

function createManagedCodexV3(codexHome, sourceRoot) {
  const installRoot = join(codexHome, "orchestration-skills");
  const skillsRoot = join(codexHome, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  for (const skill of currentSkills) {
    cpSync(join(sourceRoot, skill), join(installRoot, skill), { recursive: true });
    symlinkSync(
      join("..", "orchestration-skills", skill),
      join(skillsRoot, skill),
      "dir",
    );
  }
  writeFileSync(
    join(installRoot, ".codex-orchestration-install.json"),
    `${JSON.stringify({ package: "@dylanmccavitt/skills", version: "3.0.0" })}\n`,
  );
  return { installRoot, skillsRoot };
}

test("fresh install links every harness skill root to one managed bundle", () => {
  const homes = temporaryHomes();
  const result = installSuite({ ...homes, sourceRoot: repositoryRoot });

  assert.deepEqual(result.skills, currentSkills);
  assert.equal(result.upgradedFrom, null);
  assert.equal(result.installRoot, join(homes.agentsHome, "orchestration-skills"));
  for (const skillsRoot of allSkillRoots(homes)) {
    for (const skill of currentSkills) {
      const link = join(skillsRoot, skill);
      assert.equal(lstatSync(link).isSymbolicLink(), true);
      assert.equal(existsSync(join(link, "SKILL.md")), true);
      assert.equal(
        resolve(skillsRoot, readlinkSync(link)),
        join(result.installRoot, skill),
      );
    }
  }
  assert.equal(existsSync(join(homes.codexHome, "hooks.json")), false);
  assert.deepEqual(
    readdirSync(result.installRoot).sort(),
    [".codex-orchestration-install.json", ...currentSkills].sort(),
  );
});

test("managed v1 upgrade migrates the bundle and retires package hooks", () => {
  const homes = temporaryHomes();
  const { installRoot: legacyRoot, skillsRoot } = createManagedV1(homes.codexHome);
  const foreignTarget = join(homes.codexHome, "foreign-skill");
  mkdirSync(foreignTarget);
  symlinkSync(foreignTarget, join(skillsRoot, "unrelated"), "dir");

  const result = installSuite({ ...homes, sourceRoot: repositoryRoot });

  assert.equal(result.upgradedFrom, "1.0.0");
  assert.equal(existsSync(legacyRoot), false);
  for (const skill of v1Skills) {
    assert.equal(existsSync(join(skillsRoot, skill)), false);
  }
  for (const skillsRoot_ of allSkillRoots(homes)) {
    for (const skill of currentSkills) {
      assert.equal(lstatSync(join(skillsRoot_, skill)).isSymbolicLink(), true);
    }
  }
  assert.equal(lstatSync(join(skillsRoot, "unrelated")).isSymbolicLink(), true);
  assert.deepEqual(
    readdirSync(result.installRoot).sort(),
    [".codex-orchestration-install.json", ...currentSkills].sort(),
  );
  const hooks = JSON.parse(
    readFileSync(join(homes.codexHome, "hooks.json"), "utf8"),
  );
  assert.equal(hooks.custom, true);
  assert.deepEqual(hooks.hooks.PreToolUse, [
    {
      matcher: "foreign",
      hooks: [{ type: "command", command: "preserve-me" }],
    },
  ]);
  assert.equal(
    readdirSync(homes.codexHome).some((name) =>
      name.startsWith("hooks.json.backup-"),
    ),
    true,
  );
});

test("codex-only v3 install migrates into the agents bundle", () => {
  const homes = temporaryHomes();
  const { installRoot: legacyRoot, skillsRoot } = createManagedCodexV3(
    homes.codexHome,
    repositoryRoot,
  );

  const result = installSuite({ ...homes, sourceRoot: repositoryRoot });

  assert.equal(result.upgradedFrom, "3.0.0");
  assert.deepEqual(result.leftovers, []);
  assert.equal(existsSync(legacyRoot), false);
  for (const skill of currentSkills) {
    assert.equal(
      resolve(skillsRoot, readlinkSync(join(skillsRoot, skill))),
      join(result.installRoot, skill),
    );
  }
  const doctor = doctorSuite({ ...homes, sourceRoot: repositoryRoot });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.problems));
});

test("upgrade preserves legacy names not owned by this package", () => {
  const homes = temporaryHomes();
  const { skillsRoot } = createManagedV1(homes.codexHome);
  const external = join(homes.codexHome, "external-gepetto");
  mkdirSync(external);
  const packageLink = join(skillsRoot, "gepetto");
  // Replace the package-owned link with an unrelated target.
  const currentTarget = readlinkSync(packageLink);
  assert.match(currentTarget, /orchestration-skills/);
  lstatSync(packageLink);
  // unlink via the filesystem API is intentionally confined to the fixture.
  unlinkSync(packageLink);
  symlinkSync(external, packageLink, "dir");

  installSuite({ ...homes, sourceRoot: repositoryRoot });

  assert.equal(resolve(skillsRoot, readlinkSync(packageLink)), external);
});

test("refuses to overwrite an unmanaged current skill in any harness root", () => {
  const codexOwned = temporaryHomes();
  mkdirSync(join(codexOwned.codexHome, "skills", "relay"), { recursive: true });
  assert.throws(
    () => installSuite({ ...codexOwned, sourceRoot: repositoryRoot }),
    /Refusing to replace existing skill/,
  );
  assert.equal(
    existsSync(join(codexOwned.agentsHome, "orchestration-skills")),
    false,
  );

  assert.equal(existsSync(codexOwned.agentsHome), false);
  assert.equal(existsSync(codexOwned.claudeHome), false);

  const claudeOwned = temporaryHomes();
  mkdirSync(join(claudeOwned.claudeHome, "skills", "compass"), { recursive: true });
  assert.throws(
    () => installSuite({ ...claudeOwned, sourceRoot: repositoryRoot }),
    /Refusing to replace existing skill/,
  );
  assert.equal(
    existsSync(join(claudeOwned.agentsHome, "orchestration-skills")),
    false,
  );
  assert.equal(existsSync(claudeOwned.agentsHome), false);
  assert.equal(existsSync(join(claudeOwned.codexHome, "skills")), false);
});

test("refuses a symlinked or unmarked install root", () => {
  const homes = temporaryHomes();
  const external = join(dirname(homes.codexHome), "external-install");
  mkdirSync(external);
  mkdirSync(homes.agentsHome, { recursive: true });
  symlinkSync(external, join(homes.agentsHome, "orchestration-skills"), "dir");
  assert.throws(
    () => installSuite({ ...homes, sourceRoot: repositoryRoot }),
    /Refusing symlinked install directory/,
  );

  const second = temporaryHomes();
  mkdirSync(join(second.agentsHome, "orchestration-skills"), { recursive: true });
  assert.throws(
    () => installSuite({ ...second, sourceRoot: repositoryRoot }),
    /Refusing to replace unmanaged directory/,
  );
  assert.equal(existsSync(second.claudeHome), false);
  assert.equal(existsSync(join(second.codexHome, "skills")), false);
});

test("unsafe legacy state aborts install and uninstall; foreign state is tolerated", () => {
  // Symlinked legacy root: ambiguous ownership, must abort with no mutation.
  const symlinked = temporaryHomes();
  const external = join(dirname(symlinked.codexHome), "external-legacy");
  mkdirSync(external);
  symlinkSync(external, join(symlinked.codexHome, "orchestration-skills"), "dir");
  assert.throws(
    () => installSuite({ ...symlinked, sourceRoot: repositoryRoot }),
    /Refusing symlinked install directory/,
  );
  assert.equal(existsSync(symlinked.agentsHome), false);
  assert.throws(
    () => uninstallSuite(symlinked),
    /Refusing symlinked install directory/,
  );
  const symlinkedDoctor = doctorSuite({ ...symlinked, sourceRoot: repositoryRoot });
  assert.equal(symlinkedDoctor.ok, false);
  assert.equal(
    symlinkedDoctor.problems.some((problem) =>
      problem.includes("legacy codex bundle"),
    ),
    true,
  );

  // Malformed legacy marker: unreadable ownership, must abort with no mutation.
  const malformed = temporaryHomes();
  const malformedRoot = join(malformed.codexHome, "orchestration-skills");
  mkdirSync(malformedRoot, { recursive: true });
  writeFileSync(join(malformedRoot, ".codex-orchestration-install.json"), "{broken\n");
  assert.throws(() => installSuite({ ...malformed, sourceRoot: repositoryRoot }));
  assert.equal(existsSync(malformed.agentsHome), false);
  assert.throws(() => uninstallSuite(malformed));

  // A marker without a concrete package identity is malformed, not foreign:
  // ambiguous ownership must abort with no mutation.
  const emptyMarker = temporaryHomes();
  const emptyMarkerRoot = join(emptyMarker.codexHome, "orchestration-skills");
  mkdirSync(emptyMarkerRoot, { recursive: true });
  writeFileSync(join(emptyMarkerRoot, ".codex-orchestration-install.json"), "{}\n");
  assert.throws(
    () => installSuite({ ...emptyMarker, sourceRoot: repositoryRoot }),
    /Refusing to migrate unmanaged directory/,
  );
  assert.equal(existsSync(emptyMarker.agentsHome), false);
  assert.throws(() => uninstallSuite(emptyMarker));

  // A plain directory or another package's bundle is not ours: leave it alone.
  const foreign = temporaryHomes();
  const foreignRoot = join(foreign.codexHome, "orchestration-skills");
  mkdirSync(foreignRoot, { recursive: true });
  writeFileSync(join(foreignRoot, ".codex-orchestration-install.json"),
    `${JSON.stringify({ package: "someone-else/skills", version: "9.9.9" })}\n`);
  const result = installSuite({ ...foreign, sourceRoot: repositoryRoot });
  assert.equal(result.upgradedFrom, null);
  assert.equal(existsSync(foreignRoot), true);
  const foreignDoctor = doctorSuite({ ...foreign, sourceRoot: repositoryRoot });
  assert.equal(foreignDoctor.ok, true, JSON.stringify(foreignDoctor.problems));
});

test("repeated installation is idempotent and doctor passes", () => {
  const homes = temporaryHomes();
  installSuite({ ...homes, sourceRoot: repositoryRoot });
  const linkTargets = () =>
    allSkillRoots(homes).flatMap((skillsRoot) =>
      currentSkills.map((skill) => readlinkSync(join(skillsRoot, skill))),
    );
  const firstTargets = linkTargets();
  installSuite({ ...homes, sourceRoot: repositoryRoot });

  assert.deepEqual(linkTargets(), firstTargets);
  const doctor = doctorSuite({ ...homes, sourceRoot: repositoryRoot });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.problems));
});

test("upgrade removes retired managed skills from every harness root", () => {
  const homes = temporaryHomes();
  const result = installSuite({ ...homes, sourceRoot: repositoryRoot });
  const retiredSkills = ["teamwork", "decision-lab", "grilling"];
  for (const retired of retiredSkills) {
    mkdirSync(join(result.installRoot, retired));
    writeFileSync(join(result.installRoot, retired, "SKILL.md"), "# retired\n");
    for (const skillsRoot of allSkillRoots(homes)) {
      symlinkSync(
        join(result.installRoot, retired),
        join(skillsRoot, retired),
        "dir",
      );
    }
  }

  installSuite({ ...homes, sourceRoot: repositoryRoot });

  for (const retired of retiredSkills) {
    assert.equal(existsSync(join(result.installRoot, retired)), false);
    for (const skillsRoot of allSkillRoots(homes)) {
      assert.equal(existsSync(join(skillsRoot, retired)), false);
    }
  }
  assert.equal(
    lstatSync(join(homes.codexHome, "skills", "compass")).isSymbolicLink(),
    true,
  );
});

test("uninstall removes managed bundle and preserves unrelated state", () => {
  const homes = temporaryHomes();
  createManagedV1(homes.codexHome);
  installSuite({ ...homes, sourceRoot: repositoryRoot });
  const unrelatedTarget = join(homes.codexHome, "elsewhere");
  mkdirSync(unrelatedTarget);
  symlinkSync(unrelatedTarget, join(homes.codexHome, "skills", "other-skill"), "dir");

  const result = uninstallSuite(homes);

  assert.equal(result.removed.length > 0, true);
  assert.deepEqual(result.leftovers, []);
  assert.equal(
    readdirSync(homes.agentsHome).some((name) => name.includes(".removing-")),
    false,
  );
  assert.equal(existsSync(join(homes.agentsHome, "orchestration-skills")), false);
  for (const skillsRoot of allSkillRoots(homes)) {
    for (const skill of currentSkills) {
      assert.equal(existsSync(join(skillsRoot, skill)), false);
    }
  }
  assert.equal(
    lstatSync(join(homes.codexHome, "skills", "other-skill")).isSymbolicLink(),
    true,
  );
  const hooks = JSON.parse(
    readFileSync(join(homes.codexHome, "hooks.json"), "utf8"),
  );
  assert.deepEqual(hooks.hooks.PreToolUse, [
    {
      matcher: "foreign",
      hooks: [{ type: "command", command: "preserve-me" }],
    },
  ]);
  assert.deepEqual(uninstallSuite(homes).removed, []);
});

test("uninstall preflights malformed hooks before removing skill links", () => {
  const homes = temporaryHomes();
  installSuite({ ...homes, sourceRoot: repositoryRoot });
  writeFileSync(join(homes.codexHome, "hooks.json"), "{malformed\n");

  assert.throws(() => uninstallSuite(homes), /JSON/);
  assert.equal(existsSync(join(homes.agentsHome, "orchestration-skills")), true);
  for (const skillsRoot of allSkillRoots(homes)) {
    for (const skill of currentSkills) {
      assert.equal(lstatSync(join(skillsRoot, skill)).isSymbolicLink(), true);
    }
  }
});

test("failed uninstall rolls the canonical bundle and links back", () => {
  const homes = temporaryHomes();
  installSuite({ ...homes, sourceRoot: repositoryRoot });
  // A second marker-backed bundle at the legacy path, with no links of its own.
  const legacyRoot = join(homes.codexHome, "orchestration-skills");
  mkdirSync(legacyRoot, { recursive: true });
  writeFileSync(
    join(legacyRoot, ".codex-orchestration-install.json"),
    `${JSON.stringify({ package: "@dylanmccavitt/skills", version: "3.0.0" })}\n`,
  );
  // Parking the legacy root must fail deterministically (even as root):
  // every bounded park candidate is already occupied, so the probe refuses
  // before renaming, regardless of privileges.
  for (const suffix of ["", "-2", "-3", "-4", "-5"]) {
    const occupied = `${legacyRoot}.removing-${process.pid}${suffix}`;
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "occupied.txt"), "occupied\n");
  }
  assert.throws(() => uninstallSuite(homes), /Refusing to park/);

  const installRoot = join(homes.agentsHome, "orchestration-skills");
  assert.equal(existsSync(join(installRoot, ".codex-orchestration-install.json")), true);
  assert.equal(existsSync(legacyRoot), true);
  for (const skillsRoot of allSkillRoots(homes)) {
    for (const skill of currentSkills) {
      const link = join(skillsRoot, skill);
      assert.equal(lstatSync(link).isSymbolicLink(), true);
      assert.equal(existsSync(join(link, "SKILL.md")), true);
    }
  }
});

test("pre-existing hook temp debris is preserved on a failed write, and no backups leak", () => {
  const homes = temporaryHomes();
  const { installRoot } = createManagedV1(homes.codexHome);
  // One captured link dangles: its bundle directory is gone. Rollback must
  // restore it anyway — the captured pre-state is the contract.
  rmSync(join(installRoot, "gepetto"), { recursive: true });
  const hooksPath = join(homes.codexHome, "hooks.json");
  const hooksBefore = readFileSync(hooksPath, "utf8");
  // Dangling-symlink debris at this run's temp path: not ours to delete.
  const temporary = join(homes.codexHome, `hooks.json.tmp-${process.pid}`);
  symlinkSync(join(homes.codexHome, "missing-target"), temporary);

  assert.throws(() => uninstallSuite(homes), /EEXIST/);

  assert.equal(lstatSync(temporary).isSymbolicLink(), true);
  assert.equal(readFileSync(hooksPath, "utf8"), hooksBefore);
  assert.equal(
    readdirSync(homes.codexHome).some((name) => name.startsWith("hooks.json.backup-")),
    false,
  );
  // Rollback restored the parked bundle and its links.
  for (const skill of v1Skills) {
    assert.equal(
      lstatSync(join(homes.codexHome, "skills", skill)).isSymbolicLink(),
      true,
    );
  }
});

test("a symlinked skills root receives links that resolve from its physical location", () => {
  const homes = temporaryHomes();
  const realSkills = join(dirname(homes.codexHome), "real-codex-skills");
  mkdirSync(realSkills, { recursive: true });
  symlinkSync(realSkills, join(homes.codexHome, "skills"), "dir");

  const result = installSuite({ ...homes, sourceRoot: repositoryRoot });

  for (const skill of currentSkills) {
    // The link lands in the physical directory and resolves from there —
    // and therefore also through the symlinked spelling.
    const physicalLink = join(realSkills, skill);
    assert.equal(lstatSync(physicalLink).isSymbolicLink(), true);
    assert.equal(existsSync(join(physicalLink, "SKILL.md")), true);
    assert.equal(
      existsSync(join(homes.codexHome, "skills", skill, "SKILL.md")),
      true,
    );
  }
  assert.equal(result.skillRoots.includes(realSkills), true);
  const doctor = doctorSuite({ ...homes, sourceRoot: repositoryRoot });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.problems));
});

test("nested canonical and legacy roots are refused before any mutation", () => {
  const homes = temporaryHomes();
  const { installRoot: legacyRoot } = createManagedCodexV3(
    homes.codexHome,
    repositoryRoot,
  );
  const nested = {
    ...homes,
    agentsHome: join(legacyRoot, "a"),
  };

  assert.throws(
    () => installSuite({ ...nested, sourceRoot: repositoryRoot }),
    /Refusing nested canonical and legacy install roots/,
  );
  assert.throws(() => uninstallSuite(nested), /Refusing nested/);
  const doctor = doctorSuite({ ...nested, sourceRoot: repositoryRoot });
  assert.equal(doctor.ok, false);
  assert.equal(
    doctor.problems.some((problem) => problem.includes("nested")),
    true,
    JSON.stringify(doctor.problems),
  );
  // The legacy bundle and its links are untouched.
  assert.equal(
    existsSync(join(legacyRoot, ".codex-orchestration-install.json")),
    true,
  );
  for (const skill of currentSkills) {
    assert.equal(
      lstatSync(join(homes.codexHome, "skills", skill)).isSymbolicLink(),
      true,
    );
  }
});

test("a foreign legacy directory is never touched, and links into it refuse pre-mutation", () => {
  const homes = temporaryHomes();
  const legacyRoot = join(homes.codexHome, "orchestration-skills");
  mkdirSync(legacyRoot, { recursive: true });
  writeFileSync(join(legacyRoot, "README.txt"), "not ours\n");

  // Plainly foreign ownership at the legacy path is skipped, not migrated:
  // the install proceeds in its own namespace and leaves the directory
  // byte-for-byte alone.
  const result = installSuite({ ...homes, sourceRoot: repositoryRoot });
  assert.deepEqual(result.skills, currentSkills);
  assert.deepEqual(readdirSync(legacyRoot), ["README.txt"]);
  assert.equal(readFileSync(join(legacyRoot, "README.txt"), "utf8"), "not ours\n");

  // But a skill link that points into the foreign directory is unmanaged
  // state: the next install must refuse before mutating anything.
  mkdirSync(join(legacyRoot, "compass"), { recursive: true });
  const linkPath = join(homes.codexHome, "skills", "compass");
  unlinkSync(linkPath);
  symlinkSync(join(legacyRoot, "compass"), linkPath, "dir");
  assert.throws(
    () => installSuite({ ...homes, sourceRoot: repositoryRoot }),
    /Refusing to replace existing skill/,
  );
  assert.equal(
    resolve(dirname(linkPath), readlinkSync(linkPath)),
    join(legacyRoot, "compass"),
  );
});

test("a park refusal aborts uninstall before hooks are touched", () => {
  const homes = temporaryHomes();
  const { installRoot } = createManagedV1(homes.codexHome);
  const hooksPath = join(homes.codexHome, "hooks.json");
  const hooksBefore = readFileSync(hooksPath, "utf8");
  for (const suffix of ["", "-2", "-3", "-4", "-5"]) {
    const occupied = `${installRoot}.removing-${process.pid}${suffix}`;
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, "occupied.txt"), "occupied\n");
  }

  assert.throws(() => uninstallSuite(homes), /Refusing to park/);

  // The refusal happened while the uninstall was still a no-op: hooks are
  // byte-identical and no backup files were created.
  assert.equal(readFileSync(hooksPath, "utf8"), hooksBefore);
  assert.equal(
    readdirSync(homes.codexHome).some((name) => name.startsWith("hooks.json.backup-")),
    false,
  );
  for (const skill of v1Skills) {
    assert.equal(
      lstatSync(join(homes.codexHome, "skills", skill)).isSymbolicLink(),
      true,
    );
  }
});

test("symlink-aliased codex and agents homes are treated as one root", () => {
  const homes = temporaryHomes();
  mkdirSync(homes.agentsHome, { recursive: true });
  const aliasHome = join(dirname(homes.agentsHome), "codex-alias");
  symlinkSync(homes.agentsHome, aliasHome, "dir");
  const aliased = { ...homes, codexHome: aliasHome };

  installSuite({ ...aliased, sourceRoot: repositoryRoot });
  // A second install must not classify the live bundle as a legacy
  // duplicate and park or delete it through the aliased path.
  const second = installSuite({ ...aliased, sourceRoot: repositoryRoot });
  assert.equal(second.upgradedFrom !== null, true);
  assert.deepEqual(second.leftovers, []);
  const doctor = doctorSuite({ ...aliased, sourceRoot: repositoryRoot });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.problems));

  const removal = uninstallSuite(aliased);
  assert.deepEqual(removal.leftovers, []);
  assert.equal(existsSync(join(homes.agentsHome, "orchestration-skills")), false);
});

test("stale park debris from a reused PID never breaks or replaces the live bundle", () => {
  const homes = temporaryHomes();
  installSuite({ ...homes, sourceRoot: repositoryRoot });
  const installRoot = join(homes.agentsHome, "orchestration-skills");
  const debris = `${installRoot}.previous-${process.pid}`;
  mkdirSync(debris, { recursive: true });
  writeFileSync(join(debris, "stale.txt"), "debris from an earlier crashed run\n");

  const second = installSuite({ ...homes, sourceRoot: repositoryRoot });
  assert.notEqual(second.upgradedFrom, null);
  const doctor = doctorSuite({ ...homes, sourceRoot: repositoryRoot });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.problems));
  // The live bundle was parked past the debris, not renamed onto it.
  assert.equal(existsSync(join(installRoot, "compass", "SKILL.md")), true);
});

test("doctor flags oversized installed skills as advisories, not problems", () => {
  const homes = temporaryHomes();
  installSuite({ ...homes, sourceRoot: repositoryRoot });
  const bloated = join(homes.claudeHome, "skills", "bloated");
  mkdirSync(bloated, { recursive: true });
  writeFileSync(join(bloated, "SKILL.md"), Array(450).fill("word").join(" "));

  const doctor = doctorSuite({ ...homes, sourceRoot: repositoryRoot });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.problems));
  assert.deepEqual(
    doctor.advisories.map((advisory) => advisory.skill),
    ["bloated"],
  );
  assert.ok(doctor.advisories[0].words >= 400);
  // The shipped lean skills linked into three roots must not appear, and
  // the same physical skill must not be reported once per root.
  assert.equal(doctor.advisories.length, 1);
});

test("a broken source package leaves no directories behind", () => {
  const homes = temporaryHomes();
  const brokenSource = mkdtempSync(join(tmpdir(), "skills-broken-src-"));
  writeFileSync(
    join(brokenSource, "package.json"),
    `${JSON.stringify({ name: "@dylanmccavitt/agent-skills", version: "0.0.0" })}\n`,
  );

  assert.throws(() => installSuite({ ...homes, sourceRoot: brokenSource }));

  assert.equal(existsSync(homes.agentsHome), false);
  assert.equal(existsSync(homes.claudeHome), false);
  assert.equal(existsSync(join(homes.codexHome, "skills")), false);
  assert.equal(
    readdirSync(homes.codexHome).some((name) => name.startsWith(".skills-bundle-")),
    false,
  );
});

test("doctor leaves retired links into a foreign legacy directory unclaimed", () => {
  const homes = temporaryHomes();
  installSuite({ ...homes, sourceRoot: repositoryRoot });
  // A preserved foreign directory at the legacy path, plus an unrelated
  // retired-name link pointing into it.
  const foreignRoot = join(homes.codexHome, "orchestration-skills");
  mkdirSync(join(foreignRoot, "teamwork"), { recursive: true });
  writeFileSync(
    join(foreignRoot, ".codex-orchestration-install.json"),
    `${JSON.stringify({ package: "someone-else/skills", version: "9.9.9" })}\n`,
  );
  symlinkSync(
    join("..", "orchestration-skills", "teamwork"),
    join(homes.codexHome, "skills", "teamwork"),
    "dir",
  );

  const doctor = doctorSuite({ ...homes, sourceRoot: repositoryRoot });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.problems));
  assert.equal(
    lstatSync(join(homes.codexHome, "skills", "teamwork")).isSymbolicLink(),
    true,
  );
});

test("a failing harness-root mkdir removes directories already created", () => {
  const homes = temporaryHomes();
  // claudeHome is a dangling symlink: its skills root cannot be created,
  // and that failure arrives after the agents and codex roots were made.
  symlinkSync(
    join(dirname(homes.claudeHome), "nowhere"),
    homes.claudeHome,
    "dir",
  );

  assert.throws(() => installSuite({ ...homes, sourceRoot: repositoryRoot }));

  assert.equal(existsSync(homes.agentsHome), false);
  assert.equal(existsSync(join(homes.codexHome, "skills")), false);
});

test("dangling look-alike links are refused, not adopted, on fresh install", () => {
  const homes = temporaryHomes();
  const skillsRoot = join(homes.claudeHome, "skills");
  mkdirSync(skillsRoot, { recursive: true });
  // Points into the canonical namespace, but no marker vouches for it.
  symlinkSync(
    join(homes.agentsHome, "orchestration-skills", "compass"),
    join(skillsRoot, "compass"),
    "dir",
  );

  assert.throws(
    () => installSuite({ ...homes, sourceRoot: repositoryRoot }),
    /Refusing to replace existing skill/,
  );
  assert.equal(existsSync(join(homes.agentsHome, "orchestration-skills")), false);
  assert.equal(lstatSync(join(skillsRoot, "compass")).isSymbolicLink(), true);
});

test("non-sibling aliased homes canonicalize before any link is written", () => {
  const homes = temporaryHomes();
  // The real home exists but its skills child does not, and the alias sits
  // at a different directory depth than the home it points to.
  mkdirSync(homes.agentsHome, { recursive: true });
  const deep = join(dirname(homes.agentsHome), "deep", "nested");
  mkdirSync(deep, { recursive: true });
  const aliasHome = join(deep, "codex-alias");
  symlinkSync(homes.agentsHome, aliasHome, "dir");
  const aliased = { ...homes, codexHome: aliasHome };

  const result = installSuite({ ...aliased, sourceRoot: repositoryRoot });

  // One physical skills root, and every link resolves to a real SKILL.md.
  assert.equal(
    result.skillRoots.filter((root) => root === join(homes.agentsHome, "skills"))
      .length,
    1,
  );
  for (const skill of currentSkills) {
    const link = join(homes.agentsHome, "skills", skill);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(existsSync(join(link, "SKILL.md")), true);
  }
  const doctor = doctorSuite({ ...aliased, sourceRoot: repositoryRoot });
  assert.equal(doctor.ok, true, JSON.stringify(doctor.problems));
});

test("doctor reports missing, tampered, and unmigrated installs", () => {
  const homes = temporaryHomes();
  const missing = doctorSuite({ ...homes, sourceRoot: repositoryRoot });
  assert.equal(missing.ok, false);

  installSuite({ ...homes, sourceRoot: repositoryRoot });
  writeFileSync(
    join(homes.agentsHome, "orchestration-skills", ".codex-orchestration-install.json"),
    `${JSON.stringify({ package: "@dylanmccavitt/agent-skills", version: "0.0.0" })}\n`,
  );
  const tampered = doctorSuite({ ...homes, sourceRoot: repositoryRoot });
  assert.equal(tampered.ok, false);
  assert.equal(tampered.problems.some((problem) => problem.includes("version")), true);

  const unmigrated = temporaryHomes();
  createManagedCodexV3(unmigrated.codexHome, repositoryRoot);
  const legacy = doctorSuite({ ...unmigrated, sourceRoot: repositoryRoot });
  assert.equal(legacy.ok, false);
  assert.equal(
    legacy.problems.some((problem) => problem.includes("legacy")),
    true,
  );
});
