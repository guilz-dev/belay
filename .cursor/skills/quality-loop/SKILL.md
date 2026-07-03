---
name: quality-loop
description: >-
  Runs the belay quality loop (adversarial probe, corpus gates, session diagnose,
  ratchet). Use when the user says quality-loop, /quality-loop, probe:adversarial,
  corpus:ratchet, or wants FN/FP regression checks before a classifier change.
---

# Quality Loop

自律的テスト・改修ループの **検知フェーズ** を回す。正本は [`docs/quality-loop-playbook.ja.md`](../../docs/quality-loop-playbook.ja.md)。

## いつ使うか

- ユーザーが **quality-loop** / **probe** / **corpus ratchet** と言ったとき
- classifier / tokenizer / containment を変更したあと、must-ask FN が増えていないか確認するとき
- nightly probe 失敗の再現・診断を依頼されたとき

## 不変条件（要約）

- must-ask 見逃し（FN）は最優先で 0 に戻す
- `provably-benign` / `accepted-benign` は自動追加しない
- `belay simulate` はトリアージ専用 — merge 判定は `pnpm corpus` のハードゲート

## 手順

### 1. フルセッション（推奨）

```bash
./scripts/quality-loop-session.sh --full
```

EVALUATE を厚くする場合:

```bash
./scripts/quality-loop-session.sh --full --with-tests
```

修正後の VERIFY:

```bash
./scripts/quality-loop-session.sh --full --verify
```

### 2. 敵対プローブ単体

```bash
# ローカル advisory（FN あっても exit 0）
pnpm probe:adversarial

# nightly 同等（FN > 0 で exit 1）
pnpm probe:adversarial -- --strict --max-cases 200 --seed 42
```

### 3. 診断（artifact から）

```bash
./scripts/quality-loop-session.sh --report artifacts/quality-loop/iteration-<batchId>.json
```

FN 各行に `belay explain --command "..."` を案内する。

### 4. ratchet（合格変異体 → corpus、既定 dry-run）

```bash
pnpm corpus:ratchet -- --report artifacts/quality-loop/iteration-<batchId>.json
# 書き込みは --apply を明示
pnpm corpus:ratchet -- --report artifacts/quality-loop/iteration-<batchId>.json --apply
```

### 5. 統合レポート

```bash
belay quality --json
```

corpus ハードゲート + provenance 内訳 + harvest 残高。

## 評価コンテキスト

| 経路 | cwd | policy |
|------|-----|--------|
| `pnpm test:structural` | repo root fixtures | deny（厳格） |
| `pnpm corpus` / probe | `/workspace/project/src` | DEFAULT_CONFIG_V3 |

両方緑でもコンテキスト差で見かけの矛盾が起き得る。playbook の表を参照。

## 停止条件

- 同一 FN が 3 回の修正で解消しない → known-gap issue を検討
- `pnpm test:stable` でフレーク → 精度改善よりフレーク修正を優先

## 関連

- 設計: [`docs/autonomous-quality-loop.ja.md`](../../docs/autonomous-quality-loop.ja.md)
- failure issue: [`.github/ISSUE_TEMPLATE/quality-loop-failure.md`](../../.github/ISSUE_TEMPLATE/quality-loop-failure.md)
- known-gap: [`.github/ISSUE_TEMPLATE/quality-loop-known-gap.md`](../../.github/ISSUE_TEMPLATE/quality-loop-known-gap.md)
