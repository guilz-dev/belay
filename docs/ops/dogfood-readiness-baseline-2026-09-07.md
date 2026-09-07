# Dogfood readiness baseline snapshot

- Baseline ID: `belay-2026-09-07`
- Cutoff timestamp: `2026-09-07T11:15:28.016Z`
- Cohort identity:
  - `runtimeArtifactHash`: `64bdae4b4b74d7f49f022cdde959bff2df25b91ee836ca80f145ae12e588cf9a`
  - `decisionConfigFingerprint`: `8867a58f615ef3f289a6aacf721dd16ba6184229bb92ceb294c129f193b0ccc8`
  - `boundaryProfile`: `l3-l4-only`
  - `runtime version`: `0.10.1`

This is a frozen operator snapshot captured on 2026-09-07. It records the immutable remediation
baseline for later review tasks and must not be rewritten by later local inspection.

Recorded values:

- audit size: 20.8 MB
- records: 4,376
- range: 2026-08-31 through 2026-09-07
- schema: v3
- all gate events: 1,748
- active runtime: 0.10.1
- active gate events: 176
- active would-block: 58
- active availability asks: 3 missing_trusted_cwd
- active classifier-quality asks: 55
- active classifier-quality rate: 31.25%
- corpus: 79 cases, 100% accuracy
- harvest: 35 candidates, 3 availability items

Later local inspection appended additional allow events. That later inspection is informational only
and must not rewrite this baseline or the frozen counts above.
