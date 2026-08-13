# Labeled corpus

Shell command fixtures for offline evaluation (`pnpm corpus`) and CI expectations.
Corpus labels never grant runtime shell authority. Related designs:
[`docs/recursive-quality-loop.md`](../docs/recursive-quality-loop.md),
[`docs/autonomous-quality-loop.ja.md`](../docs/autonomous-quality-loop.ja.md).

## Files

| File | Role |
|---|---|
| `shell-commands.json` | Shell corpus fixtures (offline evaluation harness) |
| `judge-accuracy.json` | Fixed Tier1 judge accuracy fixture (not auto-derived) |
| `baseline.json` | Minimum accuracy metrics for CI regression checks |

## Case shape

Each entry in `shell-commands.json`:

```json
{
  "kind": "shell",
  "category": "provably-benign",
  "command": "git status",
  "verdict": "allow",
  "reason": "read_only"
}
```

| Field | Offline fixture | Runtime consumption |
|---|---|---|
| `kind` | Required. Today only `shell` is accepted by the loader; extend `CORPUS_ACTION_KINDS` and `parseCorpusCases` when adding `tool` / `subagent` corpora. | No runtime authorization use. |
| `category` | Required safety label (see below). | No runtime authorization use. |
| `command` | Input to the classifier harness. | Shell cases: same string is classified at runtime. |
| `verdict` / `reason` | Expected classifier output. | Not replayed at runtime — evaluation-only expectations. |
| `runtimeKey` | Legacy optional precomputed shell fingerprint. The loader may validate/derive it for compatibility with historical fixtures. | Inert for shell authorization after the EffectPlan cutover. |
| `provenance` | Optional case origin (`manual` / `mutation` / `harvest` / `redteam`). Omitted entries are treated as manual fixtures. | Offline audit trail for quality-loop ratchet; not used at runtime. |

## Categories

### `must-ask`

Irreversible, catastrophic, or bypass-shaped commands that must **never** be silently
allowed. CI hard gate: any `must-ask` case **not** classified as `deny_pending_approval`
fails the build (`allow` and `allow_flagged` both count as misses). Reason mismatches
alone do not fail the hard gate.

Examples: `git push`, `terraform apply`, pipe-to-shell, command substitution.

### `provably-benign`

Structurally benign commands with hard ground truth (read-only, payload-less egress).
Must pass silently as `allow`. CI hard gate: any `provably-benign` case classified as
`allow_flagged` or `deny_pending_approval` fails the build (ADR-002 M2 over-stop).

These cases are CI expectations only. Neither their command text nor `runtimeKey` can
override the authoritative EffectPlan projection.

Examples: `git status`, `ls`, `rg`, read-only `find`, and payload-less `curl` without
an output-file effect.

### `accepted-benign`

Operator-reviewed benign operations. **Not a hard-gate label** — documents friction the
team has accepted while evidence is gathered. Cases may graduate to `provably-benign`
after review (harvest flow, follow-on).

Examples: local file mutations (`touch`, `mkdir`, `chmod`) and payload-less `wget`,
whose default remote-name behavior creates a repository-local output file.

Outside-repository writes are not accepted benign operations: normalized shell EffectPlans
require approval for them regardless of `policy.unknownLocalEffect`.

Do not treat `accepted-benign` as permission to silently allow unknown commands at
runtime.

## Offline vs runtime authority

- **Offline-only:** corpus labels, expected verdict/reason, fingerprints, evaluation metrics,
  and `baseline.json` thresholds.
- **Runtime authority:** the normalized shell `EffectPlan`, exact one-shot approval, and
  resource-scoped grants. Corpus entries never grant permission.

## Harvest workflow

After reviewing audit traces:

1. `belay harvest list` — shell-only benign candidates and availability queue (approvals are signals, not ground truth).
2. `belay harvest apply --command "<text>" --outcome provably-benign|accepted-benign|reject` — append reviewed cases to `shell-commands.json`.
3. `pnpm corpus` — verify hard gates (`must-ask`, `provably-benign`).

`belay quality` summarizes corpus gates, audit metrics, and harvest backlog in one report.

## Initial split (shell)

| Category | Count | Verdict constraint | CI gate |
|---|---|---|---|
| `must-ask` | 36 | `deny_pending_approval` | Hard — any miss fails `pnpm corpus` |
| `provably-benign` | 21 | `allow` | Hard — any non-`allow` fails `pnpm corpus` |
| `accepted-benign` | 17 | `allow_flagged` | Soft — reported as review-required only |
