#!/usr/bin/env node

import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@dylanmccavitt/agent-skills";
// Installs written before the package rename carry the old name in their
// marker; those roots are ours to upgrade or remove, never foreign.
const OWNED_PACKAGE_NAMES = new Set([PACKAGE_NAME, "@dylanmccavitt/skills"]);
const INSTALL_DIRECTORY = "agent-skills";
const MARKER_FILE = ".agent-skills-install.json";
// Installs written before the agent-skills rename live under the old
// directory name with the old marker filename; both are ours to migrate
// or remove, never foreign.
const LEGACY_INSTALL_DIRECTORY = "orchestration-skills";
const LEGACY_MARKER_FILE = ".codex-orchestration-install.json";
const SKILLS = ["compass", "scout", "relay", "cairn"];
const RETIRED_SKILLS = [
  "teamwork",
  "governed-delivery",
  "prototype",
  "decision-lab",
  "deviling",
  "devils-advocate",
  "decision-dialogue",
  "grilling",
  "gepetto",
  "painter",
  "vigil",
  "checkpoint",
  "orchestrate",
  "pinocchio",
  "jiminy",
  "implement",
  "review-gate",
];
const ALL_PACKAGE_SKILLS = [...new Set([...SKILLS, ...RETIRED_SKILLS])];

const VOICE_HOOK_COMMAND =
  '/usr/bin/env python3 "${CODEX_HOME:-$HOME/.codex}/orchestration-skills/hooks/voice_state.py" hook';
const LEGACY_HOOK_COMMAND =
  '/usr/bin/env python3 "${CODEX_HOME:-$HOME/.codex}/orchestration-skills/hooks/orchestration_hook.py"';

const PACKAGE_OWNED_HOOK_ENTRIES = {
  SessionStart: [
    {
      matcher: "^compact$",
      hooks: [
        {
          type: "command",
          command: LEGACY_HOOK_COMMAND,
          timeout: 10,
          statusMessage: "Checking checkpoint policy",
        },
      ],
    },
  ],
  SubagentStart: [
    {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: LEGACY_HOOK_COMMAND,
          timeout: 10,
          statusMessage: "Loading lane contract",
        },
      ],
    },
  ],
  SubagentStop: [
    {
      matcher: "*",
      hooks: [
        {
          type: "command",
          command: LEGACY_HOOK_COMMAND,
          timeout: 10,
          statusMessage: "Checking lane receipt",
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: "command",
          command: LEGACY_HOOK_COMMAND,
          timeout: 10,
          statusMessage: "Checking orchestration result",
        },
      ],
    },
  ],
  PreToolUse: [
    {
      matcher: "^(Bash|apply_patch|Edit|Write)$",
      hooks: [
        {
          type: "command",
          command: LEGACY_HOOK_COMMAND,
          timeout: 10,
          statusMessage: "Checking orchestration guard",
        },
      ],
    },
    {
      matcher: ".*",
      hooks: [
        {
          type: "command",
          command: VOICE_HOOK_COMMAND,
          timeout: 15,
          statusMessage: "Checking voice-task tool authority",
        },
      ],
    },
  ],
};

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function pathExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// How the canonical and legacy roots physically relate. Distinct roots may
// migrate; nested roots must be refused outright — creating the canonical
// bundle inside the legacy tree and then parking or deleting that tree
// would destroy the bundle that was just installed.
function legacyRelation(installRoot, legacyRoot) {
  const installPhysical = physicalPath(installRoot);
  const legacyPhysical = physicalPath(legacyRoot);
  const hasLegacy = installPhysical !== legacyPhysical;
  const nested =
    hasLegacy &&
    (installPhysical.startsWith(`${legacyPhysical}/`) ||
      legacyPhysical.startsWith(`${installPhysical}/`));
  return { hasLegacy, nested };
}

// The canonical root plus every physically distinct pre-rename root that
// may hold an earlier install: the old directory name under the agents
// home (pre-rename layout) and under the codex home (pre-v3 layout).
function candidateRoots(homes) {
  const installRoot = join(homes.agentsHome, INSTALL_DIRECTORY);
  const legacyRoots = [];
  const seen = new Set([physicalPath(installRoot)]);
  for (const candidate of [
    join(homes.agentsHome, LEGACY_INSTALL_DIRECTORY),
    join(homes.codexHome, LEGACY_INSTALL_DIRECTORY),
  ]) {
    const key = physicalPath(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    legacyRoots.push(candidate);
  }
  return { installRoot, legacyRoots };
}

function nestedRootPair(installRoot, legacyRoots) {
  const roots = [installRoot, ...legacyRoots];
  for (let index = 0; index < roots.length; index += 1) {
    for (let other = index + 1; other < roots.length; other += 1) {
      if (legacyRelation(roots[index], roots[other]).nested) {
        return [roots[index], roots[other]];
      }
    }
  }
  return null;
}

function assertDisjointRootSet(installRoot, legacyRoots) {
  const pair = nestedRootPair(installRoot, legacyRoots);
  if (pair) {
    throw new Error(
      `Refusing nested canonical and legacy install roots: ${pair[0]} and ${pair[1]} overlap.`,
    );
  }
}

// An unused sibling name to park a root under during a mutation. Debris
// from earlier runs (PIDs are reused) must never become a rename target —
// renaming onto an existing directory fails, and a rollback that trusted
// the name could then swap stale debris into a live location. Bounded:
// heavy debris accumulation is ambiguous state to refuse, never to reuse.
const PARK_ATTEMPTS = 5;
function parkPath(root, label) {
  let candidate = `${root}.${label}-${process.pid}`;
  for (let attempt = 2; pathExists(candidate); attempt += 1) {
    if (attempt > PARK_ATTEMPTS) {
      throw new Error(
        `Refusing to park ${root}: stale ${root}.${label}-* directories remain; delete them and retry.`,
      );
    }
    candidate = `${root}.${label}-${process.pid}-${attempt}`;
  }
  return candidate;
}

function managedLink(linkPath, targetPath) {
  if (!pathExists(linkPath) || !lstatSync(linkPath).isSymbolicLink()) return false;
  return resolve(dirname(linkPath), readlinkSync(linkPath)) === resolve(targetPath);
}

function readManagedInstall(installRoot, action = "replace") {
  if (!pathExists(installRoot)) return null;
  if (lstatSync(installRoot).isSymbolicLink()) {
    throw new Error(`Refusing symlinked install directory: ${installRoot}`);
  }
  const markerPath =
    [MARKER_FILE, LEGACY_MARKER_FILE]
      .map((name) => join(installRoot, name))
      .find((path) => pathExists(path)) ?? null;
  if (!markerPath) {
    // No marker at all: a directory some other tool owns, never ours.
    throw Object.assign(
      new Error(`Refusing to ${action} unmanaged directory: ${installRoot}`),
      { foreign: true },
    );
  }
  if (lstatSync(markerPath).isSymbolicLink()) {
    throw new Error(`Refusing to ${action} unmanaged directory: ${installRoot}`);
  }
  const marker = readJson(markerPath);
  // Foreign means a definite different owner. A marker without a concrete
  // package identity is malformed — ambiguous ownership, never tolerated.
  const packageName =
    marker && typeof marker === "object" && !Array.isArray(marker)
      ? marker.package
      : undefined;
  if (typeof packageName !== "string" || packageName.length === 0) {
    throw new Error(`Refusing to ${action} unmanaged directory: ${installRoot}`);
  }
  if (!OWNED_PACKAGE_NAMES.has(packageName)) {
    throw Object.assign(
      new Error(`Refusing to ${action} unmanaged directory: ${installRoot}`),
      { foreign: true },
    );
  }
  return marker;
}

// The legacy bundle lives under $CODEX_HOME. A directory that plainly belongs
// to something else (no marker, or another package's marker) is not ours to
// migrate and is left untouched. Symlinked roots or markers, malformed JSON,
// and read failures are ambiguous ownership and must abort before mutation.
function readOptionalMarker(installRoot, action) {
  try {
    return readManagedInstall(installRoot, action);
  } catch (error) {
    if (error?.foreign) return null;
    throw error;
  }
}

function parseHooks(hooksPath) {
  if (!pathExists(hooksPath)) return null;
  if (lstatSync(hooksPath).isSymbolicLink()) {
    throw new Error(`Refusing to modify symlinked hook configuration: ${hooksPath}`);
  }
  const config = readJson(hooksPath);
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error(`Hook configuration must be a JSON object: ${hooksPath}`);
  }
  if (config.hooks === undefined) config.hooks = {};
  if (!config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    throw new Error(`The hooks property must be a JSON object: ${hooksPath}`);
  }
  return config;
}

function withoutPackageOwnedHooks(existing) {
  if (!existing) return null;
  const cleaned = structuredClone(existing);
  for (const [event, ownedEntries] of Object.entries(PACKAGE_OWNED_HOOK_ENTRIES)) {
    const entries = cleaned.hooks[event];
    if (!Array.isArray(entries)) continue;
    const owned = new Set(ownedEntries.map((entry) => JSON.stringify(entry)));
    const kept = entries.filter((entry) => !owned.has(JSON.stringify(entry)));
    if (kept.length > 0) cleaned.hooks[event] = kept;
    else delete cleaned.hooks[event];
  }
  return cleaned;
}

// Returns the backup path it created (or null). Rollback paths restore
// with { backup: false } and remove the forward write's backup, so a
// failed transaction leaves no new files behind.
function writeHooks(hooksPath, config, { backup = true } = {}) {
  mkdirSync(dirname(hooksPath), { recursive: true });
  let backupPath = null;
  if (backup && pathExists(hooksPath)) {
    const timestamp = new Date().toISOString().replaceAll(":", "-");
    backupPath = `${hooksPath}.backup-${timestamp}`;
    copyFileSync(hooksPath, backupPath);
  }
  const temporary = `${hooksPath}.tmp-${process.pid}`;
  try {
    // "wx" creates the temporary exclusively: pre-existing debris at this
    // path (PIDs are reused) fails with EEXIST instead of being followed
    // or overwritten, and is then deliberately left alone below.
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporary, hooksPath);
  } catch (error) {
    if (error?.code !== "EEXIST") rmSync(temporary, { force: true });
    if (backupPath) rmSync(backupPath, { force: true });
    throw error;
  }
  return backupPath;
}

// Homes are canonicalized here so every derived path — install root, legacy
// root, skill roots, and the relative link targets computed between them —
// is spelled from the physical location, never an alias.
function resolveHomes({ codexHome, agentsHome, claudeHome } = {}) {
  return {
    codexHome: physicalPath(
      codexHome || process.env.CODEX_HOME || join(homedir(), ".codex"),
    ),
    agentsHome: physicalPath(
      agentsHome || process.env.AGENTS_HOME || join(homedir(), ".agents"),
    ),
    claudeHome: physicalPath(
      claudeHome || process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    ),
  };
}

// Resolve a path to its physical identity so symlink-aliased homes (for
// example CODEX_HOME pointing at AGENTS_HOME) compare as the same location.
// Segments that do not exist yet are re-appended to the canonicalized
// nearest existing ancestor, so an alias is resolved even before its
// children (like a not-yet-created skills directory) exist.
function physicalPath(path) {
  let prefix = resolve(path);
  let suffix = "";
  while (true) {
    try {
      return join(realpathSync(prefix), suffix);
    } catch {
      const parent = dirname(prefix);
      if (parent === prefix) return join(prefix, suffix);
      suffix = suffix ? join(basename(prefix), suffix) : basename(prefix);
      prefix = parent;
    }
  }
}

function skillRoots({ agentsHome, codexHome, claudeHome }) {
  const roots = [];
  const seen = new Set();
  for (const home of [agentsHome, codexHome, claudeHome]) {
    const root = join(home, "skills");
    const key = physicalPath(root);
    if (seen.has(key)) continue;
    seen.add(key);
    // Return the physical root: relative link targets are computed from
    // the root's spelling but resolved from its physical location, so a
    // symlinked skills directory would otherwise receive dangling links
    // that managedLink's lexical comparison could not detect.
    roots.push(key);
  }
  return roots;
}

// Lean-skill advisory: installed guides past this size are carrying
// mechanics that belong in tools or references, not prose.
const SKILL_WORD_LIMIT = 400;

export function scanSkillInventory(roots) {
  const advisories = [];
  const seen = new Set();
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const skillPath = join(root, entry.name, "SKILL.md");
      const identity = physicalPath(skillPath);
      if (seen.has(identity)) continue;
      let text;
      try {
        text = readFileSync(skillPath, "utf8");
      } catch {
        continue;
      }
      seen.add(identity);
      const words = text.split(/\s+/).filter(Boolean).length;
      if (words >= SKILL_WORD_LIMIT) {
        advisories.push({ skill: entry.name, path: skillPath, words });
      }
    }
  }
  return advisories.sort((a, b) => b.words - a.words);
}

export function installedSkillRoots(options = {}) {
  return skillRoots(resolveHomes(options));
}

function managedToAny(linkPath, ownedRoots, skill) {
  return ownedRoots.some((root) => managedLink(linkPath, join(root, skill)));
}

function preflightSkillLinks(roots, ownedRoots) {
  for (const skillsRoot of roots) {
    for (const skill of SKILLS) {
      const linkPath = join(skillsRoot, skill);
      if (pathExists(linkPath) && !managedToAny(linkPath, ownedRoots, skill)) {
        throw new Error(`Refusing to replace existing skill: ${linkPath}`);
      }
    }
  }
}

function stagePackage(sourceRoot, stagingHome, version) {
  const staging = mkdtempSync(join(stagingHome, ".skills-bundle-"));
  try {
    for (const skill of SKILLS) {
      cpSync(join(sourceRoot, skill), join(staging, skill), {
        recursive: true,
        errorOnExist: true,
      });
    }
    writeFileSync(
      join(staging, MARKER_FILE),
      `${JSON.stringify({ package: PACKAGE_NAME, version, skills: SKILLS }, null, 2)}\n`,
      { mode: 0o600 },
    );
    return staging;
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

function captureManagedLinks(roots, ownedRoots) {
  const links = [];
  for (const skillsRoot of roots) {
    for (const skill of ALL_PACKAGE_SKILLS) {
      const linkPath = join(skillsRoot, skill);
      if (managedToAny(linkPath, ownedRoots, skill)) {
        links.push({ linkPath, target: readlinkSync(linkPath) });
      }
    }
  }
  return links;
}

function removeManagedLinks(roots, ownedRoots) {
  const removed = [];
  for (const skillsRoot of roots) {
    for (const skill of ALL_PACKAGE_SKILLS) {
      const linkPath = join(skillsRoot, skill);
      if (managedToAny(linkPath, ownedRoots, skill)) {
        rmSync(linkPath);
        removed.push(linkPath);
      }
    }
  }
  return removed;
}

export function installSuite({
  codexHome,
  agentsHome,
  claudeHome,
  sourceRoot = packageRoot,
} = {}) {
  if (process.platform === "win32") {
    throw new Error("This installer currently supports macOS and Linux.");
  }

  const homes = resolveHomes({ codexHome, agentsHome, claudeHome });
  const { installRoot, legacyRoots } = candidateRoots(homes);
  assertDisjointRootSet(installRoot, legacyRoots);
  const roots = skillRoots(homes);
  const hooksPath = join(homes.codexHome, "hooks.json");
  const packageJson = readJson(join(sourceRoot, "package.json"));

  const priorMarker = readManagedInstall(installRoot);
  const ownedLegacies = legacyRoots
    .map((root) => ({ root, marker: readOptionalMarker(root, "migrate") }))
    .filter((entry) => entry.marker);
  // Only marker-verified roots vouch for existing links. A link that merely
  // points into an absent canonical root proves nothing about ownership, so
  // it is refused by preflight rather than adopted and rewritten.
  const ownedRoots = [
    ...(priorMarker ? [installRoot] : []),
    ...ownedLegacies.map((entry) => entry.root),
  ];

  preflightSkillLinks(roots, ownedRoots);
  const priorLinks = captureManagedLinks(roots, ownedRoots);
  const managedBefore = ownedRoots.length > 0;
  const originalHooks = managedBefore ? parseHooks(hooksPath) : null;
  const cleanedHooks = managedBefore ? withoutPackageOwnedHooks(originalHooks) : null;
  const hooksChanged =
    originalHooks !== null &&
    JSON.stringify(originalHooks) !== JSON.stringify(cleanedHooks);

  // Every failure-prone read is done; only now may the filesystem change.
  // Directories created by this invocation are tracked so any later failure
  // removes them and a failed install leaves no user-visible mutation.
  const createdPaths = [];
  const trackedMkdir = (path) => {
    const created = mkdirSync(path, { recursive: true });
    if (created) createdPaths.push(created);
  };
  const removeCreated = () => {
    for (const path of [...createdPaths].reverse()) {
      rmSync(path, { recursive: true, force: true });
    }
  };
  let staging;
  try {
    trackedMkdir(homes.agentsHome);
    for (const skillsRoot of roots) trackedMkdir(skillsRoot);
    staging = stagePackage(sourceRoot, homes.agentsHome, packageJson.version);
  } catch (error) {
    removeCreated();
    throw error;
  }
  // Park destinations must not collide with debris from an earlier run —
  // PIDs are reused, and renaming onto an existing directory fails, after
  // which a rollback could replace the live bundle with the stale one.
  // Probe for unused names (bounded: pathological debris accumulation is
  // ambiguous state to refuse, not to plow through) and track what this
  // run actually parked or installed, so rollback only undoes its own moves.
  let previous;
  const parkedLegacies = [];
  let hooksWritten = false;
  let hooksBackup = null;
  let liveParked = false;
  let installed = false;

  try {
    if (pathExists(installRoot)) {
      previous = parkPath(installRoot, "previous");
      renameSync(installRoot, previous);
      liveParked = true;
    }
    renameSync(staging, installRoot);
    installed = true;

    removeManagedLinks(roots, ownedRoots);
    for (const skillsRoot of roots) {
      for (const skill of SKILLS) {
        const linkPath = join(skillsRoot, skill);
        const targetPath = join(installRoot, skill);
        if (pathExists(linkPath)) rmSync(linkPath);
        symlinkSync(relative(skillsRoot, targetPath), linkPath, "dir");
      }
    }

    for (const { root } of ownedLegacies) {
      if (!pathExists(root)) continue;
      const parked = parkPath(root, "previous");
      renameSync(root, parked);
      parkedLegacies.push({ root, parked });
    }
    if (hooksChanged) {
      hooksBackup = writeHooks(hooksPath, cleanedHooks);
      hooksWritten = true;
    }
  } catch (error) {
    removeManagedLinks(roots, [installRoot]);
    if (installed && pathExists(installRoot)) rmSync(installRoot, { recursive: true });
    if (liveParked && pathExists(previous)) renameSync(previous, installRoot);
    for (const { root, parked } of parkedLegacies) {
      if (!pathExists(root) && pathExists(parked)) renameSync(parked, root);
    }
    for (const { linkPath, target } of priorLinks) {
      if (!pathExists(linkPath)) symlinkSync(target, linkPath, "dir");
    }
    if (hooksWritten) {
      writeHooks(hooksPath, originalHooks, { backup: false });
      if (hooksBackup) rmSync(hooksBackup, { force: true });
    }
    if (pathExists(staging)) rmSync(staging, { recursive: true });
    removeCreated();
    throw error;
  }

  // Post-commit garbage collection: the new bundle, links, and hooks are
  // already consistent, so a cleanup failure must never roll them back.
  const leftovers = [];
  const staleParked = [previous, ...parkedLegacies.map((entry) => entry.parked)];
  for (const stale of staleParked.filter(Boolean)) {
    if (!pathExists(stale)) continue;
    try {
      rmSync(stale, { recursive: true });
    } catch {
      leftovers.push(stale);
    }
  }

  return {
    agentsHome: homes.agentsHome,
    codexHome: homes.codexHome,
    claudeHome: homes.claudeHome,
    installRoot,
    skillRoots: roots,
    skills: SKILLS,
    upgradedFrom: priorMarker?.version || ownedLegacies[0]?.marker.version || null,
    leftovers,
  };
}

export function uninstallSuite({ codexHome, agentsHome, claudeHome } = {}) {
  const homes = resolveHomes({ codexHome, agentsHome, claudeHome });
  const { installRoot, legacyRoots } = candidateRoots(homes);
  assertDisjointRootSet(installRoot, legacyRoots);
  const roots = skillRoots(homes);
  const hooksPath = join(homes.codexHome, "hooks.json");
  const removed = [];

  const marker = readManagedInstall(installRoot, "remove");
  const ownedRoots = [
    ...(marker ? [installRoot] : []),
    ...legacyRoots.filter((root) => readOptionalMarker(root, "remove")),
  ];
  if (ownedRoots.length === 0) return { ...homes, removed, leftovers: [] };

  const originalHooks = parseHooks(hooksPath);
  const cleanedHooks = withoutPackageOwnedHooks(originalHooks);
  const hooksChanged =
    originalHooks !== null &&
    JSON.stringify(originalHooks) !== JSON.stringify(cleanedHooks);
  const priorLinks = captureManagedLinks(roots, ownedRoots);
  const parkedRoots = [];
  let hooksWritten = false;
  let hooksBackup = null;

  try {
    // Decide every park destination before any mutation: a bounded-probe
    // refusal must abort while the uninstall is still a no-op. The hook
    // rewrite comes last — it is the only step that creates a new file (its
    // backup), so every earlier failure aborts with nothing to clean up,
    // and its own failure is rolled back below without leaving backups.
    const parkPlan = ownedRoots.map((root) => ({
      root,
      parked: parkPath(root, "removing"),
    }));
    // Park every owned root by rename; deleting the parked copies is
    // post-commit cleanup below, so no failure here can lose a bundle.
    for (const { root, parked } of parkPlan) {
      renameSync(root, parked);
      parkedRoots.push({ root, parked });
    }
    removed.push(...removeManagedLinks(roots, ownedRoots));
    if (hooksChanged) {
      hooksBackup = writeHooks(hooksPath, cleanedHooks);
      hooksWritten = true;
      removed.push(`package-owned hook entries in ${hooksPath}`);
    }
  } catch (error) {
    for (const { root, parked } of parkedRoots) {
      if (!pathExists(root) && pathExists(parked)) renameSync(parked, root);
    }
    // Recreate every captured link, dangling ones included — the captured
    // pre-state is the rollback contract, and a symlink whose target was
    // already absent before the transaction was still part of it.
    for (const { linkPath, target } of priorLinks) {
      if (!pathExists(linkPath)) symlinkSync(target, linkPath, "dir");
    }
    if (hooksWritten) {
      writeHooks(hooksPath, originalHooks, { backup: false });
      if (hooksBackup) rmSync(hooksBackup, { force: true });
    }
    throw error;
  }

  // Post-commit garbage collection: links and hooks are already consistent
  // and every root is parked, so a deletion failure only leaves a reported
  // leftover directory, never a broken or rolled-back state.
  const leftovers = [];
  for (const { root, parked } of parkedRoots) {
    try {
      rmSync(parked, { recursive: true });
      removed.push(root);
    } catch {
      leftovers.push(parked);
    }
  }
  return { ...homes, removed, leftovers };
}

export function doctorSuite({
  codexHome,
  agentsHome,
  claudeHome,
  sourceRoot = packageRoot,
} = {}) {
  const homes = resolveHomes({ codexHome, agentsHome, claudeHome });
  const { installRoot, legacyRoots } = candidateRoots(homes);
  const nested = nestedRootPair(installRoot, legacyRoots);
  const roots = skillRoots(homes);
  const hooksPath = join(homes.codexHome, "hooks.json");
  const expectedVersion = readJson(join(sourceRoot, "package.json")).version;
  const checks = [];
  const check = (name, ok, detail) =>
    checks.push({ name, ok, detail: ok ? "ok" : detail });

  check(
    "disjoint install roots",
    !nested,
    nested && `canonical and legacy roots are nested: ${nested[0]} and ${nested[1]}`,
  );

  let marker = null;
  try {
    marker = readManagedInstall(installRoot, "inspect");
    check("managed install", marker !== null, `missing: ${installRoot}`);
  } catch (error) {
    check("managed install", false, error.message);
  }

  if (marker) {
    check(
      "installed version",
      marker.version === expectedVersion,
      `expected ${expectedVersion}, found ${marker.version || "<missing>"}`,
    );
  }

  const ownedLegacies = [];
  for (const legacyRoot of legacyRoots) {
    try {
      const legacyMarker = readOptionalMarker(legacyRoot, "inspect");
      if (legacyMarker) ownedLegacies.push(legacyRoot);
      check(
        `legacy bundle ${legacyRoot}`,
        legacyMarker === null,
        `managed legacy bundle remains (run install to migrate): ${legacyRoot}`,
      );
    } catch (error) {
      check(`legacy bundle ${legacyRoot}`, false, error.message);
    }
  }

  // Retired links are claimed only against marker-verified roots; a link
  // into a preserved foreign directory is not ours to report.
  const ownedRoots = [...(marker ? [installRoot] : []), ...ownedLegacies];

  for (const skillsRoot of roots) {
    for (const skill of SKILLS) {
      const linkPath = join(skillsRoot, skill);
      check(
        `skill link ${skill} in ${skillsRoot}`,
        managedLink(linkPath, join(installRoot, skill)),
        `missing or unmanaged symlink: ${linkPath}`,
      );
    }
    for (const skill of RETIRED_SKILLS) {
      const linkPath = join(skillsRoot, skill);
      check(
        `retired link ${skill} in ${skillsRoot}`,
        !managedToAny(linkPath, ownedRoots, skill),
        `package-owned retired link remains: ${linkPath}`,
      );
    }
  }

  if ((marker || ownedLegacies.length > 0) && pathExists(hooksPath)) {
    try {
      const config = parseHooks(hooksPath);
      const cleaned = withoutPackageOwnedHooks(config);
      check(
        "retired package hooks",
        JSON.stringify(config) === JSON.stringify(cleaned),
        `package-owned v1 hook entries remain: ${hooksPath}`,
      );
    } catch (error) {
      check("retired package hooks", false, error.message);
    }
  }

  const problems = checks
    .filter((entry) => !entry.ok)
    .map((entry) => `${entry.name}: ${entry.detail}`);
  const advisories = scanSkillInventory(roots);
  return { ok: problems.length === 0, problems, checks, advisories };
}

function parseArguments(arguments_) {
  const options = { command: "install" };
  const homeFlags = {
    "--codex-home": "codexHome",
    "--agents-home": "agentsHome",
    "--claude-home": "claudeHome",
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (homeFlags[argument]) {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`${argument} requires a path`);
      options[homeFlags[argument]] = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "uninstall" || argument === "doctor") {
      options.command = argument;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(
    "Install the Compass, Relay, and Cairn skills for every local harness\n\n" +
      "The managed bundle lives under ~/.agents/agent-skills; skill\n" +
      "links are created in ~/.agents/skills, $CODEX_HOME/skills, and\n" +
      "~/.claude/skills.\n\n" +
      "Usage:\n" +
      "  npx @dylanmccavitt/agent-skills@latest [uninstall|doctor]\n" +
      "    [--agents-home PATH] [--codex-home PATH] [--claude-home PATH]\n",
  );
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.help) {
      printHelp();
      return;
    }
    if (options.command === "uninstall") {
      const result = uninstallSuite(options);
      console.log(
        result.removed.length > 0
          ? `Removed:\n${result.removed.map((entry) => `  ${entry}`).join("\n")}`
          : `Nothing to remove in ${result.agentsHome} or ${result.codexHome}.`,
      );
      for (const leftover of result.leftovers ?? []) {
        console.error(
          `Warning: could not remove the parked bundle ${leftover}; delete it manually.`,
        );
      }
      return;
    }
    if (options.command === "doctor") {
      const result = doctorSuite(options);
      for (const entry of result.checks) {
        console.log(
          `${entry.ok ? "ok" : "problem"} - ${entry.name}` +
            (entry.ok ? "" : `: ${entry.detail}`),
        );
      }
      for (const advisory of result.advisories) {
        console.log(
          `advisory - oversized skill ${advisory.skill} (${advisory.words} words): ${advisory.path}` +
            " — lean skills defer mechanics to tools and references",
        );
      }
      if (!result.ok) process.exitCode = 1;
      return;
    }
    const result = installSuite(options);
    console.log(`Installed ${result.skills.join(", ")}.`);
    console.log(`  bundle: ${result.installRoot}`);
    for (const root of result.skillRoots) console.log(`  links:  ${root}`);
    if (result.upgradedFrom) {
      console.log(`Upgraded the managed bundle from ${result.upgradedFrom}.`);
    }
    for (const leftover of result.leftovers) {
      console.error(
        `Warning: could not remove the stale bundle ${leftover}; delete it manually.`,
      );
    }
    console.log("The skills will be available in your next agent session.");
  } catch (error) {
    console.error(`@dylanmccavitt/agent-skills: ${error.message}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  pathExists(process.argv[1]) &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
