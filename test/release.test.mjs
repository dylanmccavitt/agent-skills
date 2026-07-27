import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  verifyReleaseHead,
  verifyReleaseTag,
} from "../scripts/verify-release.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);

test("accepts a release tag matching the package version", () => {
  assert.equal(verifyReleaseTag("v2.0.0", "2.0.0"), "v2.0.0");
});

test("rejects a release tag that does not match the package version", () => {
  assert.throws(
    () => verifyReleaseTag("v2.0.1", "2.0.0"),
    /expected v2\.0\.0/,
  );
});

test("requires the tag to match the exact current main head", () => {
  assert.equal(verifyReleaseHead("abc", "abc"), "abc");
  assert.throws(
    () => verifyReleaseHead("abc", "def"),
    /does not match current main head/,
  );
});

test("release notes describe the package rename and continuity", () => {
  const notes = readFileSync(resolve(root, "RELEASE_NOTES.md"), "utf8");
  assert.match(notes, /@dylanmccavitt\/agent-skills/);
  assert.match(notes, /@dylanmccavitt\/skills/);
  assert.match(notes, /Compass/);
  assert.match(notes, /Relay/);
  assert.match(notes, /Cairn/);
});

test("GitHub release job checks out the tag before reading release notes", () => {
  const workflow = readFileSync(
    resolve(root, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const releaseJob = workflow.slice(workflow.indexOf("  github-release:"));
  const checkout = releaseJob.indexOf("uses: actions/checkout@");
  const notesFile = releaseJob.indexOf("--notes-file RELEASE_NOTES.md");
  assert.ok(checkout >= 0);
  assert.ok(notesFile > checkout);
});
