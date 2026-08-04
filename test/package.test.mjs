import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const expectedDirectories = ["bin/", "cairn/", "compass/", "scout/", "relay/"];

test("package allowlist ships only the skills, CLIs, and docs", () => {
  const pkg = JSON.parse(readFileSync(resolve(root, "package.json")));
  assert.equal(pkg.version, "1.1.0");
  assert.deepEqual(pkg.bin, {
    "agent-skills": "bin/install.mjs",
    "decision-shelf": "bin/decision-shelf.mjs",
    delivery: "bin/delivery.mjs",
  });
  assert.deepEqual(
    pkg.files.filter((item) => item.endsWith("/")),
    expectedDirectories,
  );
  for (const retired of [
    "teamwork",
    "governed-delivery",
    "prototype",
    "decision-lab",
    "deviling",
    "evals",
    "checkpoint",
    "gepetto",
    "orchestrate",
    "painter",
    "vigil",
    "hooks",
  ]) {
    assert.equal(pkg.files.some((item) => item.includes(retired)), false);
  }
});

test("packed npm artifact contains the exact skill and CLI surface", () => {
  const result = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout);
  const files = new Set(packed[0].files.map((entry) => entry.path));
  const required = [
    "bin/decision-shelf.mjs",
    "bin/delivery.mjs",
    "bin/install.mjs",
    "cairn/SKILL.md",
    "cairn/agents/openai.yaml",
    "compass/SKILL.md",
    "compass/agents/openai.yaml",
    "compass/assets/decision-record.html",
    "relay/SKILL.md",
    "relay/agents/openai.yaml",
    "relay/assets/receipt.md",
    "scout/SKILL.md",
    "scout/agents/openai.yaml",
    "LICENSE",
    "README.md",
    "package.json",
  ];
  for (const path of required) {
    assert.equal(files.has(path), true, `missing from tarball: ${path}`);
  }
  assert.deepEqual([...files].sort(), required.sort());
});

test("packed npm artifact keeps tests and repository tooling private", () => {
  const result = spawnSync(
    "npm",
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const packed = JSON.parse(result.stdout);
  const files = packed[0].files.map((entry) => entry.path);
  assert.equal(files.some((path) => path.startsWith("test/")), false);
  assert.equal(files.some((path) => path.startsWith("scripts/")), false);
});
