# Skill-behavior transcripts

This directory holds **recorded** skill-behavior transcripts for offline grading:

```sh
node evaluation/skill-behavior-v1.mjs --transcripts evaluation/transcripts/skill-behavior-v1/plumbing.jsonl
```

Rules:

- Only persist transcripts produced by real adapter/agent runs.
- Never hand-write passing events to improve scores.
- `runs/` is gitignored scratch space for capture sessions.
- `plumbing.jsonl` starts empty until the first real plumbing/live captures are promoted.

Capture example:

```sh
SKILL_BEHAVIOR_MODE=live \
SKILL_BEHAVIOR_AGENT_CMD='["your-agent-cli","--skills-dir","$SKILL_BEHAVIOR_SKILLS_DIR"]' \
SKILL_BEHAVIOR_TRANSCRIPT_DIR="$PWD/evaluation/transcripts/skill-behavior-v1/runs/$(date -u +%Y%m%dT%H%M%SZ)" \
node evaluation/skill-behavior-v1.mjs \
  --runner "$PWD/evaluation/adapters/skill-behavior-cli.mjs" \
  --measure
```
