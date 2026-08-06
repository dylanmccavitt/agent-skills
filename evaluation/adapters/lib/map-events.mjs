import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const KNOWN_SKILLS = new Set(["scout", "compass", "relay", "cairn"]);

function parseSelectedSkills(text) {
  const selected = new Set();
  const marker = /SKILL_BEHAVIOR_SELECTED\s*:\s*(\[[^\]]+\])/g;
  for (const match of text.matchAll(marker)) {
    try {
      const values = JSON.parse(match[1]);
      if (Array.isArray(values)) {
        for (const value of values) {
          if (KNOWN_SKILLS.has(value)) selected.add(value);
        }
      }
    } catch {
      // ignore malformed markers
    }
  }
  for (const skill of KNOWN_SKILLS) {
    const re = new RegExp(
      `(?:selected_skills|using skill|activated skill)\\s*[:=]\\s*"?${skill}"?`,
      "i",
    );
    if (re.test(text)) selected.add(skill);
  }
  return [...selected];
}

function parseJsonEvents(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes('"type"')) continue;
    try {
      const value = JSON.parse(trimmed);
      if (value && typeof value === "object" && typeof value.type === "string") {
        events.push(value);
      }
    } catch {
      // ignore non-event JSON lines
    }
  }
  const block = text.match(/SKILL_BEHAVIOR_EVENTS\s*:\s*(\[[\s\S]*?\])/);
  if (block) {
    try {
      const values = JSON.parse(block[1]);
      if (Array.isArray(values)) {
        for (const value of values) {
          if (value && typeof value === "object" && typeof value.type === "string") {
            events.push(value);
          }
        }
      }
    } catch {
      // ignore
    }
  }
  return events;
}

function listHtmlRecords(shelfDir) {
  if (!shelfDir || !existsSync(shelfDir)) return [];
  const records = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      const info = statSync(path);
      if (info.isDirectory()) walk(path);
      else if (entry.endsWith(".html")) records.push(path);
    }
  };
  walk(shelfDir);
  return records;
}

function readRecordStatus(location) {
  try {
    const text = readFileSync(location, "utf8");
    return text.match(/data-status="([^"]*)"/)?.[1];
  } catch {
    return undefined;
  }
}

function resolveShelfRecord(record, shelfDir) {
  const records = listHtmlRecords(shelfDir);
  const location = record.recordPath || records.at(-1);
  return location && existsSync(location) ? location : null;
}

// Resume is the read-only form: `status <record>`. A trailing status token is
// a mutation (`status <record> <status>`) and must not score as resume.
function isStatusResume(argv) {
  return argv[0] === "status" && argv.length === 2;
}

function prototypeEvidence(recordPath) {
  if (!recordPath || !recordPath.endsWith(".html")) {
    return { variants: [], structurally_different: false };
  }
  const lane = recordPath.replace(/\.html$/, ".proto");
  if (!existsSync(lane) || !statSync(lane).isDirectory()) {
    return { variants: [], structurally_different: false };
  }
  const names = readdirSync(lane, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const contents = names.map((name) => {
    const index = join(lane, name, "index.html");
    return existsSync(index) ? readFileSync(index, "utf8") : "";
  });
  return {
    variants: names.map((view) => ({ view })),
    structurally_different: contents.length >= 2 && new Set(contents).size >= 2,
  };
}

function eventsFromAudits(auditRecords, shelfDir) {
  const events = [];
  for (const record of auditRecords || []) {
    if (record.tool === "decision-shelf") {
      const argv = record.argv || [];
      const statusResume = isStatusResume(argv);
      if (argv[0] === "new" || statusResume || argv[0] === "proto") {
        const location = resolveShelfRecord(record, shelfDir);
        if (location) {
          events.push({
            type: "record",
            action: statusResume ? "resume" : "create",
            location,
            exists: true,
            refreshed: statusResume ? true : undefined,
            status: readRecordStatus(location),
          });
        }
      }
      if (argv[0] === "proto") {
        const location = resolveShelfRecord(record, shelfDir);
        const evidence = prototypeEvidence(location);
        events.push({
          type: "prototype",
          disposable: true,
          production_path: false,
          format: "html",
          structurally_different: evidence.structurally_different,
          variants: evidence.variants,
        });
      }
    }
    if (record.tool === "delivery") {
      const head = record.head || record.stdoutHead;
      if (head) {
        events.push({
          type: "receipt",
          synthesized: true,
          head,
          authoritative_head: head,
          head_source: record.head_source || "local_head",
          checks: [{ name: "delivery", passed: true, head }],
        });
      }
    }
  }
  return events;
}

export function mapEvents({
  scenario,
  agentStdout = "",
  agentStderr = "",
  auditRecords = [],
  shelfDir,
  mode = "live",
}) {
  const blob = `${agentStdout}\n${agentStderr}`;
  const selected_skills = parseSelectedSkills(blob);
  const declaredEvents = parseJsonEvents(blob);
  const observedEvents = eventsFromAudits(auditRecords, shelfDir);

  // Fail closed: only keep declared events that are backed by audits when they
  // claim durable CLI effects.
  const events = [];
  for (const event of [...declaredEvents, ...observedEvents]) {
    if (event.type === "receipt") {
      const hasDelivery = (auditRecords || []).some((entry) => entry.tool === "delivery");
      if (!hasDelivery) continue;
    }
    if (event.type === "record" || event.type === "prototype") {
      const hasShelf = (auditRecords || []).some((entry) => entry.tool === "decision-shelf");
      if (!hasShelf && !event.location) continue;
    }
    events.push(event);
  }

  let final = agentStdout.trim();
  if (!final) {
    final =
      mode === "plumbing"
        ? `Plumbing mode for ${scenario.id}: fixtures and wrappers materialized; no live agent invoked.`
        : `No agent stdout for ${scenario.id}.`;
  }

  const recordEvent = events.find((event) => event.type === "record" && event.location);
  if (recordEvent && !/Record:\s+\//.test(final)) {
    final = `${final}\nRecord: ${recordEvent.location}`;
  }

  return {
    id: scenario.id,
    selected_skills,
    events,
    final,
  };
}
