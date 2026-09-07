# Harvest review — 2026-09-07

## Scope

The operator snapshot reported 35 all-time shell candidates. The audit is append-only, so the
inspection run observed 36 after diagnostic commands were recorded. Re-scoping the same log to
the active runtime artifact, decision config, and boundary profile produced 2 classifier
candidates and 3 availability items.

No approval event was treated as a benign label. Fingerprints below are truncated display values,
not authorization material.

## Already corrected in the current EffectPlan

| Fingerprint | Observed command class | Current result | Review |
| --- | --- | --- | --- |
| `858ea56e9e9a…` | `rtk git status --short` | allow / read-only | provably benign |
| `794b46c3d7c0…` | `rtk git status --short --branch` | allow / read-only | provably benign |
| `d39b7d57bfa1…` | `rtk git diff -- …` | allow / read-only | provably benign |
| `379e832bdd36…` | `rtk vitest …` | allow-flagged / local mutation | accepted benign |
| `de8428cc2916…` | `rtk vitest … -t …` | allow-flagged / local mutation | accepted benign |

These cases are added to the corpus to retain current behavior. They do not grant runtime
authority.

## Correct asks retained

The backlog contains publish, push/PR helper, and commit workflows. They can create remote or
durable local effects and remain MUST-ASK or unknown until their exact script effects are proven.
Representative fingerprints are `c9c201684c5e…`, `81029b0e0d1e…`, `b15f532b4f20…`,
`e5e9830366e7…`, `ad7ffc0ca266…`, and `1877dc847b74…`.

One-off inline programs, redacted heredocs, repository-specific scripts, and shell loops are not
promoted. Their audit summaries are insufficient evidence for a safe EffectPlan change.

## Active-cohort residuals

- `0e7119f1d2b4…`: a multi-segment read-only inspection over worktree hook files. Keep as a
  candidate until each pipeline segment and glob is represented without an indeterminate effect.
- `97447732c7c0…`: a loop over config-trust records. Prefer a direct read-only command; shell-loop
  interpretation is outside the current classifier scope.
- Three `missing_trusted_cwd` records belong to multi-target upgrade functions/loops. Resolve them
  operationally with one target per host invocation; do not add them to corpus.

## Decision

Harvest must default to the active cohort. Historical review remains available only through an
explicit `--all-cohorts` request. This prevents corrected old-runtime behavior and legitimate
MUST-ASK traffic from being presented as the current enforce-readiness backlog.
