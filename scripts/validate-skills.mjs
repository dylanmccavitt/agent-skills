#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
export const skillNames = ["compass", "relay", "cairn"];

function parseFrontmatter(text, path) {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error(`Missing YAML frontmatter: ${path}`);
  const entries = new Map();
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`Invalid frontmatter line in ${path}: ${line}`);
    entries.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  const keys = [...entries.keys()].sort();
  if (JSON.stringify(keys) !== JSON.stringify(["description", "name"])) {
    throw new Error(`Frontmatter must contain only name and description: ${path}`);
  }
  return entries;
}

export function validateSkill(root, name) {
  const skillRoot = resolve(root, name);
  const skillPath = resolve(skillRoot, "SKILL.md");
  const agentPath = resolve(skillRoot, "agents", "openai.yaml");
  if (!existsSync(skillPath) || !existsSync(agentPath)) {
    throw new Error(`Missing required skill files: ${name}`);
  }
  const skillText = readFileSync(skillPath, "utf8");
  const frontmatter = parseFrontmatter(skillText, skillPath);
  if (frontmatter.get("name") !== name) {
    throw new Error(`Skill name does not match folder: ${name}`);
  }
  if ((frontmatter.get("description") || "").length < 40) {
    throw new Error(`Skill description is too short: ${name}`);
  }
  for (const match of skillText.matchAll(/\]\(((?:references|assets)\/[^)]+)\)/g)) {
    const resource = resolve(skillRoot, match[1]);
    if (!existsSync(resource)) {
      throw new Error(`Missing referenced file ${match[1]} in ${name}`);
    }
  }

  const agentText = readFileSync(agentPath, "utf8");
  const shortDescription = agentText.match(/short_description:\s*"([^"]+)"/)?.[1] || "";
  if (shortDescription.length < 25 || shortDescription.length > 64) {
    throw new Error(`short_description must be 25-64 characters: ${name}`);
  }
  if (!agentText.includes(`$${name}`)) {
    throw new Error(`default_prompt must mention $${name}`);
  }
  return true;
}

async function auditInventory() {
  const { installedSkillRoots, scanSkillInventory } = await import(
    "../bin/install.mjs"
  );
  const advisories = scanSkillInventory(installedSkillRoots());
  if (advisories.length === 0) {
    console.log("No oversized installed skills.");
    return;
  }
  for (const advisory of advisories) {
    console.log(`${String(advisory.words).padStart(5)} words  ${advisory.path}`);
  }
  console.log(
    `${advisories.length} installed skill(s) over 400 words — lean skills defer mechanics to tools and references.`,
  );
}

async function main() {
  if (process.argv.includes("--inventory")) {
    await auditInventory();
    return;
  }
  for (const name of skillNames) validateSkill(repositoryRoot, name);
  console.log(`Validated ${skillNames.join(", ")}.`);
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === scriptPath) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
