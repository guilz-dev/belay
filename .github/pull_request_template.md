## Summary

<!-- What does this PR change? -->

## Quality loop checklist

<!-- Required when touching classifier, corpus, or quality-loop artifacts -->

- [ ] affected cases:
- [ ] new corpus entries:
- [ ] simulate note (triage only — not a merge gate):
- [ ] holdout result:
- [ ] risk note (why FN cannot increase):

## Verification

- [ ] `pnpm lint && pnpm typecheck`
- [ ] `pnpm test:structural`
- [ ] `pnpm corpus`
- [ ] `pnpm probe:adversarial` (if quality-loop related)

## Parallel merge hazard

<!-- Required when this PR touches runtime-entry, audit-*, or health-snapshot
     AND another open/recently-merged PR touched the same files -->

- [ ] listed overlapping PR(s): #
- [ ] ran combined verification:
      pnpm exec vitest run src/__tests__/cursor-host-denial-invariants.test.ts \
        src/__tests__/hooks-runtime.test.ts src/__tests__/audit-visibility.test.ts
