# SPEC v2.3 実装後 修正対応メモ

この文書は、`docs/SPEC-v2.3-implementation-design.md` に対するレビュー指摘を、**実装完了後に最小差分で反映するための具体タスク**に落としたものです。

**ステータス: 反映済み（2026-06-14）**

---

## 適用優先度と結果

| 項目 | 優先度 | 状態 | 反映箇所 |
|------|--------|------|----------|
| ① R-V2 閾値ロジック | P0 | 完了 | `src/core/audit-summary.ts` |
| ② recover 選定優先順位 | P1 | 完了 | `src/commands/recover.ts` |
| ③ disclaimer 固定文言 | P1 | 完了 | `src/core/recover-advice.ts`（実装済みを確認） |
| tier 推定の保存値優先 | P2 | 完了 | `src/core/audit-summary.ts` |
| enforce/audit 表示分離 | P2 | 完了 | `src/core/audit-summary.ts`, `src/commands/report.ts`, `src/commands/status.ts` |
| low-confidence recover | P2 | 完了 | `src/core/recover-advice.ts`, `src/commands/recover.ts` |
| `policy.fenceWarnThreshold` | P2 | 完了 | `src/core/config.ts`, `src/commands/report.ts` |

---

## ① R-V2（fence drift）是正【P0】— 反映済み

### 変更内容

- `DEFAULT_SILENT_PASS_THRESHOLD` を `0.98` → `0.5` に変更。
- `silentPassRate` は引き続き report の主要数値として表示。
- `gateEvents >= 20` かつ `silentPassRate < 0.5` のときのみ warning。
- 文言は断定を避け、「過剰ブロックの可能性」「`agent-belay explain` で偽陽性確認」を案内。

### 受け入れ条件（テスト済み）

- `silentPassRate=0.97` かつ `gateEvents>=20` → warning なし。
- `silentPassRate=0.40` かつ `gateEvents>=20` → warning あり。
- `gateEvents<20` → note のみ（判定保留）。

---

## ② recover 選定優先順位の是正【P1】— 反映済み

### 変更内容

自動選定の優先順位:

1. `effect=local_mutation` かつ `allow` / `allow_flagged`
2. その他の `local_mutation`
3. `inferWouldBlock===true` または `external_effect`

`--fingerprint` 指定時は従来通り一致レコードを最優先。

### 受け入れ条件（テスト済み）

- 同一期間に `ask(external, 新しい)` と `allow(local_mutation, 古い)` がある場合、デフォルト対象は `allow(local_mutation)`。

---

## ③ RecoverReport disclaimer の固定項目化【P1】— 反映済み

`RECOVER_DISCLAIMER` に以下を常時含める:

- `Advice is based on what belay observed through hooks; actions outside hook scope may not be visible.`

---

## 任意改善（P2）— 反映済み

### A. tier 推定の頑健化

- `record.confidence`（`llm`→Tier1）を第1優先。
- `confidence=deterministic` は `tier0_*`/`external_effect` reason のみ Tier0、それ以外は表示 tier `deterministic`。
- 保存値が無い古い record のみ `reason` 文字列でフォールバック。

### B. low-confidence の扱い

- `assessment.confidence` が `policy.confidenceThresholds.flag` 未満のとき、復元コマンドを出さず手動確認を案内。

### C. enforce/audit 表示分離

- `enforceAskCount` / `auditAskCount` / `unknownModeAskCount` を集計し、report/status で内訳表示。

### D. 未着手（将来）

- 時系列低下トレンドによる補助シグナル。

---

## 関連テスト

- `src/__tests__/audit-visibility.test.ts` — T-V1/T-V2、tier 推定、enforce/audit 内訳
- `src/__tests__/recover.test.ts` — 選定優先順位、disclaimer、no-exec 保証

---

## DoD（完了）

- P0/P1/P2（実装対象分）の受け入れ条件を満たす自動テストが追加され、成功。
- `docs/SPEC-v2.3-implementation-design.md` と実装が一致。
- R-V2 文言が「断定」から「可能性提示」に更新され、fence 的誤判定を誘発しない。
