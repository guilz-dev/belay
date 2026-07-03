# 自律的テスト・改修ループ設計 — 精度向上のための反復プロセス

Status: **Implemented**（検知ループ Phase A–D）— 運用手順は [`quality-loop-playbook.ja.md`](./quality-loop-playbook.ja.md) を正本とする。
関連: [`corpus/README.md`](../corpus/README.md) · [`quality-loop-playbook.ja.md`](./quality-loop-playbook.ja.md) · [`ADR-002 概念適合`](./adr/ADR-002-concept-conformance.ja.md) · [`ROADMAP.md`](./ROADMAP.md) · [`recursive-quality-loop.md`](./recursive-quality-loop.md)

> **一文要約:** Belay には評価・収穫・回帰検知の部品がすでに揃っている。
> 欠けているのは「失敗ケースを自動生成し、修正し、二度と戻らないように固定する」
> 反復の駆動部であり、本書はその設計を定義する。

---

## 1. 現状分析 — すでにあるもの / 足りないもの

### 1.1 既存の品質インフラ（実測済み）

| 部品 | 実体 | 役割 | 実測 |
|---|---|---|---|
| コーパス評価 | `pnpm corpus` → `src/corpus/evaluate.ts` | ラベル付きコーパスの精度・ハードゲート判定 | 27ケース / 精度100% / 約30秒（ビルド込み） |
| ハードゲート | `corpus/baseline.json` + `src/corpus/gates.ts` | must-ask 見逃し=0、provably-benign 誤停止=0 を CI で強制 | 両方 0 で通過 |
| 構造スイート | `src/__tests__/verdict/structural-suite.test.ts` | 破滅的コアに対するラッパー / 退行プローブ群 | `pnpm test:structural` でCIハードゲート |
| フルテスト | `vitest run` | 全機能回帰 | 94ファイル / 804テスト / 約16秒 |
| フレーク検知 | `pnpm test:stable`（vitest 3連走） | 非決定的テストの検出 | CI で常時実行 |
| 収穫 | `belay harvest list/apply` (`src/commands/harvest.ts`) | 監査ログから良性候補を抽出しコーパスへ昇格 | 人手レビュー前提 |
| 影響シミュレーション | `belay simulate` (`src/commands/simulate.ts`) | 候補設定を監査ログにリプレイし allow↔deny の変化を差分表示 | **トリアージ専用** |
| 統合レポート | `belay quality --json` (`src/commands/quality.ts`) | コーパスゲート+監査メトリクス+収穫残の一括JSON | 機械可読 |
| 敵対プローブ | `pnpm probe:adversarial` → `scripts/adversarial-probe.mjs` | must-ask 変異の初見 FN 監視 | `src/corpus/adversarial-probe.ts` |
| コーパス ratchet | `pnpm corpus:ratchet -- --report <artifact>` | 合格変異体の dry-run / 手動追加 | `src/corpus/ratchet.ts` |
| セッション診断 | `./scripts/quality-loop-session.sh` | evaluate + diagnose（`--with-tests` / `--verify` / `--report`） | 運用スクリプト |
| エージェント skill | `.cursor/skills/quality-loop/SKILL.md` | playbook 実行ラッパー | 運用 |
| Nightly probe | `.github/workflows/nightly-probe.yml` | strict ハードフェイル + issue | CI |
| LLMジャッジ精度 | `corpus/judge-accuracy.json` + `src/__tests__/verdict/llm/judge-accuracy.test.ts` | Tier1 固定ベンチ（20ケース） | Ollama 必須（無ければ skip） |

**結論:** 評価パイプラインは高速で、自律ループの土台としては十分に軽い。律速は実行速度ではなく、失敗ケース供給と安全なラベリング規律である。

### 1.2 ギャップ — 精度が「向上しない」理由

1. **コーパスが小さすぎて失敗が発生しにくい。** 27ケースで100%という数字は飽和しており、改善の駆動力が弱い。
2. **敵対的ケースの生成が固定的。** 現在の構造スイートは強いが、生成器としては未分解で、どの変換が「自動ラベル可能」かが明文化されていない。
3. **ループの駆動部が無い。** `harvest → corpus → build` の各ステップは手動連結で、生成→評価→修正→固定の反復がない。
4. **Tier1 ジャッジの精度計測** — 固定 fixture 20 ケース（`corpus/judge-accuracy.json`）。Ollama 必須で無ければ skip。
5. **既存の `docs/recursive-quality-loop.md` は FP 改善に主眼があり、自律的な adversarial loop の設計はまだ別文書として整理されていない。**

---

## 2. 設計原則 — 自律ループが守るべき不変条件

Belay 自身の哲学（ROADMAP「2つのダイヤル」）をループにも適用する。**損失は非対称**であり、自動化はこの非対称性を壊してはならない。

### P1. 見逃し(FN)ゼロは交渉不可、誤停止(FP)は漸減目標

- must-ask の見逃しが1件でも出たら、そのイテレーションの最優先修正対象とする。
- FP 修正で Tier0 / Tier1 を緩める場合は、ADR-002 M3 に従い「なぜ FN にならないか」の説明と must-ask 側の対抗ケースを同一変更で追加する。

### P2. ラベルの出所規律 — 自動付与できるラベルとできないラベル

`provably-benign` は standing-allow カタログへ波及し、実行時の無音許可に繋がる。したがって:

| ラベル | 自動追加 | 根拠 |
|---|---|---|
| `must-ask` | **限定的に可** | 厳しめに倒す方向であり、過剰でも「聞くだけ」で済む |
| `accepted-benign` | **不可** | 現在でも `harvest apply` による人手レビュー前提。ソフトゲートでも ground truth を自動注入しない |
| `provably-benign` | **不可** | 無音許可の付与であり、ランタイム権限の拡大になる |

自動ラベル許可の対象は、「意味保存性を個別に説明できる must-ask 変異」に限る。`approve` はシグナルであって ground truth ではない、という既存 harvest 規律をそのまま守る。

### P3. メタモルフィック不変条件 — 自動ラベル可能なのは「意味保存が証明できた変異」だけ

自動ラベルの根拠に使う不変条件は次である:

> 任意の must-ask コア `c` と、意味保存性を個別に検証済みの変換 `w` について、
> `strictness(verdict(w(c))) ≥ strictness(verdict(c))` が成り立つべきである。

重要なのは、**この `w` を現在の `WRAPPER_TRANSFORMS` 全体と同一視しない**ことだ。現行の構造スイートには、

- 透過ラッパーとして扱える変換
- fail-closed を確認するための退行プローブ
- 実行意味が元コマンドと一致しない文字列変形

が同居している。後二者まで生成器に流すと、「実行バイパス」ではない文字列に `must-ask` を自動付与して corpus を汚染する。したがって実装では以下を分離する:

- `AUTO_LABEL_MUTATORS`: must-ask 自動ラベルに使ってよい、意味保存をレビュー済みの変換群
- `STRUCTURAL_PROBES`: fail-closed / parser 回帰を見るためのテスト専用プローブ群

#### P3.1 `AUTO_LABEL_MUTATORS` 採用チェックリスト

各 mutator は追加時に最低限つぎのメタデータを持つ:

| 項目 | 内容 |
|---|---|
| `purpose` | 何のバイパス形状を表すか |
| `preservesSemantics` | 元コマンドと同じ効果を保つ根拠 |
| `forbiddenWhen` | どの条件では意味保存とみなさないか |
| `tests` | どの structural / corpus テストで検証するか |

この表を埋められない変換は `AUTO_LABEL_MUTATORS` ではなく `STRUCTURAL_PROBES` 側に置く。

### P4. ラチェット — ゲートは緩まない、コーパスは縮まない

- `corpus/baseline.json` のハードゲートは維持する。
- コーパスのケース削除・ラベル降格は人手レビューのみ。ループは追加専用。
- イテレーション精度は「新規生成バッチに対する初見精度」で測る。既存コーパスでの100%維持は前提条件にすぎない。

### P5. 過学習対策 — 生成バッチの二分割

生成した敵対的ケースは **fix セット** と **holdout セット** に分割する。holdout が fix より有意に悪ければ、個別ケースへのパッチワークとみなす。

---

## 3. ループ設計 — 1イテレーションの構造

```text
GENERATE -> LABEL -> EVALUATE -> DIAGNOSE -> FIX -> VERIFY -> RATCHET
```

### ① GENERATE — 失敗ケースの供給源

1. **決定的変異エンジン（最優先・LLM不要）**
   `src/__tests__/verdict/structural-suite.test.ts` から変異資産を抽出するが、共有化するのは 1 つの配列ではなく役割分離されたモジュールにする。
   - `AUTO_LABEL_MUTATORS`: `bash -c`、`env`、絶対パス化など、意味保存性を個別に説明できるもの
   - `STRUCTURAL_PROBES`: `command_substitution` や fail-closed を検証するが、自動ラベル根拠には使わないもの
   拡張軸はエンコード / パス / フラグ / 多段ネスト / 引用の5軸だが、各追加変換は「意味保存」「fail-closed」「単なる構文攪乱」のどれかに必ず分類してから採用する。
2. **監査ログ収穫（実運用データ）**
   `belay harvest list` で FP 候補を吸い上げる。ただし候補提示までで、自動昇格はしない。
3. **LLM 赤チーム生成（補助）**
   must-ask コアの別表現生成に使うが、自動ラベル対象は `AUTO_LABEL_MUTATORS` と同様に意味保存性を説明できるものだけに限る。

#### ①-補足 安全要件 — 候補は生成・分類するだけで実行しない

このループが扱うのは **コマンド文字列の生成と分類** であり、候補コマンドの実行ではない。adversarial probe / red-team 生成 / harvest 由来候補は、すべて classifier・corpus・simulate の入力にのみ使い、実行器へ渡さない。

### ② LABEL — 仕分け表

| 生成元 | 生成物 | 自動ラベル | 行き先 |
|---|---|---|---|
| must-ask コア × `AUTO_LABEL_MUTATORS` | 意味保存変異 | `must-ask` | fix / holdout |
| must-ask コア × `STRUCTURAL_PROBES` | fail-closed プローブ | なし | テスト専用、corpus 自動追加なし |
| 良性コマンドの変異 | FP プローブ | なし | 人手レビューキュー |
| harvest 候補 | 実運用の良性候補 | なし | `belay harvest apply` で人手昇格 |
| LLM 赤チーム | 敵対的候補 | 条件付き | 意味保存が確認できたものだけ fix / holdout |

### ③ EVALUATE

- `pnpm corpus`
- `pnpm test:structural`
- `vitest run`
- 修正後に `pnpm test:stable`

### ④ DIAGNOSE

- corpus mismatch（expected / actual / reason）
- `belay explain`
- 必要に応じて監査ログ差分

### ⑤ FIX

- tokenizer / parser
- wrapper peeling / substitution handling
- containment
- Tier0 / Tier1 ルール
- judge prompt / provider choice

### ⑥ VERIFY

- holdout で再評価
- `pnpm test:stable`
- `belay simulate` は **回帰トリアージ専用** として使う

ここでの `simulate` は安全性ゲートではない。現行の `reclassify` は audit の `summary` や補助 replay context から action を再構成しており、欠損時は `repoRoot` や補完 tool 名へフォールバックする。したがって verify の意味は:

- どの既存トラフィックが変わりそうかを列挙する
- 変化した候補を corpus / 監査レビューへ送る
- `simulate` 単体では merge 可否を決めない

将来的に replay fidelity を上げるなら、audit に **classifier が実際に見た正規化済み action snapshot** を保存してから使う。

**実装済み（Phase C）:** `actionSnapshot` を gate audit に保存し、`reclassify` / `simulate` が snapshot を優先する。

### ⑦ RATCHET

- 合格した must-ask 変異体のみをコーパスへ追加
- `artifacts/quality-loop/iteration-NNN.json` に生成数 / 初見FN率 / holdout 精度 / 修正ファイルを保存
- CI を最終審判とする

#### ⑦-補足 データ契約と再現性

追加するデータは先に schema を固定する。最低限必要なのは次である:

| データ | 必須フィールド |
|---|---|
| `iteration-NNN.json` | `iteration`, `generatedAt`, `seed`, `batchId`, `sourceCommands`, `selectedMutators`, `fixSetSize`, `holdoutSetSize`, `fixSetFnRate`, `firstPassFnRate`, `firstPassFpRate`, `holdoutFnRate`, `holdoutFixFnRateRatio`, `passedCases`, `fpFailures`, `filesChanged` |
| corpus `provenance` | `source`, `sourceBatchId`, `sourceCaseId`, `reviewedBy?`, `reviewedAt?` |
| audit action snapshot | `kind`, `cwd`, `normalizedAction`, `toolName?`, `payloadHash?`, `schemaVersion` |

再現に必要な `seed`, `batchId`, `sourceCommands`, `selectedMutators` は artifact に必ず残す。再生成不能な failure は修正対象として弱い。

---

## 4. 実行形態 — どう「自律」させるか

### 案A（将来拡張）: セッション内の自動修正ループ

外部エージェントにループ手順を持たせ、①〜⑦ を反復させる案である。最短で回せるが、これは
repo 内の評価・収穫 primitive とは別に、以下の**運用基盤**を要する:

- 実行主体（Claude Code / Codex / 他エージェント）のスキルまたはプレイブック
- セッション起動・停止・再試行の制御
- 変更レビューと PR 作成の責任分界
- 失敗時の停止条件とエスカレーション先

したがって、これは「コードを少し足せばすぐ動く」種類のステップではない。**detect-only の品質ループとは別フェーズ**として扱う。

### 案B（現実的な第一段）: CI nightly

夜間に **生成と評価だけ** を回し、失敗を issue 化して人間またはエージェントへ渡す。修正自体は自動化しないためリードタイムは長いが、既存コードベースに最も自然に接続できる。

### 案C（MVP）: 決定的スクリプトのみ

`scripts/adversarial-probe.mjs` が `AUTO_LABEL_MUTATORS` のみで must-ask 変異を生成し、初見 FN を監視する。ここでは **意味保存が証明できた変異しか使わない**。既存の `pnpm corpus` / `belay quality` / `harvest` と最も素直に接続でき、まず実装すべき土台はこれである。

### 実行形態の整理

本書でいう「自律ループ」は、実装上は次の 2 層に分かれる:

1. **検知ループ（repo 内で完結）**
   変異生成、corpus 評価、quality レポート、nightly probe。既存資産の延長で作れる。
2. **自動修正ループ（repo 外の運用も必要）**
   エージェントが修正を提案し、PR を作り、人間がレビューする。コードだけでなく実行基盤と運用設計が必要。

前者は短期で実装可能だが、後者は別フェーズとして扱うべきである。

---

## 5. 実装ロードマップ

| 順 | 成果物 | 内容 | 規模 | 性質 |
|---|---|---|---|
| 1 | `src/corpus/mutators.ts` | 構造スイート由来の変換を `AUTO_LABEL_MUTATORS` と `STRUCTURAL_PROBES` に分離し、各変換に用途コメントを付ける | 小 | repo 内実装 |
| 2 | `scripts/adversarial-probe.mjs` | must-ask コア × `AUTO_LABEL_MUTATORS` で初見FN率を計測し、`artifacts/quality-loop/` にレポート出力 | 小 | repo 内実装 |
| 3 | loop playbook / skill | ①〜⑦の手順、不変条件、停止条件、`simulate` の非ゲート性を明記した外部エージェント向け手順書。`.claude/...` は一例にすぎず、これ単体では自動ループは完成しない | 小 | **運用文書** |
| 4 | corpus スキーマの `provenance` フィールド | ケース出所（`manual` / `mutation` / `harvest` / `redteam`）を保持。loader、fixture、場合によっては生成スクリプト群への波及を伴う | 中 | repo 内実装 |
| 5 | judge ベンチ拡張 | `TIER1_ACCURACY_CORPUS` は「tier1 到達ケースの自動導出」ではなく、固定ラベル付き fixture として拡張・チェックインする。必要なら corpus から初期候補を抽出するが、ベンチ集合自体は安定化させる | 中 | repo 内実装 |
| 6 | replay fidelity 強化 | audit に正規化済み action snapshot を残し、`simulate` の忠実度を上げる。audit schema・replay・後方互換まで含めて扱う | 中 | repo 内実装 |
| 7 | nightly workflow | 案C を `.github/workflows/nightly-probe.yml` として追加 | 小 | repo 内実装 |
| 8 | 自動修正ランナー | セッション起動、失敗時停止、PR 化、レビュー導線までを含む運用基盤 | 大 | **repo 外運用** |

**MVP は 1, 2, 7** である。これで「検知ループ」は回り始める。  
**4, 5, 6** は検知ループの精度と再現性を高める中期投資である。  
**3, 8** は自動修正ループに属し、repo 内コードだけでは完結しない。

### 5.1 ロールアウト方針

CI への導入は一気に fail-closed にしない:

1. **Advisory**
   nightly で probe を実行し、artifact と issue だけ出す。
2. **Nightly hard-fail**
   初見FN率 > 0 のとき nightly を fail させる。
3. **PR hard-fail**
   変異軸と実行時間が安定してから、限定バッチを PR チェックに昇格する。

この順で入れることで、CI 時間の膨張や誤検知のままの強制ブロックを避ける。

### 停止条件（1セッションあたり）

- 初見FN率が 2 イテレーション連続で 0
- 同一失敗が 3 回の修正試行で解消しない
- `test:stable` でフレーク検出時は精度改善より先にフレーク修正

### 5.2 グローバル停止条件

セッション単位とは別に、フェーズ全体の停止条件も持つ:

- **Phase A 完了条件:** mutator 分離、nightly strict、再現可能 artifact の 3 点が揃う
- **Phase B 進行条件:** harvest backlog が運用可能な件数に収まり、judge fixture の追加規則が定義済み
- **known-gap 化条件:** 同一 failure が複数回再現し、修正コストが直近フェーズ予算を超える

---

## 6. 計測 — イテレーションを跨いで追う指標

| 指標 | 定義 | 目標方向 |
|---|---|---|
| 初見FN率 | 新規 must-ask 変異バッチのうち ask にならなかった率 | → 0 |
| 初見FP率 | 新規良性プローブのうち誤停止した率 | 漸減 |
| holdout/fix 精度比 | 過学習検知 | ≒ 1.0 |
| コーパス規模 | ケース数と provenance 内訳 | 単調増加 |
| accepted-benign 残高 | レビュー待ち件数 | 発散させない |
| Tier1 ジャッジ正答率 | 固定 fixture に対する judge-accuracy | 退行検知 |
| フレーク件数 | `test:stable` での不一致 | 0 維持 |

### 6.1 judge fixture 追加規則

固定 fixture は自動導出ではなく、次の系統から人手で追加する:

- 高頻度 FP を表すケース
- Tier1 にしか落ちない曖昧ケース
- 直近で実際に発生した regression

各 fixture には `whyThisExists` を残し、「なぜ外すと危ないか」を説明可能にする。

---

## 7. 実現性

| フェーズ | 内容 | 実現性 | 主な制約 |
|---|---|---|---|
| Phase A | mutator 分離 + adversarial probe + nightly workflow | 高 | 既存 test / corpus / CI に素直に乗る |
| Phase B | `provenance` 追加 + judge 固定ベンチ拡張 | 中高 | schema と fixture の更新範囲が広い |
| Phase C | replay fidelity 強化 | 中 | audit schema と互換性管理が要る |
| Phase D | エージェントによる自動修正・PR 化 | 中 | 実行基盤、権限、停止条件、レビュー運用が必要 |

したがって、短期に狙うべきは **Phase A の detect-only ループ** であり、Phase D はその上に乗る別プロジェクトである。

### 7.1 人手レビュー運用

`accepted-benign` と harvest backlog は放置すると詰まる。運用として少なくとも以下を決める:

- レビュー担当者
- 週次または隔週のレビュー cadence
- `accepted-benign -> provably-benign` の昇格条件
- backlog が閾値を超えたときの整理基準

目安としては `accepted-benign` 残高や availability queue が発散し始めた時点で、classifier 改善よりレビュー運用の見直しを優先する。

### 7.2 コスト上限

nightly / PR で回すループには上限を置く:

- 1 バッチあたりの最大生成件数
- 1 ジョブあたりの最大実行時間
- artifact の保持期間
- PR チェックに昇格させるときの限定 mutator 集合

変異軸が増えても CI を壊さないよう、コスト上限は設計の一部として先に決める。

---

## 8. リスクと対策

| リスク | 対策 |
|---|---|
| 意味保存でない変換まで `must-ask` 自動ラベルして corpus を汚す | `AUTO_LABEL_MUTATORS` と `STRUCTURAL_PROBES` を分離し、前者だけを corpus 生成に使う |
| `simulate` を安全性ゲートと誤認する | 文書・スキル・CLI 出力で「トリアージ専用」を徹底し、最終判定は corpus hard gate に寄せる |
| judge ベンチが実装変更で勝手に易化する | judge 評価集合は固定 fixture として管理し、自動導出は初期候補抽出に留める |
| ループが FP 修正のために規則を緩め、FN を作る | must-ask ハードゲート + 構造スイートを毎修正後に実行 |
| 自動ラベルの誤りがランタイム無音許可に波及する | `provably-benign` と `accepted-benign` は自動追加しない |
| loop playbook だけを作って「自律化できた」と誤認する | 文書上で「repo 内実装」と「repo 外運用基盤」を分離し、後者を別フェーズとして見積もる |

### 8.1 issue / PR 連携フォーマット

nightly から人間やエージェントへ渡す単位も先に固定する:

- **failure issue**: `batchId`, `seed`, `mutator`, `source command`, `expected`, `actual`, `reason`, `reproduction steps`
- **known-gap issue**: 上記に加えて `why deferred`, `risk`, `next review date`
- **fix PR**: `affected cases`, `new corpus entries`, `simulate note`, `holdout result`, `risk note`

自動修正フェーズに進む前でも、この受け渡しフォーマットを先に決めておくと運用がぶれにくい。
