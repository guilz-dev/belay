# Coverage Matrix

Optional shell command fixtures for **Coverage Probe** (`pnpm probe:coverage`). This is
not a CI hard gate and does not grant runtime shell authority.

## Purpose

- Broaden EffectPlan classifier observation across nested chains, docker, python, npx, gh, etc.
- Support **repeatable** soft reporting (default exit 0)
- Promote only **independently reviewed** cases into [`shell-commands.json`](../shell-commands.json)

## Run

```bash
pnpm probe:coverage
pnpm probe:coverage -- --filter docker,python
pnpm probe:coverage -- --strict
pnpm probe:coverage:repeat
pnpm probe:coverage -- --output-dir artifacts/coverage-probe
```

Excluded from `pnpm test`. Meta tests for loader/runner live in
`src/__tests__/corpus/coverage-probe.test.ts`.

## Evaluation contexts (Phase 1)

| context | config | cwd | repoRoot |
|---------|--------|-----|----------|
| `default` | `DEFAULT_CONFIG_V3` | `/workspace/project/src` | `/workspace/project` |
| `structural` | enforce + deny policy | `src/__tests__/verdict/fixtures` | same |

Phase 2 adds `audit` via `--context audit` (opt-in).

## Case shape

```json
{
  "id": "nested.pipe.readonly",
  "command": "git status | head",
  "tags": ["nested", "pipe"],
  "expectations": {
    "default": { "verdict": "allow", "reason": "read_only" },
    "structural": { "verdict": "allow" }
  },
  "notes": "optional reviewer notes"
}
```

- **`expectations.<context>` omitted** → `observe_only` (record actual, no mismatch count)
- **`--strict`** fails only on expected mismatches (observe_only excluded)
- **`--filter` with no matches** exits **2** with a warning

## Promotion to corpus (manual only)

1. Confirm stable semantics via **human review** — repeat runs prove determinism only, not correctness
2. Check fingerprint collision against existing corpus (`deriveShellCorpusRuntimeKey`)
3. Add to `shell-commands.json` with provenance:

```json
{
  "provenance": {
    "source": "manual",
    "labelSource": "coverage-matrix-promotion",
    "sourceCaseId": "python.c.readonly",
    "reviewedBy": "human",
    "reviewedAt": "2026-08-18T00:00:00.000Z"
  }
}
```

| corpus category | allowed promotion source |
|-----------------|-------------------------|
| `must-ask` | human review or AUTO_LABEL_MUTATORS ratchet |
| `provably-benign` | **human review only** |
| `accepted-benign` | **human review only** |

Do not auto-promote from probe mismatches or repeated actuals.

## Safety

Coverage Probe classifies command strings only. It does not execute fixture commands or call
`approve --replay`.
