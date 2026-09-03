# 直近の不具合頻発 — 原因分析と再発防止策

- **作成日:** 2026-09-04
- **最終更新:** 2026-09-04（事実整合・根拠トレース・実行可能性の改稿）
- **対象期間:** 2026-07-15 00:00 〜 2026-09-03 23:59:59 UTC（v0.8.0 〜 v0.9.3 + Unreleased）
- **データソース:** `git log`、PR #82〜#97（`gh pr view`）、CHANGELOG、ADR-007/008、`docs/investigations/2026-09-02-dogfood-block-after-upgrade.md`、`docs/security-review-2026-08-30.md`
- **目的:** 直近で不具合が頻発した実態を git 履歴から確認し、クラスタごとに根本原因を特定して、再発防止策を提示する。

---

## 0. 集計方法（再現用）

**観測日時:** 2026-09-04

**コミット種別の集計:**

```bash
git log --since='2026-07-15' --until='2026-09-03 23:59:59' --pretty='%s' \
  | awk -F: '{print tolower($1)}' | sed -E 's/\(.+\)//' \
  | awk '{count[$1]++} END {for (k in count) print k, count[k]}' | sort
```

**ルール:** Conventional Commits の先頭トークン（`type(scope)` の `type`）を小文字化。`Fix` / `fix` は同一種別。

**リリースタグ確認:**

```bash
git tag --list 'v0.8.*' 'v0.9.*' | sort -V
```

**PR 一次情報:**

```bash
for n in $(seq 82 97); do gh pr view $n --json number,title,state,mergedAt; done
```

---

## 1. サマリ

対象期間の **211 コミット** 中、内訳は次のとおり。**修正コミットが全体の約 32%（68 件）** を占め、`feat`(29) を大きく上回っている。同期間にパッチリリースが **6 本**（v0.8.0/0.8.1/0.9.0/0.9.1/0.9.2/0.9.3）出ており、**ホットフィックス駆動のリリースサイクル**になっていた。

| 種別 | 件数 |
|------|------|
| fix | 68 |
| merge | 42 |
| feat | 29 |
| test | 20 |
| release | 18 |
| docs | 17 |
| chore | 6 |
| refactor | 5 |
| harden | 2 |
| style | 1 |
| other（add / clarify / complete） | 3 |
| **合計** | **211** |

不具合は独立して散発したのではなく、**5 つのクラスタに集中**していた。特に問題なのは、**同じ挙動が「直しては壊れる」形で複数回再発**していた点である（下記クラスタ B・C・D）。

| クラスタ | 概要 | 深刻度 | 再発回数 | 主要 PR |
|---------|------|--------|----------|---------|
| **A. Cursor フック所有権/スコープ解決** | global/project の多重フック・cwd 誤解決 | 高 | 継続的（ADR-007/008 を新設するに至った） | #87, #89, #93 |
| **B. 並行 PR のマージ回帰** | コンフリクト解消で他 PR の変更が消える | 高 | 2 回（#87→#88 消失、#96 でセキュリティ回帰復旧） | #87, #88, #91, #92, #96 |
| **C. Dogfood シェルブロック** | audit のはずが止まる（二重ゲート等） | 高 | 3 回（調査→#95→#97） | #95, #97 |
| **D. セキュリティ実装欠陥/回帰** | glob・fingerprint・scrub の穴 | 高 | #96 で一括修正 | #96 |
| **E. シェル分類器の網羅漏れ** | ラッパー/インタプリタ/Make の分類漏れ | 中 | 8/26 前後で多数 | #82, #85 |

---

## 2. クラスタ別の分析

### クラスタ A — Cursor フックの所有権・スコープ解決

**症状:** `installScope: global` 時にフックプロセスの cwd が `$HOME` に解決され、リポジトリ固有 config を無視して enforce 既定で動く。同一イベントに global と複数 project のフックが多重発火し、承認状態を食い合い、監査レコードが重複する。Windows のランナーパス破損、`CURSOR_CONFIG_DIR` が stale な場合の警告失敗も同系統。

**根拠（PR 一次情報）:**

| PR | タイトル | マージ日 | クラスタとの対応 |
|----|---------|---------|-----------------|
| #87 | fix: resolve global hook workspace context from payload | 2026-08-31 | payload-first cwd 解決の導入 |
| #89 | Harden global Cursor hooks against workspace mis-resolution | 2026-08-31 | ADR-007 系の恒久化 |
| #93 | fix: prevent duplicate Cursor hooks in multi-root workspaces | 2026-09-01 | ADR-008 dispatcher / 1 イベント 1 オーナー |

**代表コミット:** `6418d53`, `4aaf068`, `ac26598`〜`44a4929`（dispatcher/ownership 系一式）, `5100c09`, `89009cf`, `0928e9d`, `c7f07d3`, `662a86a`

**根本原因:**
1. **フックプロセスの cwd がアクション対象リポジトリを表さない**（`$HOME/.cursor` から起動）。`process.cwd()` 由来の repoRoot 解決が $HOME に落ちる。
2. **ホスト(Cursor)が同一イベントに複数のフックソースを発火させうる**（User/global + 複数 Project）。所有権境界がないと全ソースがポリシーを評価する。
3. **インストール位置が config ソース選択に結びついていた**。

**恒久対策として既に入ったもの:** ADR-007（payload-first cwd 解決 + global フックの fail-closed）、ADR-008（1 イベント 1 オーナーの dispatcher 先行ルーティング、Project 優先、canonical repo 同定）。→ これらは正しい方向。**未達は §5 の予防策で補強する。**

### クラスタ B — 並行 PR のマージ回帰（最重要）

**症状:** マージのコンフリクト解消時に、**別 PR で入れたはずの変更が無言で消える**。

**根拠（PR 一次情報）:**

| PR | タイトル | マージ日 | クラスタとの対応 |
|----|---------|---------|-----------------|
| #87 | fix: resolve global hook workspace context from payload | 2026-08-31 | コンフリクト解消で #88 の変更をサイレント削除 |
| #88 | fix: harden Cursor host-denial correlation and health signals | 2026-08-31 | `tool_use_id` 正規化・監査 join・health snapshot 警告（#87 マージで消失） |
| #91 | fix: restore PR #88 host-denial correlation lost in #87 merge | 2026-08-31 | #88 復元（1 回目） |
| #92 | fix: keep Cursor approval warning fallback when CURSOR_CONFIG_DIR is stale | 2026-09-01 | #88 復元（2 回目、`213d8af`） |
| #96 | fix: restore sensitive-path glob matching and approval fingerprint uniqueness | 2026-09-02 | セキュリティ修正の restore（別系統の回帰） |

- **実例 1:** PR #87 のコンフリクト解消が PR #88 の `tool_use_id` 正規化・監査 join・health snapshot 警告を**サイレントに削除**。#91 → #92 の 2 回に分けて復元する羽目に。
- **実例 2:** #96 で「sensitive-path glob マッチ」「approval fingerprint の一意性」を **restore**（＝どこかで壊れていた挙動の復旧）。

**根本原因:**
1. **ホットファイルへの並行編集**。`runtime-entry.ts` / `audit-*.ts` / `health-snapshot.ts` / `gate-runtime.ts` / `shell-lower.ts` に複数 PR が同時に触れ、コンフリクト解消で取りこぼす。
2. **消失を検知するテストが無かった**（挙動をロックする invariant テストが後付け）。
3. **コンフリクトを含むマージ後の結合検証が無かった**。

**既に入ったもの:** `.github/pull_request_template.md` に「Parallel merge hazard」節（重複 PR の列挙 + 結合 vitest 実行）、invariant テスト（`cursor-host-denial-invariants.test.ts` 他）。→ **テンプレートは自己申告で強制力が弱い。§5 で CI 強制に格上げする。**

### クラスタ C — Dogfood シェルブロック（3 回再発）

**症状:** `mode: audit`（dogfood）のはずなのに、エージェントのシェルコマンドがブロックされる。

**根拠（PR 一次情報）:**

| PR | タイトル | マージ日 | クラスタとの対応 |
|----|---------|---------|-----------------|
| #95 | Fix freelance dogfood shell blocks (single gate + argv delegate) | 2026-09-02 | 単一ゲート化 + argv-delegate lowering |
| #97 | Fix dogfood shell blocks and linked-worktree diagnostics | 2026-09-03 | doctor に linked-worktree config skew と host-denied-after-allow 数を表示 |

**根本原因（調査 `2026-09-02` で確定）:**
1. **二重シェルゲート**（`preToolUse: Shell` + `beforeShellExecution`）。**0.9.1 で `preToolUse: Shell` を削除したのに 0.9.2 で復活し、Unreleased で再度削除**という「直しては戻る」回帰。
2. **ホストによるコマンド書き換え**（RTK: `git status`→`rtk git status`）で、ゲート A とゲート B が別コマンドを評価。
3. **未知ランチャ頭**（`rtk` 等）→ `process.grammar_unknown` → `unknown_local_effect`。中身が既知サブコマンドでも分類できない。
4. **モノレポの兄弟 worktree が config 未設定 → デフォルト enforce**。メインは audit でも、cwd 解決先の worktree が enforce で deny していた。
5. **upgrade 直後の runtime 混在**（複数 `runtimeArtifactHash`）。

**既に入ったもの:** #95（単一ゲート化 + argv-delegate lowering）、#97（doctor に linked-worktree の config skew と host-denied-after-allow 数を表示）。→ 方向は正しい。**enforce 既定と config 伝播の運用穴が残る（§5）。**

### クラスタ D — セキュリティ実装欠陥/回帰

**症状:** 手動セキュリティレビュー（`docs/security-review-2026-08-30.md`）で High 4 / Medium 6 を検出。#96 で以下を修正:
- glob `**` がネスト/ルートのパスに正しくマッチしない（sensitive-path 判定の穴）。
- shell substitution の POSIX single-quote 判定漏れ。
- **fingerprint をスクラブ後の入力でハッシュ → 別 MCP payload が同一承認を共有**（承認再利用の穴）。

**根拠:** PR #96（`gh pr view 96`）、`docs/security-review-2026-08-30.md`

**その他レビュー指摘（設計限界含む、未クローズあり）:** repo config が最終レイヤで信頼される（H-1）、`notifications.commandHook` からの任意コード実行（H-2）、承認トークンの webhook 送出が egress proxy を迂回（H-3）、Cursor が未知ツールを無条件 allow（H-4）。

**根本原因:** 権限に影響する設定/分類ロジックに対する**敵対的入力の corpus・回帰テストが不足**。fail-closed 原則がレイヤ間で一貫していない（Cursor だけ未知ツール allow）。

### クラスタ E — シェル分類器の網羅漏れ

**症状:** ラッパー/インタプリタ/Make/docker-compose/rspec dry-run 等が想定外に分類され、CI や dogfood をブロック。

**根拠:** PR #82（structured shell argv boundaries）、PR #85（Make prerequisites）

**代表コミット:** `8a2626b`〜`c123f78`（structured argv 一式）、`999fd5c`/`fd917fd`（Make 前提レシピ）、`ccd6017`（rspec dry-run の contained-execution 復旧）、`caed3df`（Agent Shell ゲート復旧 + grammar 拡張）。

**根本原因:** 実運用のコマンド形状が corpus に無く、**本番で初めて分類漏れが露見**。monotonicity（ASK→ALLOW への弱化）を守る仕組みは後付け。

---

## 3. 横断的な根本原因

個別クラスタの奥にある共通因子は 4 つ。

| # | 横断因子 | 現れたクラスタ |
|---|----------|----------------|
| **R1. 挙動が「直しては戻る」** | 削除した `preToolUse: Shell` の復活、消えた PR#88、restore された glob/fingerprint | B, C, D |
| **R2. ホットファイルへの並行編集でサイレント消失** | runtime-entry / audit-* / health-snapshot / gate-runtime / shell-lower | B |
| **R3. 安全でない既定 + 環境スキュー** | config 無し＝enforce、兄弟 worktree 未伝播、global/project スキュー、upgrade 後の runtime 混在 | A, C |
| **R4. ホスト挙動・敵対入力の想定不足** | ホストによる書き換え、cwd=$HOME、多重フック、glob/fingerprint/scrub の穴 | A, C, D, E |

---

## 4. シングルシェルゲート論点（ADR 境界の明示）

本調査で繰り返し出る「シングルゲート」論点は、**現行仕様・提案・ADR 更新要否**を分けて読む必要がある。

| 区分 | 内容 |
|------|------|
| **現行仕様** | `src/defaults.ts` の managed フックは `beforeShellExecution` のみ。`preToolUse: Shell` は managed 集合に含まれない。upgrade は legacy `preToolUse: Shell` を strip する（#95 / CHANGELOG Unreleased）。 |
| **現行仕様（ADR-008）** | ADR-008 Limits 節は「`beforeShellExecution` と `preToolUse: Shell` は別 canonical event として扱い、collapse しない」と明記。これは **hook source precedence**（1 オーナー選定）の話であり、シェル分類の二重評価とは別軸。 |
| **提案** | シェル分類は `beforeShellExecution` の 1 ゲートのみで行い、managed `preToolUse: Shell` を二度と復活させない（tombstone テスト + CI で固定）。 |
| **ADR 更新要否** | **要。** 専用 ADR（例: ADR-009 single shell gate）を新設し、「シェル分類の単一評価点」と「hook source precedence」の関係を明文化する。ADR-008 Limits の `preToolUse: Shell` 記述も、managed から除去済みである旨に更新が必要。 |

**前提変更:** ADR-009 新設 + ADR-008 Limits の用語整理。コード変更は #95 で実施済みだが、設計ドキュメントが追いついていない。

---

## 5. 再発防止策

「既に入っているもの（維持・強化）」と「新規に入れるべきもの」を分け、横断因子 R1〜R4 に紐づける。優先度は P0（即時）/ P1（次スプリント）/ P2（計画的）。

各項目は `status / owner / evidence / done-when` で記述する。

### 5.1 R1（直しては戻る）への対策

| 優先度 | 対策 | status | owner | evidence | done-when |
|--------|------|--------|-------|----------|-----------|
| P0 | 回帰ロック（tombstone）テストの義務化 | **部分実施** | eng | `cursor-hooks.test.ts`, `installer.test.ts`（#95） | fresh install / upgrade 後に `preToolUse: Shell` が存在しないことを assert するテストが CI 必須 |
| P0 | PR#88 由来 invariant テスト維持 | **実施済み** | eng | `cursor-host-denial-invariants.test.ts`（#91） | テスト削除で CI が落ちる |
| P0 | glob/fingerprint 回帰テスト維持 | **実施済み** | eng | `glob.test.ts`, `classify-tool.test.ts`（#96） | テスト削除で CI が落ちる |
| P1 | managed フック snapshot テスト | **未着手** | eng | `src/defaults.ts` | snapshot テストが CI 必須で、意図しない managed フック復活を検出 |
| P1 | restore/regress PR 追跡 | **未着手** | eng | PR テンプレ | restore/regress/lost を含む PR に原因 PR + 再発防止テスト記載が必須 |

### 5.2 R2（並行マージのサイレント消失）への対策

| 優先度 | 対策 | status | owner | evidence | done-when |
|--------|------|--------|-------|----------|-----------|
| P0 | ホットファイル結合 vitest の CI 必須化 | **未着手** | eng | `.github/pull_request_template.md`（自己申告のみ） | ホットファイル変更 PR で結合 vitest が必須ジョブとして走る |
| P0 | コンフリクト解消後の両 PR 変更残存確認 | **未着手** | eng | #87/#88 事例 | PR テンプレ + CI でコンフリクト解消 PR を検出し、チェック必須 |
| P1 | ホットファイル集中期の直列マージ | **未着手** | eng | #87/#88 事例 | 運用ルール文書化 + マージキュー縮小の実践 |

**対象ホットファイル:** `src/adapters/cursor/runtime-entry.ts`, `src/core/audit-*.ts`, `src/commands/health-snapshot.ts`, `src/adapters/shared/gate-runtime.ts`, `src/core/effect-ir/shell-lower.ts`, `src/defaults.ts`

### 5.3 R3（安全でない既定 + 環境スキュー）への対策

| 優先度 | 対策 | status | owner | evidence | done-when |
|--------|------|--------|-------|----------|-----------|
| P0 | dogfood 環境スキューの doctor 可視化 | **部分実施** | eng | `doctor.ts` linked-worktree 警告（#97） | worktree skew / runtime 混在が **警告ではなく exit code 非ゼロ** で検出 |
| P1 | モノレポ dogfood config 伝播 CLI | **未着手** | eng | `2026-09-02` 調査 §7.3 | `belay dogfood --recursive` または doctor fix 提案が利用可能 |
| P1 | upgrade の runtime 単一化保証 | **未着手** | eng | `2026-09-02` 調査 §5.3 | upgrade 後に旧 runtime が残らず、混在時は doctor が再 upgrade を促す |
| P2 | 既定モードの再検討 | **要設計合意** | eng | enforce 既定 | enforce deny 時に「未 dogfood」メッセージを表示 |

### 5.4 R4（ホスト挙動・敵対入力の想定不足）への対策

| 優先度 | 対策 | status | owner | evidence | done-when |
|--------|------|--------|-------|----------|-----------|
| P0 | シングルシェルゲート原則の明文化 | **部分実施** | eng | CHANGELOG Unreleased, §4 本節 | ADR-009 採択 + ADR-008 Limits 更新 |
| P1 | 敵対入力 corpus 拡充 + monotonicity | **部分実施** | eng | `corpus/shell-commands.json`, `pnpm test:corpus` | corpus が CI 必須で ASK→ALLOW 弱化が 0 |
| P1 | fail-closed 一貫性監査 | **未着手** | eng | H-4（未知ツール allow） | 全アダプタで fail-closed 原則が invariant テストで固定 |
| P2 | repo config 信頼境界（H-1〜H-3） | **要設計合意** | eng | `security-review-2026-08-30.md` | 権限影響キーの repo レイヤ制限が ADR 化 |

### 5.5 プロセス面（クラスタ横断）

| 優先度 | 対策 | status | owner | evidence | done-when |
|--------|------|--------|-------|----------|-----------|
| P0 | fix PR に再発防止テストを DoD 化 | **未着手** | eng | superpowers TDD 方針 | fix ラベル PR にテスト差分が無ければ CI が落ちる |
| P1 | リリース前 dogfood リプレイ | **未着手** | eng | `2026-09-01` 計画 Task 4 | リリース候補で `Belay blocked` が 0 |
| P1 | ポストモーテムの定着 | **実施済み** | eng | 本ドキュメント + `docs/investigations/` | High 深刻度ごとに 1 ページ調査が残る運用 |
| P2 | 変更集中期のリリース間隔調整 | **要設計合意** | eng | 6 リリース/6-8 週 | ホットファイル集中期の結合検証強化ルールが文書化 |

---

## 6. 優先実施チェックリスト

§5 の status に対応。即効性と再発防止効果が高い順。

| # | 項目 | 因子 | status |
|---|------|------|--------|
| 1 | `preToolUse: Shell` 不在 & managed フック tombstone テスト | R1/C | 部分実施 |
| 2 | ホットファイル触診時の結合 vitest を CI 必須ジョブ化 | R2/B | 未着手 |
| 3 | コンフリクト解消時の「両 PR の変更残存」確認を必須化 | R2/B | 未着手 |
| 4 | dogfood 環境スキューを doctor でブロッキング表示 | R3/A/C | 部分実施 |
| 5 | シングルシェルゲート原則を ADR 化（§4 参照） | R4/C | 部分実施 |
| 6 | fix PR に再発防止テスト差分が無ければ CI で落とす | 横断 | 未着手 |
| 7 | monorepo dogfood config 伝播 CLI / doctor fix 提案 | R3/C | 未着手 |
| 8 | 敵対入力 corpus 拡充 + monotonicity を必須 CI に | R4/E | 部分実施 |
| 9 | fail-closed 一貫性監査（全アダプタ） | R4/D | 未着手 |
| 10 | リリース前 dogfood リプレイゲート | 横断/C | 未着手 |
| 11 | repo config 信頼境界の強化（H-1〜H-3） | R4/D | 要設計合意 |

---

## 7. 監視すべき指標

§6 チェックリストと 1 対 1 で対応。再発防止が効いているかを継続的に測る。

| 指標 | 対応チェックリスト # | 目標 | 取得元 |
|------|---------------------|------|--------|
| fix コミット比率 | —（横断 KPI） | 低下傾向（現状 ~32%） | `git log`（§0 集計方法） |
| `restore`/`regress`/`lost` を含む PR 数 | 3, 6 | 0 に近づける | PR タイトル |
| `hostDeniedAfterAllowCount` | 4, 10 | 0 | `belay doctor` / `summarizeAuditVisibility` |
| audit モードでの実ブロック（`Belay blocked`） | 4, 10 | 0 | 監査ログ / リリースリプレイ |
| `preToolUse: Shell` managed エントリの存在 | 1, 5 | 0 | `belay doctor` / installer テスト |
| corpus の ASK→ALLOW 弱化 | 8 | CI で常に 0 | `pnpm test:corpus` |
| doctor が検出する worktree config skew / runtime 混在 | 4, 7 | 0（解消まで可視化） | `belay doctor` |

---

## 8. 関連ドキュメント

- 調査: `docs/investigations/2026-09-02-dogfood-block-after-upgrade.md`
- 計画: `docs/superpowers/plans/2026-09-01-freelance-dogfood-block-fix.md`
- セキュリティレビュー: `docs/security-review-2026-08-30.md`
- ADR-007（global hook workspace 解決）、ADR-008（Cursor hook source precedence）
- PR テンプレ: `.github/pull_request_template.md`（Parallel merge hazard 節）
- 主要 PR: #82〜#97（特に #87/#88/#91/#92 のマージ回帰、#95/#97 の dogfood、#96 のセキュリティ）

---

## 9. 変更履歴

| 日付 | 内容 |
|------|------|
| 2026-09-04 | 初版 — git 履歴横断でクラスタ分類、横断因子 R1〜R4 と再発防止策を策定 |
| 2026-09-04 | 改稿 — 集計方法の明記（211 コミット）、PR 根拠トレース、§4 ADR 境界明示、§5 status/owner/evidence/done-when 形式、チェックリストと指標の対応整理 |
