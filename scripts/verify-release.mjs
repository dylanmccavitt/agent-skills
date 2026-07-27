#!/usr/bin/env node

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");

export function verifyReleaseTag(tag, version) {
  const expected = `v${version}`;
  if (tag !== expected) {
    throw new Error(
      `Release tag ${tag || "<missing>"} does not match package version ${version}; expected ${expected}.`,
    );
  }
  return expected;
}

export function verifyReleaseHead(tagHead, mainHead) {
  if (!tagHead || !mainHead || tagHead !== mainHead) {
    throw new Error(
      `Release head ${tagHead || "<missing>"} does not match current main head ${mainHead || "<missing>"}.`,
    );
  }
  return tagHead;
}

function main() {
  const packageJson = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  const [tag, tagHead, mainHead] = process.argv.slice(2);
  verifyReleaseTag(tag, packageJson.version);
  verifyReleaseHead(tagHead, mainHead);
  console.log(
    `Release tag ${tag} and head ${tagHead} match package ${packageJson.version} and current main.`,
  );
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === scriptPath) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
