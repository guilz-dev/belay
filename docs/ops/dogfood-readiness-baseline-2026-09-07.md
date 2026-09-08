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

## Local implementation verification — 2026-09-08

This section appends local implementation evidence; it does not revise the frozen operator snapshot
or its cutoff and counts above.

- Verified source: `a49fc9d` (`fix: bind enforce readiness to evaluated evidence`). The inclusive
  remediation range is `16c09ed^..a49fc9d`: 28 commits from the frozen baseline through the final
  Task 13 fix.
- `pnpm typecheck`: exit 0.
- `pnpm lint`: exit 0; 15 warning-level non-null assertions and one informational useless
  `continue` remain.
- `pnpm test`: exit 0; 191 test files passed, 2,832 tests passed, and 4 tests were skipped.
- `pnpm corpus`: exit 0; 93/93 cases matched. Must-ask misses were 0/42,
  provably-benign blocks were 0/34, and accepted-benign mismatches were 0/17.
- `pnpm build`: exit 0; Cursor, Claude, Codex, and Cursor dispatcher runtime bundles were built.
- Package dry-run: exit 0 with 607 entries. The manifest included all six canonical corpus files:
  `baseline.json`, `coverage-matrix.json`, `coverage-matrix/README.md`, `judge-accuracy.json`,
  `README.md`, and `shell-commands.json`.

The fresh read-only `quality --target /Users/kaz/product/guilz/belay --json` evaluation intentionally
reported the installed 0.10.1 cohort as not ready (exit 1). Its canonical corpus passed all hard
gates with 93 cases and zero must-ask misses and provably-benign blocks. The active cohort had 537
gate events, a 22.53% classifier would-block rate, 3 availability asks, 0 reviewed provably-benign
events, 0 reviewed blocked events, 0 distinct reviewed sessions, 38 harvest candidates, and 3
availability candidates; `trafficReadyForEnforce` and `readyForEnforce` were both false. The quality
JSON did not expose cohort hashes, so no new hash was inferred; the frozen identifiers remain above.
No raw audit row or raw session ID was copied into this document.

Pending external evidence and actions:

- runtime package release: pending;
- release-window cutoff: pending until immediately before the first authorized upgrade;
- cross-repository upgrades and per-target version/hash/profile/storage verification: pending;
- new session-correlated cohort collection, including at least 150 reviewed provably-benign events
  across at least three sessions with zero availability asks: pending; and
- per-target quality approval and limited enforce trial without `--force`: pending.
