import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function ensureAuditLog(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, "");
  return path;
}

export function appendAudit(path, record) {
  ensureAuditLog(path);
  appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`);
}

export function readAuditRecords(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
