# Belay ドキュメント（日本語）

[README（英語・クイックスタート）](../README.md) · [CONTRIBUTING](../CONTRIBUTING.md) · [SECURITY](../SECURITY.md)

Belay はコーディングエージェント向けの **restorability floor（復元可能性の床）** です。
YOLO で動かしつつ、**取り消せない × 破滅的** な操作だけを人の承認に回します。

このディレクトリは設計・契約・運用の参照用です。インストール手順と CLI の使い方は
[README](../README.md) を先に読んでください。

---

## まず読むもの

| 文書 | 内容 |
| --- | --- |
| [CONCEPT.md](./CONCEPT.md) | プロダクトの中心概念（正本・英語） |
| [CONCEPT.ja.md](./CONCEPT.ja.md) | 上記の日本語訳 |
| [adr/ADR-002-concept-conformance.ja.md](./adr/ADR-002-concept-conformance.ja.md) | すべてのルールがコンセプトに奉仕する運用規律（貢献時必読） |
| [guarantee-table.md](./guarantee-table.md) | 設定ごとの保証表（L1〜L4、機械可読ソースは `src/conformance/`） |

---

## 設計・アーキテクチャ

| 文書 | 内容 |
| --- | --- |
| [adr/ADR-001-layered-enforcement.ja.md](./adr/ADR-001-layered-enforcement.ja.md) | 予測ベース分類から階層型エンフォースメント（L1〜L4）への移行 |
| [adr/ADR-001-layered-enforcement.md](./adr/ADR-001-layered-enforcement.md) | ADR-001（英語） |
| [adr/ADR-002-concept-conformance.md](./adr/ADR-002-concept-conformance.md) | ADR-002（英語） |
| [adapter-sdk.md](./adapter-sdk.md) | アダプタ SDK・新規ホスト追加のチェックリスト |

---

## 設定・契約

| 文書 | 内容 |
| --- | --- |
| [config-schema.md](./config-schema.md) | `belay.config.json`（v3）のスキーマ |
| [packaging-smoke.md](./packaging-smoke.md) | npm パッケージ出荷前のスモーク手順 |

---

## 運用（ops）

| 文書 | 内容 |
| --- | --- |
| [ops/releasing.md](./ops/releasing.md) | リリース手順（npm / GitHub Release） |
| [ops/semver-policy.md](./ops/semver-policy.md) | セマンティックバージョニング方針 |

---

## ロードマップ・履歴

| 文書 | 内容 |
| --- | --- |
| [ROADMAP.md](./ROADMAP.md) | ミッション・精度/網羅の2軸・ホライズン（戦略ロードマップ） |
| [CHANGELOG.md](../CHANGELOG.md) | リリースノート |

---

## 用語の整理

| 用語 | 意味 |
| --- | --- |
| **restorability floor** | 「戻せるか」だけで止める薄い安全網。fence（柵）ではない |
| **Tier0** | 決定論的判定（FN=0 を CI で担保） |
| **Tier1** | ローカル LLM など、曖昧時の fail-closed 判定 |
| **L3** | コマンドヒューリスティック＋ポリシー（単体では境界にならない） |
| **L1-full** | サンドボックス + egress + 署名付き control plane（敵対的同 OS ユーザー向け） |

---

## 貢献する場合

1. [CONTRIBUTING.md](../CONTRIBUTING.md) の「一つのルール」を読む
2. ゲート変更は [ADR-002](./adr/ADR-002-concept-conformance.ja.md) に沿って **MUST-ALLOW** と **MUST-ASK** の両方をテストに足す
3. 公開挙動の変更は [guarantee-table.md](./guarantee-table.md) と [README](../README.md) を同期する

コンセプトの正本は英語の [CONCEPT.md](./CONCEPT.md)（日本語は [CONCEPT.ja.md](./CONCEPT.ja.md)）。ADR の `.ja.md` は日本語が正本です。
