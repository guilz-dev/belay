# SPEC v2.3 技術レビューと実装設計

対象: `docs/SPEC-v2.3.md`  
目的: v2.3（初 OSS 出荷）を、現行コードベースに整合した実装可能な設計へ落とし込む。

---

## 1. 技術レビュー（仕様の妥当性と実装観点）

`SPEC-v2.3` の方向性（「床は止める、skill は助言」）は現行実装と整合しており、特に以下は妥当:

- `R-V*` は監査ログの read-only 集計なので、既存の `audit.ndjson` 基盤を再利用しやすい。
- `R-R*` は「助言のみ・自動実行しない」が明確で、現行の gate 不変条件（ADR-002）を壊さない。
- `WS-Release` は既存 CI/保証テーブル運用の延長で実装可能。

一方、実装時に仕様を補強すべき曖昧点がある:

1) **ask 件数の定義（audit/enforce 差）**
- 現行ログは `wouldBlock` と `verdict` が併存し、audit mode では `permission=allow` でも `wouldBlock=true` があり得る。
- `R-V1` の ask は `inferWouldBlock(record)===true` を正とし、`verdict` 単独集計は使わない。

2) **silent-pass 率の式**
- 仕様は概念のみで式が未固定。
- 実装では `silentPassRate = (allow + allow_flagged) / gateEvents` を採用し、audit/enforce で同じ定義を使う。

3) **`status` 拡張か `report` 新設か**
- 現行 `status` は install health + approvals + dogfood の責務。
- `R-V1` の監査可視化は `report` 新設が責務分離に有利（`status` は薄く維持）。

4) **recover の情報源優先順位**
- redact 済み `summary` は情報欠落があるため、復元助言の主入力は `effect/location/assessment` を優先する必要がある。
- `reclassify` は補助用途（フォールバック）に限定し、主要判定は保存済み監査軸から行う。

5) **「復元不能」の宣言条件**
- ask されたもの全てを「不能」と断定すると誤る（local mutation で戻せるケースがある）。
- `effect=external_effect` や remote 破壊系理由を優先して不能判定するルールを明文化する。

---

## 2. 現状実装レビュー（As-Is）

### 2.1 CLI とコマンド配線
- `src/cli.ts` に `report` / `recover` は未実装。
- 既存は `status`, `doctor`, `metrics`, `audit`, `explain`, `approve` など。

### 2.2 監査集計基盤
- `src/core/audit-metrics.ts` が `gateEvents`, `wouldBlockRate`, `byVerdict`, v2軸集計を提供。
- `src/core/audit-query.ts` が `inferWouldBlock`, 期間フィルタ、round-trip 生成を提供。
- `src/commands/audit.ts` に `summarize` はあるが、`R-V1` の ask/flag/allow + silent-pass 出力には未対応。

### 2.3 判定・可逆性関連
- `src/adapters/shared/gate-runtime.ts` が v2 軸（`location/opacity/effect/confidence`）を audit に記録。
- `src/core/v2/adapter.ts` 由来の reversibility 情報は既に `assessment` として監査へ保存される。
- `src/core/reclassify.ts` は再分類可能だが、summary 依存のため recover 主入力には不向き。

### 2.4 skill front-door
- `skills/belay/SKILL.md` は `/belay status` 等を CLI へルーティング。
- `skills/belay/belay-recover.md` は未存在。
- `src/installer/bootstrap.ts` の同梱 command template に recover/report が未登録。

### 2.5 テスト基盤
- `src/__tests__/audit-metrics.test.ts`, `audit-query.test.ts` が既存。
- `R-V1/R-V2/R-R1/R-R2` 専用の受け入れテストは未作成。

---

## 3. v2.3 実装方針（設計決定）

### 3.1 新規コマンド方針

#### A. `agent-belay report` を新設（R-V1 主体）
- 理由: `status` の責務肥大化を避けるため。
- 役割: 監査ログの read-only 要約（ask/flag/allow、silent-pass、直近 ask）。

推奨 CLI:

```text
agent-belay report [--target <dir>] [--since <iso>] [--until <iso>] [--limit <n>] [--json]
```

- `--limit` は `recent asks` の件数上限（既定 10）。
- `--json` は構造化出力で CI/機械利用を可能にする。

#### B. `agent-belay recover` を新設（R-R1 主体）

推奨 CLI:

```text
agent-belay recover [--target <dir>] [--since <iso>] [--fingerprint <fp>] [--command "<text>"] [--limit <n>] [--json]
```

- デフォルトは「直近の高リスク候補」を自動選択。
- `--fingerprint` 指定時は該当イベントを優先。
- `--command` 指定時は「明示指定したコマンド」を入力に助言を生成（SPEC R-R1 準拠）。
- 常に助言のみ（コマンド実行はしない）。

### 3.2 `status` との関係
- `R-V1` 準拠のため、**`/belay status` は監査可視化を必ず返す導線**にする。
- 実装案は以下のどちらかで固定する:
  - `agent-belay status` を拡張して可視化を内包する
  - `agent-belay report` を新設し、`/belay status` が内部的に `report` を呼ぶ
- 責務分離の観点では後者を推奨するが、ユーザー導線としては `/belay status` を正面入口に維持する。

---

## 4. データモデル設計

`src/types.ts` へ追加:

- `ReportOptions`
  - `targetDir?: string`
  - `since?: string`
  - `until?: string`
  - `limit?: number`
  - `json?: boolean`

- `AuditVisibilityReport`
  - `repoRoot: string`
  - `auditLogPath: string`
  - `gateEvents: number`
  - `askCount: number`
  - `flagCount: number`
  - `allowCount: number`
  - `silentPassRate: number`
  - `recentAsks: Array<{ timestamp?: string; summary: string; reason: string; tier: 'Tier0' | 'Tier1' | 'deterministic' }>`
  - `warnings: string[]`（R-V2 含む）

- `RecoverOptions`
  - `targetDir?: string`
  - `since?: string`
  - `fingerprint?: string`
  - `limit?: number`
  - `json?: boolean`

- `RecoverReport`
  - `repoRoot: string`
  - `target?: { timestamp?: string; fingerprint?: string; summary: string; reason: string; effect?: string; location?: string; permission?: string }`
  - `recoverable: boolean`
  - `confidence: 'high' | 'medium'`
  - `disclaimer: string[]`
  - `advice: string[]`
  - `warnings: string[]`

---

## 5. 実装詳細

### 5.1 R-V1: 監査可視化ロジック

新規 `src/core/audit-summary.ts` を追加し、以下を提供:

1. `summarizeAuditVisibility(records, filter, options)`
- 入力: `AuditRecord[]`（`parseAuditNdjson` + `toAuditRecord` 経由）
- 集計:
  - `askCount`: `inferWouldBlock(record) === true`
  - `flagCount`: `record.verdict === 'allow_flagged'`
  - `allowCount`: `record.verdict === 'allow'`
  - `silentPassRate = (allowCount + flagCount) / gateEvents`（`gateEvents===0` は 0）
- `recentAsks`: ask 条件で抽出し、時刻降順・上限 `limit`
- tier 推定:
  - `reason` が `tier0_` 始まり、または `external_effect` なら `Tier0`
  - `confidence==='llm'` または `reason==='unknown_local_effect'` なら `Tier1`
  - それ以外 `deterministic`

2. formatter
- `src/commands/report.ts` に `formatReport()` を実装し、人間可読出力を作る。
- 必須表示:
  - ask/flag/allow 件数
  - silent-pass 率（%）
  - 直近 ask（summary, reason, tier）

### 5.2 R-V2: fence 化自己診断

`audit-summary.ts` に `detectFenceDrift(summary, threshold)` を実装:

- 既定閾値: `silentPassRate < 0.98` で warning（SPEC の「98% 黙過」文脈に整合）
- サンプル数保護: `gateEvents < 20` では「判定保留」メモのみ（誤警報回避）
- 出力先:
  - `report` の `warnings`
  - `doctor` へも warning 連携（`src/commands/doctor.ts`）

### 5.3 R-R1: recover 助言エンジン

新規:
- `src/core/recover-advice.ts`
- `src/commands/recover.ts`
- （必要なら）`src/core/recover-git-probe.ts`

処理フロー:

1) 対象イベント選定
- gate event のみ対象。
- 優先条件:
  - `inferWouldBlock(record)===true`
  - もしくは `effect` が `local_mutation` / `external_effect`
- `--fingerprint` 指定時は一致レコード優先。

2) 情報ソース
- 第1: 監査記録の `effect/location/permission/reason/assessment`
- 第2: summary ベースの補助（文脈提示のみ）
- `reclassify` は第3フォールバック（必須ではない）

3) 助言生成（allowlist 方式）
- `effect=local_mutation`:
  - ファイル系復元を優先（`git restore -- <path>`, 必要時 `git checkout -- <path>`）
  - コミット後は `git revert <commit>`
- `effect=external_effect`:
  - 原則「取り消し不能の可能性」を明示
  - 虚偽の復元案を出さない
- `reason` が remote 破壊・exfiltration 系:
  - 明示的に「復元不能」を返す

4) show-don't-run
- 出力文は「候補」「実行前確認」「自己責任」を固定フレーミング化。
- 実行関数（`exec`/`spawn`）は呼ばない。

5) read-only probe（任意）
- `git rev-parse --is-inside-work-tree`
- `git status --porcelain`
- `git reflog -n 10`
- いずれも参照のみ。失敗しても助言生成は継続。

### 5.4 R-R2: restorability レンズ再利用

- recover 判定は `effect/location/assessment.reversibility` を主要根拠にする。
- `ask` だったことだけで不可逆確定しない。
- ただし `external_effect` と high-stakes reason は不能寄りで扱う。

---

## 6. 変更ファイル一覧（実装対象）

### 新規追加
- `src/core/audit-summary.ts`
- `src/commands/report.ts`
- `src/core/recover-advice.ts`
- `src/core/recover-git-probe.ts`（任意だが推奨）
- `src/commands/recover.ts`
- `skills/belay/belay-report.md`（または status に統合）
- `skills/belay/belay-recover.md`
- `src/__tests__/audit-visibility.test.ts`
- `src/__tests__/recover.test.ts`

### 既存更新
- `src/cli.ts`（`report` / `recover` 追加、help 更新）
- `src/types.ts`（新規型追加）
- `src/commands/doctor.ts`（R-V2 warning 連携）
- `src/installer/bootstrap.ts`（template 配布対象追加）
- `skills/belay/SKILL.md`（CLI mapping 更新）
- `README.md`（コマンド一覧、skill artifacts、v2.3 文言）
- `docs/semver-policy.md`（config version 記述を v4 へ更新）
- `src/index.ts`（必要なら `reportProject`/`recoverProject` export）

---

## 7. テスト設計（SPEC 受け入れ基準対応）

### T-V1（可視化一致）
- fixture NDJSON を固定で用意し、`ask/flag/allow/silentPassRate` を厳密比較。
- report text 出力と json 出力の両方を検証。

### T-V2（fence 化警告）
- silent-pass を閾値未満にする fixture を用意。
- `report.warnings` と `doctor.warnings` の双方に警告が載ることを検証。

### T-R1（正しい復元案）
- local mutation ケースで file-scope 復元案が出ることを検証。

### T-R2（自動実行しない）
- `recover` の実行器を抽象化し、**復元実行系 API（mutating runner）未呼び出し**を保証。
- read-only probe（`git status`/`reflog` 等）は許可し、参照以外の実行がないことを検証。

### T-R3（復元不能の明示）
- external irreversible ケースで `recoverable=false` と不能メッセージを確認。

### T-R4（不可逆手段を提示しない）
- 出力に `reset --hard` 等が含まれないことを deny-list で検証。

### T-R5（show-don't-run）
- 出力テンプレートに「実行前確認」フレーズが含まれることを検証。

---

## 8. 実装順序（最短で壊さない進め方）

1. `audit-summary.ts` と `report.ts` を先行実装（read-only なので安全）。
2. `cli.ts` へ `report` を配線し、`T-V1/T-V2` を先に緑化。
3. `recover-advice.ts` を pure function で実装（副作用なし）。
4. `recover.ts` 配線 + CLI 追加。
5. `T-R1..T-R5` を追加し、禁止事項（自動実行なし）を回帰テスト化。
6. skill/installer/docs を更新し、`init --with-skill` の配布整合を確認。
7. 既存の concept conformance テスト（FN=0/FP→0）を再実行して非回帰確認。

---

## 9. リスクとガードレール

- **最大リスク**: recover が誤案内して被害拡大。
  - 対策: allowlist 方式、不能時は「不能」と明示、低確信案は出さない。

- **第2リスク**: R-V2 の誤警報ノイズ。
  - 対策: 最低サンプル数条件（`gateEvents>=20`）を必須にする。

- **第3リスク**: status/report の責務混線。
  - 対策: 監査可視化は report に集約し、status は運用状態表示に限定。

---

## 10. v2.3 完了条件（コードベース基準）

- `agent-belay report` が R-V1/R-V2 を満たし、read-only で動作。
- `agent-belay recover` が R-R1/R-R2 を満たし、助言のみで動作。
- skill front-door に recover/report ルートが追加される。
- `T-V1/T-V2/T-R1..T-R5` が追加され、既存 conformance 群に非回帰。
- README/semver/docs が v2.3 出荷面の記述に一致する。
