# Task 1 report — Immutable remediation baseline

## Delivered

- Created `docs/ops/dogfood-readiness-baseline-2026-09-07.md` as a frozen operator snapshot.
- Recorded baseline ID `belay-2026-09-07`, cutoff timestamp `2026-09-07T11:15:28.016Z`, and
  cohort identity fields:
  - `runtimeArtifactHash`: `64bdae4b4b74d7f49f022cdde959bff2df25b91ee836ca80f145ae12e588cf9a`
  - `decisionConfigFingerprint`: `8867a58f615ef3f289a6aacf721dd16ba6184229bb92ceb294c129f193b0ccc8`
  - `boundaryProfile`: `l3-l4-only`
  - `runtime version`: `0.10.1`
- Preserved all frozen counts from the operator snapshot and added the note that later local
  inspection appended additional allow events and must not rewrite the baseline.
- Linked `belay-2026-09-07` from the remediation status table in
  `docs/dogfood-audit-remediation-2026-08-22.ja.md` without replacing the older 2026-08-22
  evidence.

## Verification

- `rg -n "user_email|conversation_id|session_id|tool_use_id|Bearer |api[_-]?key" docs/ops/dogfood-readiness-baseline-2026-09-07.md`
  - no matches
- `git add docs/ops/dogfood-readiness-baseline-2026-09-07.md docs/dogfood-audit-remediation-2026-08-22.ja.md`
- `git commit -m "docs: freeze dogfood readiness baseline"`
  - commit `16c09ed` created successfully

## Files changed

- `docs/ops/dogfood-readiness-baseline-2026-09-07.md`
- `docs/dogfood-audit-remediation-2026-08-22.ja.md`

## Self-review

- The baseline document uses only the authoritative snapshot values from the brief and labels them
  as frozen, not live output.
- The remediation document change is limited to a single status-table row and keeps the older
  2026-08-22 evidence intact.
- The privacy grep passed with no matches.

## Concerns

- None.

## Fix Round 1

### What changed

- Removed the `immutable remediation baseline` row from section 9, `変更候補ファイル`.
- Added the same `belay-2026-09-07` link row to section 11, `実装状況（2026-08-22 時点）`,
  preserving the older 2026-08-22 evidence.

### Checks

- `rg -n "immutable remediation baseline|実装状況|変更候補ファイル|dogfood-readiness-baseline-2026-09-07" docs/dogfood-audit-remediation-2026-08-22.ja.md`
  - confirmed the row appears in section 11 at line 496 and no longer appears in section 9
- `rg -n "user_email|conversation_id|session_id|tool_use_id|Bearer |api[_-]?key" docs/ops/dogfood-readiness-baseline-2026-09-07.md`
  - no matches

### Result

- The baseline link now satisfies Step 2 by living in the current status section only.
