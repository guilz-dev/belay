# Dogfood 段階 enforce runbook（per-target）

ADR-012 / traffic readiness Phase 3 向け。**repo ごと**に `readyForEnforce === true` を満たしてから enforce する。

## 移行条件

```bash
node dist/cli.js quality --target <absolute-repo-path> --json
# → readyForEnforce === true（当該 repo の active cohort）
```

- 他 repo（guilz-trace 含む）の合格は移行根拠に**ならない**
- `--force` は **corpus pass + availability asks = 0 必須**。traffic 150 未達・shell 最低件数未達のみ override 可

## Limited enforce trial

| 項目 | 内容 |
|------|------|
| 対象 | 1 repo ずつ（第一候補: scheduling-editor） |
| 開始 | 当該 repo の `readyForEnforce === true`、または Phase 2 で承認済み `--force` |
| 期間 | 1 週間（調整時は ADR 追記） |
| 監視 | host denied after allow、kind 別 benign block rate、availability asks、WB 率 |
| 中止 | benign block rate ≥ 2%、availability ask、corpus regression |
| **復旧** | `belay dogfood --target <repo>` で audit に戻す |
| **非復旧** | `dogfood --check` — enforce 中は `dogfood_inactive` を報告するだけ |

## エスカレーション（Phase 2 policy review）

週次 rollup 後、`scripts/dogfood/traffic-readiness-escalation.mjs` で E1–E4 を確認。該当時は 1 週間以内に policy go/no-go を記録（ADR 追記または ops メモ）。

| ID | 条件 |
|----|------|
| E1 | `gateEvents ≥ 500` かつ `reviewedBenignEvents = 0` |
| E2 | upgrade 後 14 日以上、`gateEvents ≥ 200` かつ `reviewedBenignEvents < 10` |
| E3 | harvest candidates > 0 だが batch 適用 0 が 2 回連続（手動記録） |
| E4 | tool `benignBlockRate ≥ 2%` または shell 最低件数未達が 4 週間改善しない |

## Tier B

Phase 3 完了を待たず audit 継続可。enforce は当該 repo が独自に `readyForEnforce` を満たしたときのみ。
