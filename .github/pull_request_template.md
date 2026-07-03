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
