# G-B1 — Cursor skill/commands UX gate

Status: **Decision FIXED / Verification PENDING**

Manual gate for R-S3 slash-command UX. The UX decision is fixed below; fill in Execution
and Result after a Cursor smoke run.

## Decision

- Approval primary path: deny hook message + `/belay-approve`
- Richer help: `/belay why` / `/belay explain` / `/belay status`
- Keep `disable-model-invocation: true` (no re-evaluation to `false`)
- Commands = explicit routing; skill = descriptive front door; hook message = first-line approval surface

## Execution

| Field | Value |
| --- | --- |
| Date | TBD |
| Cursor version | TBD |
| OS | TBD |
| belay version | TBD |

## Result

- [ ] PASS: explicit `/belay-*` commands route correctly
- [ ] PASS: routine turns do not auto-invoke the skill
- [ ] PASS: deny message remains the primary approval path

## Procedure

1. Install skill + commands: `belay init --with-skill` (or `belay init-wizard`)
2. Confirm `disable-model-invocation: true` on `.cursor/skills/belay/SKILL.md`
3. Verify explicit `/belay-approve`, `/belay why`, `/belay explain`, `/belay status` routing
   (via `.cursor/commands/belay-*.md`)
4. Confirm deny hook messages link to `/belay why` or `belay explain`
5. Record outcomes: commands vs skills role split, auto-invocation behavior

## Pass criteria

- Explicit slash commands invoke the documented `belay` CLI
- Hook deny messages remain the primary approval path
- No skill auto-invocation on routine turns when `disable-model-invocation: true`
