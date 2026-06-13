---
name: verify-parallel
description: Runs repository verification commands in parallel via `make verify-parallel`. Use when the user asks to run verification quickly, parallelize test/lint/typecheck, or check CI-like health locally.
disable-model-invocation: true
---

# Verify Parallel

Run project verification in parallel from the repository root.

## Command

```bash
make verify-parallel
```

## Required Output Format

Report results in Japanese with:

1. Overall status (`success` / `failed`)
2. Per-task status for:
   - `lint`
   - `typecheck`
   - `test`
3. If failed, include the first actionable error and file path.

## Fallback

If `make verify-parallel` is missing, run these in parallel and wait for all:

```bash
(pnpm lint) & (pnpm typecheck) & (pnpm test) & wait
```
