# ADR-005 — コマンド allowlist 禁止

Status: Accepted（拘束力あり）  
Date: 2026-08-18  
関連: [ADR-002](./ADR-002-concept-conformance.ja.md), [ADR-004](./ADR-004-effectplan-shell-authority.md)

## Context（背景）

belay の差別化要因は **restorability floor（復元可能性の床）** である。
「取り消せない × 破滅的」だけを止め、見慣れないコマンド名ごと止めない。

コマンド allowlist — legacy `overrides.allow` / `overrides.external` を含む —
は belay を静的 denylist / permission fence と同型に戻す。安全そうなコマンドの
誤 ask が出たとき「リストに足せばよい」という提案が繰り返されてきたが、
**その方向に製品が依存した時点で belay は終了すべき** である。

ADR-004 は EffectPlan を shell authority に固定し legacy list を inert 化したが、
運用ガイドとエージェント提案がそれを守っていなかった。

## Decision（決定）

1. **コマンド allowlist はプロダクト不適合**
   - shell 認可にコマンド名リスト・segment head リスト・fingerprint リスト・
     corpus catalog・config override list を runtime authority として使わない。
   - `overrides.allow` / `overrides.external` は parse 互換のみ。**使用禁止**。
     運用上の回避策として案内しない。

2. **許容される代替（allowlist ではない）**
   - **EffectPlan 改善** — grammar decoder / policy で read-only を構造的に認識
   - **exact one-shot 承認** — 拒否された操作を完全一致で一度だけ許可
   - **resource-scoped grant** — egress domain / fs-scope / trusted workspace root
     等。**リソース** の承認であり shell 構文の恒久許可ではない

3. **強制**
   - `belay doctor` は `overrides.allow` / `overrides.external` 非空で **fail**
   - docs / skills が allowlist 推奨を含むと CI fail
   - list 型 shell authority を導入する PR はレビューで reject

## Consequences（結果）

- legacy override list は削除必須。doctor が fail する。
- unknown local effect の偽陽性は EffectPlan / policy 改善か one-shot 承認で対処。
- egress / fs-scope / judge provider 等の **resource boundary** allowlist は対象外。
- CONTRIBUTING / CONCEPT / README / skills は allowlist 回避を案内してはならない。

## 一行

**「リストに足す」が答えなら、その答えは間違い。**
