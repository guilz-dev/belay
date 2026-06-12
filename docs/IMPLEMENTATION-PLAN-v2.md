# agent-belay v2 実装プラン

Status: Draft
前提: [`CONCEPT-v2.0.md`](./CONCEPT-v2.0.md), [`SPEC-v2.0.md`](./SPEC-v2.0.md)

## 1. 方針

v1 は**製品アーキテクチャとしては破棄**する。
ただし、すべてを捨てるのではない。捨てるのは v1 の境界思想
(L1/L2/L3 の保証階段、`classifyShell` 中心の予測ゲート、egress/transactional を
安全境界に織り込む前提)であり、hook 配線・承認ループ・redaction・監査基盤などの
**外周資産は流用**する。

実装原則は 3 つ:

1. **core を作り直す**  
   v2 の判定軸 `location × opacity × effect × confidence` に合わせて、新しい
   verdict engine を作る。`classifyShell` の延命はしない。
2. **外周は最大限流用する**  
   adapter, installer, approval state, scrub, audit append は使う。
3. **文書より先に spike と corpus で叩く**  
   `~/.belay-spike/verdict.mjs` 相当の spike で contract を回し、通る形になってから
   core に統合する。

## 2. 仕分け

### 流用するもの

- approval loop
  - [`src/core/approval-service.ts`](../src/core/approval-service.ts)
  - [`src/core/approval-token.ts`](../src/core/approval-token.ts)
  - [`src/approve.ts`](../src/approve.ts)
  - [`src/revoke.ts`](../src/revoke.ts)
- hook / adapter wiring
  - [`src/adapters/shared/gate-runtime.ts`](../src/adapters/shared/gate-runtime.ts)
  - [`src/adapters/cursor/runtime-entry.ts`](../src/adapters/cursor/runtime-entry.ts)
  - [`src/adapters/claude/runtime-entry.ts`](../src/adapters/claude/runtime-entry.ts)
  - [`src/installer.ts`](../src/installer.ts)
- redaction / audit append 基盤
  - [`src/core/scrub.ts`](../src/core/scrub.ts)
  - [`src/audit.ts`](../src/audit.ts)
  - [`src/core/audit-query.ts`](../src/core/audit-query.ts)
  - [`src/core/audit-metrics.ts`](../src/core/audit-metrics.ts)
- config / layout の土台
  - [`src/core/config.ts`](../src/core/config.ts)
  - [`src/core/config-layers.ts`](../src/core/config-layers.ts)
  - [`src/adapters/layouts/*`](../src/adapters/layouts)

### 条件付きで流用するもの

- [`src/adapters/shared/gate-runtime.ts`](../src/adapters/shared/gate-runtime.ts)
  - I/O, approval consume, audit 書き込みは残す
  - `classifyShell` / transactional / egress 前提の分岐は除去または差し替え
- [`src/explain.ts`](../src/explain.ts)
  - CLI 入口は残せる
  - 説明内容は全面書き換え
- [`src/doctor.ts`](../src/doctor.ts)
  - hook / config / state の検査は残せる
  - egress / transactional / signing 前提の診断は整理が必要

### 作り直すもの

- shell verdict core
  - [`src/core/classify-shell.ts`](../src/core/classify-shell.ts)
  - [`src/core/shell-analysis.ts`](../src/core/shell-analysis.ts)
  - [`src/core/shell-tokenizer.ts`](../src/core/shell-tokenizer.ts)
  - [`src/core/shell-substitution.ts`](../src/core/shell-substitution.ts)
  - [`src/core/shell-unparseable.ts`](../src/core/shell-unparseable.ts)
- judge integration
  - [`src/core/judgment.ts`](../src/core/judgment.ts)
  - [`src/core/model-assist.ts`](../src/core/model-assist.ts)
- v2 trace schema と explain semantics

### 破棄対象

- transactional を安全境界として扱う統合ロジック
- egress を floor の意味論に織り込む統合ロジック
- layer profile 前提
  - [`src/conformance/layer-profiles.ts`](../src/conformance/layer-profiles.ts)
- v1 系 spec を実装ターゲットにする前提

## 3. v2 の最小コア

新しい core interface:

```ts
type VerdictPermission = 'allow' | 'ask'

type VerdictLocation = 'repo_local' | 'repo_outside' | 'external' | 'mixed' | 'unknown'
type VerdictOpacity = 'transparent' | 'recursive' | 'opaque' | 'unparseable'
type VerdictEffect = 'read_only' | 'local_mutation' | 'remote_mutation' | 'unknown'
type VerdictConfidence = 'deterministic' | 'llm' | 'assumed_repo_local' | 'verified_substrate'

interface VerdictResult {
  permission: VerdictPermission
  location: VerdictLocation
  opacity: VerdictOpacity
  effect: VerdictEffect
  confidence: VerdictConfidence
  reason: string
  commandRedacted: string
  fingerprint: string
  signals: string[]
}
```

新しい entrypoint:

- `verdict(command, context): VerdictResult`
- `context` は最低限 `cwd`, `repoRoot`, `trustedCwd`, `sensitivePaths`,
  `approvalCache`, `judge`, `mode`

## 4. 目標アーキテクチャ

### v2 engine の責務

1. shell を構造解析する
2. trusted `cwd` + `realpath` で path containment を確定する
3. `location`, `opacity`, `effect`, `confidence` を組み立てる
4. Tier1 judge を「repo 外 / remote change があるか」に限定して使う
5. `permission = allow | ask` を合成する
6. approval cache の hit/miss を反映する

### 外周の責務

1. hook payload を正規化する
2. verdict engine を呼ぶ
3. `ask` なら approval state を作成/消費する
4. trace を redaction 後に保存する
5. `explain` / `doctor` / metrics へ結果を見せる

## 5. 実装フェーズ

### Phase 0: 仕様固定のための spike

目的:

- `SPEC-v2.0` の contract をコードで叩く
- false positive / false negative の両端を早く炙る

作業:

1. `~/.belay-spike/verdict.mjs` に v2 contract を実装
2. corpus を追加
3. 次のケースを固定
   - `npm test` / `npm run build` / `make test`
   - `rm -rf .git`
   - `.env` / `credentials` 破壊
   - `bash -lc 'git status'`
   - `bash -lc 'rm ../other/x'`
   - `python -c 'open("/tmp/x","w")'`
   - `echo $(aws s3 rm ...)`

完了条件:

- contract 上の既知ケースが spike で通る
- `npm test` が毎回 ask にならない設計が見える
- `.git` / `sensitivePaths` が allow にならない

### Phase 1: v2 core の新設

目的:

- v1 core と切り離して v2 verdict engine を作る

新規ディレクトリ:

- `src/core/v2/`

最初に置くもの:

- `types.ts`
- `verdict.ts`
- `parser.ts`
- `containment.ts`
- `judge.ts`
- `fingerprint.ts`
- `approval-cache.ts`

実装順:

1. `types.ts`: verdict の内部型
2. `parser.ts`: segment / substitution / wrapper 再帰
3. `containment.ts`: trusted cwd + realpath + repo 内/外判定
4. `verdict.ts`: Tier0 合成
5. `judge.ts`: Tier1 質問の最小実装
6. `approval-cache.ts`: routine launcher の一度きり化

完了条件:

- `src/core/classify-shell.ts` に依存せず、v2 単独で verdict を返せる

### Phase 2: gate-runtime への接続

目的:

- 既存 hook runtime を流用しつつ、中身だけ v2 engine に差し替える

作業:

1. [`src/adapters/shared/gate-runtime.ts`](../src/adapters/shared/gate-runtime.ts) から
   `classifyShell` 依存を剥がす
2. `evaluateGatedAction` が v2 engine を呼ぶようにする
3. approval 作成/消費は現行実装を流用
4. audit record を v2 schema に差し替える

完了条件:

- Cursor/Claude の hook 入口は変えずに v2 verdict が使える
- `ask` の approval loop は壊れていない

### Phase 3: explain / doctor / audit の更新

目的:

- ユーザー可視面を v2 semantics に揃える

作業:

1. [`src/explain.ts`](../src/explain.ts) を v2 の軸へ書き換える
2. [`src/doctor.ts`](../src/doctor.ts) から v1 固有診断を整理する
3. metrics / audit query を新 schema に対応させる
4. `location`, `opacity`, `effect`, `confidence` を query できるようにする

完了条件:

- `explain` が v2 の理由をそのまま説明する
- `doctor` が v2 に無関係な診断を減らす
- 監査集計が新 schema で動く

### Phase 4: v1 削除

目的:

- 実装ターゲットを v2 のみへ絞る

削除候補:

- `classify-shell` 系旧 core
- transactional / egress を floor に統合するコード
- layer profile 前提の conformance
- v1 系 spec を参照する実装コメント/説明

完了条件:

- 製品コードが v1 semantics を参照しない
- docs と実装の主語が v2 に揃う

## 6. テスト戦略

### 最優先 corpus

- catastrophic false negative
  - `rm -rf .git`
  - `git push --force`
  - `dropdb prod`
  - `npm publish`
  - `bash -lc 'rm ../other/x'`
- catastrophic hidden by wrapper
  - `echo $(aws s3 rm ...)`
  - `python -c 'open("/tmp/x","w")'`
  - `find . -delete`
- routine false positive
  - `npm test`
  - `npm run build`
  - `make test`
  - `bash -lc 'git status'`

### テスト配置

- `src/__tests__/v2/`
  - `verdict-core.test.ts`
  - `containment.test.ts`
  - `approval-cache.test.ts`
  - `gate-runtime-v2.test.ts`
  - `audit-schema-v2.test.ts`

### 受け入れ基準

1. catastrophic corpus で false allow 0
2. routine launcher は cache 後に再 ask しない
3. `cwd` 欠落や symlink escape で false allow しない
4. secret-bearing trace が平文で残らない

## 7. 削るもの

v2 初期でやらない:

- L2 observed execution の本実装
- egress を floor の一部として再統合すること
- transactional backend の最適化
- v1 互換モード

## 8. リスク

### リスク1: opaque routine のノイズ

`npm run` / `make` を全部 ask にすると製品価値が死ぬ。
対策:

- approval cache を v2 初期から必須にする
- cache fingerprint に定義ファイル変更を含める

### リスク2: location 判定の甘さ

`repo_local` を推定で扱うと false allow を生む。
対策:

- trusted `cwd` + `realpath` を必須化
- `unknown` は常に `ask`

### リスク3: 文書先行

仕様だけ先に閉じると、実装で矛盾が出る。
対策:

- spike-first
- corpus-first

## 9. 最初の 1 週間

1. spike verdict を実装
2. corpus を追加
3. `src/core/v2/types.ts` と `src/core/v2/verdict.ts` を作る
4. `gate-runtime` から呼べる最小 adapter を作る
5. `npm test` と `.git` 破壊の両端ケースを CI に固定する

## 10. 完了条件

v2 実装完了の定義:

1. hook runtime が v2 verdict engine を使っている
2. `classifyShell` が製品の判定 core から外れている
3. catastrophic corpus で false allow 0
4. routine build/test が毎回 ask にならない
5. trace が redaction 済みで query 可能
6. docs の主語が `CONCEPT-v2.0` / `SPEC-v2.0` に統一されている
