# Recovery pilot evidence — 2026-09-13

Frozen snapshot from the clean Git / `git_worktree` operational pilot described in
[`docs/superpowers/plans/2026-09-13-recovery-operational-pilot.md`](../superpowers/plans/2026-09-13-recovery-operational-pilot.md).

## Environment

| Item | Value |
| --- | --- |
| Pilot worktree | `/Users/kaz/product/guilz/belay-recovery-pilot` |
| Pilot branch | `recovery/pilot-2026-09-13` (not merged to main) |
| Belay source build | `/Users/kaz/product/guilz/belay/dist/cli.js` (v0.12.1) |
| Hook path | global `~/.cursor/hooks/belay-runner belay-shell-gate` (`beforeShellExecution`) |
| Pilot config | `/Users/kaz/product/guilz/belay-recovery-pilot/.cursor/belay.config.json` |
| Checkpoint storage | `~/.config/agent-belay/recovery/checkpoints/` |
| Audit log | `.cursor/belay/audit-recovery-pilot.ndjson` → active `v0.12.1.log` |

Main dogfood worktree config (`.cursor/belay.config.json`) was **not** modified.

## Task results

| Task | Result |
| --- | --- |
| Task 0 baseline (`recovery-checkpoint`, `transactional-gate-runtime`, `transactional-eligibility`) | PASS (55 tests) |
| Task 1 pilot config template | PASS (`configs/recovery-pilot/belay.config.json`) |
| Task 2 preflight (`doctor`, `recover status`) | PASS — checkpoint enabled, `git_worktree` backend |
| Task 3 checkpoint via hook | PASS |
| Task 4 signed restore | PASS |
| Task 5 evidence | this document |
| Task 6 before snapshot | captured below (after for stage A pending) |

## Command under test

```sh
printf "recovery-pilot-after\n" > recovery-pilot-fixture.txt
```

`belay explain` (preflight):

- Verdict: `allow_flagged`
- Reason: `local_mutation`
- Transactional eligible: `true`
- Assessment confidence: `0.75` (within `[0.72, 0.88)`)

## Hook response (Task 3)

First `belay-shell-gate` invocation returned:

```json
{
  "permission": "deny",
  "user_message": "Belay executed this command safely in an isolated git worktree. Observed-safe file changes are already applied; do not retry the same command.",
  "agent_message": "Belay already applied the observed-safe effects of this shell command in isolation. Do not run it again."
}
```

Working tree file after hook: `recovery-pilot-after` (changed from `recovery-pilot-before`).

## Checkpoint

| Field | Value |
| --- | --- |
| checkpoint-id | `cp_538f5b4bec91472bba646eaf` |
| state after apply | `applied` |
| state after restore | `restored` |
| manifest.version | `2` |
| backend | `git_worktree` |
| resourceKind | `git_repository` |
| changeCount | `1` |

## Restore flow (Task 4)

1. `belay recover apply cp_538f5b4bec91472bba646eaf` → pending approval `belay_d7cae08909e3`
2. `belay approval-token belay_d7cae08909e3` → signed token retrieved locally (**not recorded here**)
3. `belay approve belay_d7cae08909e3 --token <signed-token>` → approval consumed
4. `belay recover apply cp_538f5b4bec91472bba646eaf` → `Recovery checkpoint ... restored.`

File content after restore: `recovery-pilot-before`

Re-apply on restored checkpoint: rejected (`recovery_checkpoint_not_applied:restored`).

## Metrics (recovery section)

```json
{
  "snapshot": {
    "attempts": 1,
    "applied": 1,
    "skipped": 0,
    "byBackend": { "git_worktree": 1 },
    "byResourceKind": { "git_repository": 1 }
  },
  "restore": {
    "applied": 1,
    "conflict": 0,
    "rejected": 1
  }
}
```

## recover status (after restore)

```text
Backend: git_worktree
Checkpointing: enabled
Checkpoints: 1 (0 recoverable)
States: {"restored":1}
Storage: 2198 bytes
```

## Stage A before snapshot (Task 6a)

Preserve these for config refactor regression comparison:

- Restore approval flow: `recover apply` → `approval-token` → `approve --token` → `recover apply`
- Hook deny reason path: isolated apply + `transactional_already_applied` on first shell gate call
- Checkpoint manifest: v2 / `git_worktree` / `git_repository`
- Control-plane checkpoint dir: `~/.config/agent-belay/recovery/checkpoints/`
- Pilot repoRoot filter: `/Users/kaz/product/guilz/belay-recovery-pilot`

## Notes

- Pilot uses `unknownLocalEffect: allow_flagged` and `mode: enforce` — not dogfood cohort.
- Global install scope (`installScope: global`) routes hooks through `~/.cursor/hooks/`; pilot config is repo-local per ADR-011.
- Pilot worktree and branch remain for optional stage-A after comparison; remove when no longer needed.
