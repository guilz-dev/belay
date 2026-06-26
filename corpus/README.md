# Labeled corpus

Shell command fixtures for offline evaluation (`pnpm corpus`) and future runtime
standing-allow catalogs. Related design: [`docs/recursive-quality-loop.md`](../docs/recursive-quality-loop.md).

## Files

| File | Role |
|---|---|
| `shell-commands.json` | Shell corpus fixtures (offline evaluation harness) |
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
| `kind` | Required. Today only `shell` is accepted by the loader; extend `CORPUS_ACTION_KINDS` and `parseCorpusCases` when adding `tool` / `subagent` corpora. | Future catalogs filter by kind. |
| `category` | Required safety label (see below). | Hard gates (future) key off `must-ask` and `provably-benign` only. |
| `command` | Input to the classifier harness. | Shell cases: same string is classified at runtime. |
| `verdict` / `reason` | Expected classifier output. | Not replayed at runtime — evaluation-only expectations. |
| `runtimeKey` | Optional precomputed shell fingerprint for `provably-benign` cases. Loader verifies precomputed keys against `deriveShellCorpusRuntimeKey()`. | **Runtime-facing.** When omitted, derived on load via `enrichProvablyBenignRuntimeKeys()`. |

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

Runtime matching uses the shell verdict **fingerprint** (same as audit traces), either
stored in `runtimeKey` or derived by `enrichProvablyBenignRuntimeKeys()`. Standing-allow
(follow-on) consumes these keys — not one-off approval tokens.

Examples: `git status`, `ls`, `rg`, read-only `find`, payload-less `curl`/`wget`.

### `accepted-benign`

Operator-reviewed benign operations. **Not a hard-gate label** — documents friction the
team has accepted while evidence is gathered. Cases may graduate to `provably-benign`
after review (harvest flow, follow-on).

Examples: local file mutations (`touch`, `mkdir`, `chmod`), `node --version`,
repo-outside but recoverable writes.

Do not treat `accepted-benign` as permission to silently allow unknown commands at
runtime.

## Offline vs runtime

- **Offline-only:** `verdict`, `reason`, corpus evaluation metrics, `baseline.json` thresholds.
- **Runtime-facing:** `kind`, `category`, and `runtimeKey` (or derived fingerprint) for
  `provably-benign` shell entries. `accepted-benign` is fixture metadata until promoted.

## Initial split (shell)

| Category | Count | Verdict constraint | CI gate |
|---|---|---|---|
| `must-ask` | 14 | `deny_pending_approval` | Hard — any miss fails `pnpm corpus` |
| `provably-benign` | 7 | `allow` | Hard — any non-`allow` fails `pnpm corpus` |
| `accepted-benign` | 6 | `allow_flagged` | Soft — reported as review-required only |
