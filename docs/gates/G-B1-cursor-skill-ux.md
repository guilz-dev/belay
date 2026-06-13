# G-B1 — Cursor skill/commands UX gate

Manual gate before R-S3 slash-command UX is finalized.

## Checklist

1. Install skill + commands: `agent-belay init --with-skill`
2. Confirm `disable-model-invocation: true` on `.cursor/skills/belay/SKILL.md`
3. Verify explicit `/belay-approve`, `/belay why`, `/belay explain`, `/belay status` routing
4. Confirm deny hook messages link to `/belay why` or `agent-belay explain`
5. Record outcomes: commands vs skills role split, auto-invocation behavior

## Pass criteria

- Explicit slash commands invoke the documented `agent-belay` CLI
- Hook deny messages remain the primary approval path
- No skill auto-invocation on routine turns when `disable-model-invocation: true`
