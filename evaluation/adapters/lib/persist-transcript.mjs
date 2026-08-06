import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function persistTranscript(transcriptDir, transcript) {
  if (!transcriptDir) return null;
  mkdirSync(transcriptDir, { recursive: true });
  const path = join(transcriptDir, `${transcript.id}.json`);
  writeFileSync(path, `${JSON.stringify(transcript, null, 2)}\n`);
  writeFileSync(join(transcriptDir, "transcripts.jsonl"), `${JSON.stringify(transcript)}\n`, {
    flag: "a",
  });
  return path;
}
