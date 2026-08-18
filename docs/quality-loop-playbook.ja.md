# Quality Loop Playbook（自律的テスト・改修ループ）

正本ドキュメント。関連: [`autonomous-quality-loop.ja.md`](./autonomous-quality-loop.ja.md)

## 概要

品質ループは **2 層** に分かれる:

1. **検知ループ（repo 内）** — `pnpm probe:adversarial`、corpus 評価、nightly strict
2. **自動修正ループ（repo 外運用）** — エージェントが修正・PR 化、人間がレビュー

`belay simulate` は **トリアージ専用**。merge 可否の最終判定は `pnpm corpus` のハードゲートとする。

## 評価コンテキスト（3 系統）

品質ループでは意図的に **3 つの評価コンテキスト** を使い分ける。混同すると「structural は緑なのに probe が赤」などの見かけの矛盾が起きる。

| 経路 | cwd | policy | 用途 |
|------|-----|--------|------|
| `pnpm test:structural` | `fixtures/`（= repoRoot） | `unknownLocalEffect: deny`（厳格） | パーサ・Tier0 回帰 |
| `pnpm corpus` / `pnpm probe:adversarial` | `/workspace/project/src` | `DEFAULT_CONFIG_V3`（`allow_flagged`） | 本番 DEFAULT に近いハーネス |
| `pnpm probe:coverage` | `default` / `structural` / `--context audit` | マトリクス fixture、実行なし | 広範分類の soft 観測 |
| runtime hook | 実際の作業ディレクトリ | ユーザー `config.json` | 本番 |

- **probe / corpus** はサブディレクトリ cwd でネスト `.git` 解決を検証する（`eval-context.test.ts`）。
- **structural-suite** は repoRoot cwd + deny でより厳格。`npm install` などは structural では ask、DEFAULT では allow になり得る。
- `quality-loop-session.sh --full` は両方走らせ、コンテキスト差による見逃しを減らす。

## 不変条件

- **P1**: must-ask 見逃し（FN）は最優先。FP は漸減目標
- **P2**: `provably-benign` / `accepted-benign` は自動追加しない
- **P3**: 自動ラベルは `AUTO_LABEL_MUTATORS`（意味保存が説明できる変異）のみ
- **P4**: コーパスは追加専用。ハードゲートは緩めない
- **P5**: 生成バッチは fix / holdout に分割し過学習を検知

## 1 イテレーションの手順

```text
GENERATE → LABEL → EVALUATE → DIAGNOSE → FIX → VERIFY → RATCHET
```

| 段階 | コマンド / 成果物 |
|---|---|
| GENERATE | `AUTO_LABEL_MUTATORS` × must-ask コア（[`src/corpus/mutators.ts`](../src/corpus/mutators.ts)） |
| LABEL | auto-label は must-ask のみ。harvest / FP プローブは人手 |
| EVALUATE | `pnpm corpus` / `pnpm test:structural` / `pnpm probe:coverage`（`--with-coverage`） / `pnpm test`（`--with-tests`） |
| DIAGNOSE | probe artifact、`belay explain` ヒント、mismatch 一覧 |
| FIX | tokenizer / parser / Tier0・Tier1 / judge |
| VERIFY | holdout 再評価、`pnpm test:stable`（`--verify`）、`belay simulate`（参考のみ） |
| RATCHET | 合格変異体のみ corpus 追加（`pnpm corpus:ratchet -- --report <artifact>`、既定 dry-run） |

候補コマンドは **生成・分類のみ**。実行器へ渡さない。

## Gate latency ratchet（capability 移行 Phase 3）

同期 gate 分類の p95/max を PLAN 目標（100ms / 500ms）へ段階的に引き上げる。

| 段階 | 内容 |
|------|------|
| 計測 | `pnpm build && node scripts/measure-gate-latency.mjs` |
| 記録 | `src/corpus/gate-latency-budget.ts` の `GATE_LATENCY_MEASURED_BASELINE` を更新 |
| 閾値 | `max(実測 × 1.2, Step 1 床値)` — 床値を下げながら CI を維持 |
| advisory | `belay sandbox status` の `advisories`（exit code 非影響） |
| 検証 | `pnpm test -- src/__tests__/capability/gate-latency-p95.test.ts` |

床値を下げる前に `make verify-parallel` または `pnpm test:stable` で flake がないことを確認する。

## ローカル実行

```bash
# 敵対プローブ（FN があっても exit 0 — ローカル advisory）
pnpm probe:adversarial

# strict モード（FN > 0 で exit 1 — nightly と同じ）
pnpm probe:adversarial -- --strict

# フルセッション（corpus + structural + probe + diagnose）
./scripts/quality-loop-session.sh --full

# EVALUATE に coverage probe を含める（soft、fixture 変更 vs classifier drift は --compare）
./scripts/quality-loop-session.sh --full --with-coverage

# EVALUATE に vitest を含める
./scripts/quality-loop-session.sh --full --with-tests

# VERIFY に test:stable を含める
./scripts/quality-loop-session.sh --full --verify

# 既存 artifact から診断のみ
./scripts/quality-loop-session.sh --report artifacts/quality-loop/iteration-<batchId>.json

# 合格変異体を corpus へ dry-run（--apply で書き込み）
pnpm corpus:ratchet -- --report artifacts/quality-loop/iteration-<batchId>.json
```

Artifact: `artifacts/quality-loop/iteration-<batchId>.json`

必須フィールド（ratchet 用）: `seed`, `batchId`, `failures`, `passedCases`, `maxCases`, `holdoutRatio`, `totalCases`, `fixSetFnRate`, `holdoutFixFnRateRatio`, `firstPassFpRate`, `fpFailures`。

## 停止条件

**セッション単位**

- 初見 FN 率が 2 イテレーション連続で 0
- 同一失敗が 3 回の修正試行で解消しない
- `pnpm test:stable` でフレーク検出時は精度改善よりフレーク修正を優先

**フェーズ単位**

- Phase A 完了: mutator 分離 + nightly strict + 再現可能 artifact
- known-gap 化: 修正コストがフェーズ予算を超える場合は issue に defer

## Failure issue フォーマット

- `batchId`, `seed`, `mutator`, `source command`, `expected`, `actual`, `reason`, reproduction steps

テンプレート: [`.github/ISSUE_TEMPLATE/quality-loop-failure.md`](../.github/ISSUE_TEMPLATE/quality-loop-failure.md) · known-gap: [`.github/ISSUE_TEMPLATE/quality-loop-known-gap.md`](../.github/ISSUE_TEMPLATE/quality-loop-known-gap.md)

## Fix PR チェックリスト

- affected cases
- new corpus entries（`provenance.source: mutation`）
- simulate note（トリアージ結果。ゲートではない）
- holdout result
- risk note（FN が増えない根拠）

## accepted-benign レビュー

- 週次または隔週で `belay harvest list` をレビュー
- backlog が発散したら classifier 改善よりレビュー運用を優先

## Nightly ロールアウト

1. **Advisory**（完了）: artifact + issue、ジョブは成功
2. **Strict**（現行）: nightly schedule は `--strict`、FN > 0 でジョブ失敗
3. **PR hard-fail**（将来）: 限定 mutator 集合を PR チェックへ

## コスト上限（§7.2）

CI とローカルで共有する上限:

| 項目 | 値 | 根拠 |
|------|-----|------|
| 1 バッチ最大件数 | `--max-cases 200`（nightly 既定） | mutator 増加時の実行時間爆発を防ぐ |
| nightly ジョブ timeout | 30 分 | `.github/workflows/nightly-probe.yml` |
| artifact 保持 | 30 日 | `upload-artifact` retention |
| PR チェック mutator | 未昇格 | Step 3 まで full 集合は nightly のみ |

ローカルでは `pnpm probe:adversarial`（全件・advisory）と `--strict` を使い分ける。

## エージェント skill

Cursor: [`.cursor/skills/quality-loop/SKILL.md`](../.cursor/skills/quality-loop/SKILL.md)（playbook の実行ラッパー）

## known-gap issue

修正コストがフェーズ予算を超える場合: [`.github/ISSUE_TEMPLATE/quality-loop-known-gap.md`](../.github/ISSUE_TEMPLATE/quality-loop-known-gap.md)
