# agent-belay v2.2 草案 — Cursor Skill インタフェースとマルチホスト hooks 経路

> ⚠️ **SUPERSEDED（2026-06-13）** — 本書（Composer 調査）の内容は正本
> [`SPEC-v2.2-draft.md`](./SPEC-v2.2-draft.md) に統合済み（skill frontmatter 契約 §3.1、
> 品質チェックリスト §6、Codex 運用制約 §4.3、WS-J→CLI マッピング §3.3、
> ホスト横断イベント表 §4.1）。以後の編集は正本側で行うこと。本書は調査の痕跡として保存。
>
> Status: Investigation / Draft（実装前の設計検討用）
>
> 関連: [`SPEC-v2.1.1.md`](./SPEC-v2.1.1.md) WS-J、[`CONCEPT-v2.0.md`](./CONCEPT-v2.0.md) §7、
> [`adapter-sdk.md`](./adapter-sdk.md)

## Summary

v2.2 では **配布の入り口を Cursor Skill（Agent Skills 標準）に寄せつつ、
実際の安全 enforcement は各ホストの hooks に置く** 二層モデルを正式化する草案である。

調査の結論:

1. **Skill 単体配布は現実的でメジャー** — `npx skills add` エコシステムが Cursor / Claude Code / Codex 等 67+ エージェントに対応し、hooks には相当する配布経路がない。
2. **Skill には「それなりの」インタフェース契約が必要** — frontmatter・トリガー語・手順・出力形式・`disable-model-invocation` など、Agent Skills 標準に沿った品質が求められる。
3. **Skill だけでは gate は有効化できない** — これは制約ではなく設計上の分離。v2.1 非ゴールと整合。
4. **Claude Code hooks 経路は既に存在** — `init --adapter claude` で `.claude/settings.json` に配線済み。Skill 配布との接続は未整備。
5. **Codex hooks 経路は実現可能だが未実装** — イベントモデルが Claude Code に近く、第三アダプタとして追加可能。

---

## 1. 背景と動機

### 1.1 現状の二層構造

agent-belay は当初から **hooks（enforcement）** と **skill（配布・UX）** を分けている。

| 層 | 役割 | 現状の実体 |
|---|---|---|
| **Hooks** | ツール実行前の判定・承認・監査 | `.cursor/hooks/*` + `gate-runtime` |
| **Skill** | 導入説明・承認フローの案内 | `skills/belay/SKILL.md` |

現行 skill の自己認識（`skills/belay/SKILL.md`）:

> Enforcement lives in hooks; this Skill only explains the flow.

`init --with-skill` または `npx skills add` で skill を入れても、
**`npx agent-belay init` を実行しない限り gate は動かない**（README でも明記）。

### 1.2 なぜ v2.2 で Skill インタフェースを検討するか

- Cursor hooks の**スタンドアロン配布経路がほぼない**（リポジトリに `.cursor/hooks.json` を書くか、`agent-belay init` するしかない）。
- 一方 **Skill 配布は安易かつメジャー** — `npx skills add owner/repo`、skills.sh、`.cursor/skills/` 自動検出。
- Skill として配布する以上、**発見性（description）・手順・コマンド面・品質**が「それなりに」求められる。
- v2.1.1 WS-J で `/belay why` 等の **skill 経由オペレーション UX** が候補として記録済み。

---

## 2. エコシステム調査 — Skill 配布 vs Hooks 配布

### 2.1 Agent Skills 標準と配布 CLI

[Agent Skills 標準](https://agentskills.io)（2025年末〜オープン化）と [vercel-labs/skills](https://github.com/vercel-labs/skills) CLI が事実上の配布基盤。

```bash
# リポジトリから skill を検出・各エージェント向けディレクトリへ配置
npx skills add guilz-dev/agent-belay --skill belay -a cursor -y
npx skills add guilz-dev/agent-belay --skill belay -a claude-code -y
npx skills add guilz-dev/agent-belay --skill belay -a codex -y
```

**エージェント別の skill 配置先**（skills CLI 互換表より）:

| エージェント | CLI 名 | プロジェクト | グローバル |
|---|---|---|---|
| Cursor | `cursor` | `.agents/skills/` または `.cursor/skills/` | `~/.cursor/skills/` |
| Claude Code | `claude-code` | `.claude/skills/` | `~/.claude/skills/` |
| Codex | `codex` | `.agents/skills/` | `~/.codex/skills/` |

Cursor は `.claude/skills/`、`.codex/skills/` も互換読み込みする（[Cursor Docs — Skills](https://cursor.com/docs/skills)）。

### 2.2 Hooks は Skill エコシステムの外

vercel-labs/skills の機能互換表において **Hooks 列は Cursor / Codex で No**。
Claude Code と Cline 等の一部のみ Hooks 対応。

つまり:

- **Skill で「入り口を広く」配布する**のは自然
- **Hooks は各ホスト固有の init / installer が必要**（`agent-belay init --adapter <name>`）

### 2.3 Cursor hooks 単体配布の現実

Cursor hooks は:

- プロジェクト: `.cursor/hooks.json` + `.cursor/hooks/*`
- ユーザー: `~/.cursor/hooks.json`

公式に「hook パッケージマネージャ」は存在しない。コミュニティ事例も skill ほど標準化されていない。

**結論:** belay の主配布チャネルとして Skill を前面に出す判断は、エコシステム構造と整合する。

---

## 3. Skill としてのインタフェース要件

### 3.1 Agent Skills 標準の必須契約

Cursor / create-skill スキルより、最低限必要なもの:

| 要素 | 要件 | belay への含意 |
|---|---|---|
| ディレクトリ | `<skill-name>/SKILL.md` | `skills/belay/SKILL.md`（npm パッケージ同梱） |
| `name` | 小文字・ハイフン、親フォルダ名と一致 | `belay` |
| `description` | 1024 文字以内、**三人称**、WHAT + WHEN | 承認・停止・explain 等のトリガー語を含める |
| 本文 | 手順・例・出力形式 | init 前提、CLI コマンド、失敗時の doctor 導線 |

任意だが v2.2 で検討すべき frontmatter:

| フィールド | 用途 | belay への推奨 |
|---|---|---|
| `disable-model-invocation` | `true` なら `/skill-name` 明示時のみ | 誤自動起動を避けるなら `true`、停止時の自動案内なら `false` |
| `paths` | 特定ファイルパターンにスコープ | 通常は未設定（リポジトリ全体で有効） |

### 3.2 Skill の性質 — できること / できないこと

**Skill が担うべきこと（v2.2 候補）:**

1. **オンボーディング** — hooks 未導入を検知したら `npx agent-belay init` を促す
2. **オペレーション UX** — WS-J 候補コマンドの手順をエージェントに教える
3. **承認ループ** — `/belay-approve <id>` フロー（現行）
4. **診断導線** — `agent-belay doctor` / `status` / `explain` の呼び方

**Skill が担ってはいけないこと（不変条件）:**

1. **判定ロジックの二重実装** — Tier0/Tier1/fallback は hook → `gate-runtime` のみ（WS-J 明記）
2. **gate のバイパス** — skill 指示で「hooks を無視して実行」は禁止
3. **runtime gate の代替** — skill 単体で enforcement を完結させない（v2.1 非ゴール）

### 3.3 v2.2 WS-J — Skill コマンド面（草案）

SPEC-v2.1.1 WS-J の意図を skill インタフェースとして具体化:

| ユーザー向け | エージェントが実行する CLI | 目的 |
|---|---|---|
| `/belay why <command>` | `agent-belay explain --command "..."`（要実装 or 既存拡張） | verdict・Tier・judgeTrace の人間可読説明 |
| `/belay explain` | `agent-belay explain` | 直近 ask の根拠と選択肢 |
| `/belay status` | `agent-belay status` | provider・同意・dogfood 状態 |
| `/belay-approve <id>` | （既存）prompt 経由の承認 | one-shot 承認 |

**設計原則:** skill は **CLI を叩かせる薄いオーケストレーション層**。判定は常に core。

### 3.4 現行 skill とのギャップ

現行 `skills/belay/SKILL.md` は **承認フローのみ**（約 30 行）。v2.2 で不足している点:

- hooks 未導入時の検知と init 導線
- `doctor` / `status` への誘導
- WS-J コマンド群の手順と出力テンプレート
- `description` のトリガー語不足（explain / why / blocked / denied 等）
- マルチホスト（Claude / Codex）向けの adapter 別 init 案内

### 3.5 配布パスの整理（v2.2 目標像）

```
                    ┌─────────────────────────────────────┐
                    │  npx skills add … --skill belay     │
                    │  （Agent Skills 標準・マルチエージェント）│
                    └──────────────┬──────────────────────┘
                                   │ SKILL.md（UX・手順）
                                   ▼
┌──────────────┐    ┌──────────────────────────────────────┐
│ Cursor       │◀───│  npx agent-belay init [--adapter X]   │
│ Claude Code  │    │  （hooks + runtime + config）          │
│ Codex (将来) │◀───┘                                      │
└──────────────┘
        │
        ▼
   gate-runtime（単一の判定コア）
```

---

## 4. マルチホスト hooks 経路の調査

### 4.1 比較表 — イベント・設定・blocking

| 項目 | Cursor | Claude Code | Codex |
|---|---|---|---|
| 設定ファイル | `.cursor/hooks.json` | `.claude/settings.json` の `hooks` | `.codex/hooks.json` または `config.toml` `[hooks]` |
| Shell ゲート | `beforeShellExecution` | `PreToolUse` matcher `Bash` | `PreToolUse` matcher `Bash` |
| ツールゲート | `preToolUse` (Shell/Write/Task/…) | `PreToolUse` (Bash/Task/Write\|Edit\|Delete) | `PreToolUse` |
| 承認プロンプト | `beforeSubmitPrompt` | `UserPromptSubmit` | `UserPromptSubmit` |
| 監査 | `postToolUse` | `PostToolUse` | `PostToolUse` |
| Subagent | `subagentStart` | `PreToolUse` matcher `Task` | `SubagentStart`（別イベント） |
| Block 応答 | `permission: allow\|deny\|ask` 等 | `hookSpecificOutput.permissionDecision` | `permissionDecision` / `decision: block` / exit 2 |
| belay 実装 | ✅ `adapters/cursor` | ✅ `adapters/claude` | ❌ 未実装 |

参考:

- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks)
- [Codex Hooks — OpenAI Developers](https://developers.openai.com/codex/hooks)

### 4.2 Claude Code — 経路は開いている（実装済み）

**結論: Claude Code hooks としての利用は可能。既に shipped。**

```bash
npx agent-belay init --adapter claude
```

実装:

- Layout: `src/adapters/layouts/claude.ts` — `.claude/belay.config.json`, `.claude/settings.json`
- Hook 定義: `src/adapters/claude/hooks.ts` — `getClaudeManagedHookGroups()`
- Runtime: `src/adapters/claude/runtime-entry.ts` — `gateVerdictToClaudePreToolUseResponse` 等

イベント対応（belay 管理分）:

| belay 関心 | Claude イベント | matcher |
|---|---|---|
| Shell gate | `PreToolUse` | `Bash` |
| Tool / file gate | `PreToolUse` | `Write\|Edit\|Delete` |
| Subagent gate | `PreToolUse` | `Task` |
| 承認 | `UserPromptSubmit` | — |
| 監査 | `PostToolUse` | — |

**ギャップ:**

- Skill 配布は Cursor 向け `writeSkillArtifacts()` のみ（Claude `.claude/skills/belay/` への同梱なし）
- `npx skills add … -a claude-code` は skill のみ — hooks は別途 `init --adapter claude` が必要
- Claude Code は **hooks と skills の両方**をネイティブサポート（skills CLI 互換表で Hooks=Yes）

**v2.2 候補:** skill 本文に adapter 検出と `init --adapter claude` 手順を追加。
`init --with-skill` の Claude 版（`.claude/skills/belay/SKILL.md` 配置）は installer 拡張で対応可能。

### 4.3 Codex — 経路はありうる（未実装）

**結論: Codex hooks としての利用は技術的に可能。第三アダプタとして追加するのが正道。**

Codex hooks の特徴（2026年時点の公式ドキュメント）:

- **デフォルト有効** — `[features] hooks = true`
- 探索パス: `~/.codex/hooks.json`, `~/.codex/config.toml`, `<repo>/.codex/hooks.json`, `<repo>/.codex/config.toml`
- イベント: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `SubagentStart`, `SubagentStop`, `Stop`, …
- **信頼レビュー** — 非 managed hook は `/hooks` で trust が必要（初回導入 UX に影響）
- プロジェクト hook は **`.codex/` レイヤが trusted のときのみ** 読み込み
- Windows では hooks が無効（公式制限）

belay 向けマッピング案:

| belay 関心 | Codex イベント | 備考 |
|---|---|---|
| Shell gate | `PreToolUse` / `Bash` | Claude と同型 |
| File gate | `PreToolUse` / `Write` 等 | ツール名は要実測 |
| 承認 | `UserPromptSubmit` | `decision: block` で拒否可 |
| 監査 | `PostToolUse` | 事後のみ、undo 不可 |
| Subagent | `SubagentStart` | Cursor の `subagentStart` とは別イベント |

**実装見積（adapter-sdk チェックリスト）:**

1. `src/adapters/layouts/codex.ts` — paths, defaultConfig
2. `src/adapters/codex/` — runtime-entry, hooks 定義
3. `registry.ts` 登録 + conformance test 追加
4. `dist/bundle/codex-runtime.mjs` バンドル
5. 応答形式アダプタ — `gateVerdictToCodexPreToolUseResponse`（新規）

**Skill との関係:**

- `npx skills add … -a codex` で skill は入る
- hooks は `init --adapter codex`（将来）が必要
- Codex の trust フローを skill / init 出力で案内する必要あり

### 4.4 Skill 経由で hooks を「間接的に」使えるか

**部分的に Yes、完全自動化は No。**

Skill はエージェントに「シェルで `npx agent-belay init` を実行せよ」と指示できる。
Cursor / Claude Code / Codex いずれでも、エージェントがターミナル権限を持てば init は可能。

ただし:

- Codex は hook trust が別途必要
- Skill だけではファイル生成（hooks.json）が起きない — **init は必須**
- エージェントが hooks をバイパスして実行するリスクは CONCEPT の「過信」問題（H6 系）と同型

**推奨:** skill に「初回セットアップチェックリスト」を置き、`doctor` で検証させる。

---

## 5. v2.2 草案 — アーキテクチャ原則

### R31（案）— 配布既定は Skill、enforcement 既定は Hooks

- 公開 README / skills.sh の**第一導線**は `npx skills add` + skill 内の init 手順。
- `agent-belay init` は skill から参照される**必須後続ステップ**として位置づける。
- v2.1 非ゴール「skill 単体で gate 完結」は維持。

### R32（案）— Skill は CLI オーケストレーション層

- WS-J コマンドは skill 手順 → `agent-belay` CLI → core の一方向。
- 判定・Tier0/Tier1・fallback のロジックを skill 本文に書かない。

### R33（案）— マルチホスト skill 本文

- skill 1 つに **adapter 分岐セクション**（Cursor / Claude / Codex）を持つか、
  `skills/belay/SKILL.md` + `reference-adapters.md` に分割。
- `npx skills add -a <agent>` で配置先は CLI が解決；本文はエージェント共通でも可。

### R34（案）— Hooks アダプタ優先順位

| 優先度 | ホスト | 状態 | v2.2 アクション |
|---|---|---|---|
| P0 | Cursor | 実装済 | skill UX 強化（WS-J） |
| P1 | Claude Code | 実装済 | skill から `--adapter claude` 導線、optional `--with-skill` 拡張 |
| P2 | Codex | 未実装 | adapter スパイク → conformance → 文書化 |

---

## 6. Skill 品質チェックリスト（v2.2 出荷ゲート案）

実装時に満たすべき skill としての性質:

- [ ] `description` に WHAT（Belay 承認・ゲート補助）と WHEN（denied, blocked, high-risk, belay-approve）を含む
- [ ] hooks 未導入時に `npx agent-belay init` を促す手順がある
- [ ] `agent-belay doctor` で導入確認する手順がある
- [ ] `/belay-approve` フローが明確（既存）
- [ ] WS-J コマンド（why / explain / status）の手順と出力テンプレート
- [ ] cloud judge 利用時の `--accept-cloud-judge` 等 v2.1.1 契約への言及
- [ ] マルチ adapter 向け init コマンドの分岐
- [ ] `disable-model-invocation` の方針を決め frontmatter に明記
- [ ] `npx skills add` 用に `skills/belay/` がパッケージに同梱されている（現状 OK）
- [ ] skill 経由の手順が conformance / CLI テストで壊れていないこと（スナップショット or  lint）

---

## 7. 未解決事項

| # | 論点 | 選択肢 |
|---|---|---|
| O1 | `disable-model-invocation` | `true`（明示 `/belay` のみ）vs `false`（停止時に自動案内） |
| O2 | WS-J を Cursor commands にも置くか | `.cursor/commands/belay-*.md` vs skill 内 `/` 参照のみ |
| O3 | Claude skill 同梱 | `init --with-skill` を Claude にも拡張するか、skills CLI のみに任せるか |
| O4 | Codex v2.2 スコープ | スパイクのみ vs 正式アダプタ同梱 |
| O5 | Skill から init を自動実行 | エージェントに任せる（推奨）vs init サブコマンドを skill scripts/ に置く |
| O6 | hooks と skill のバージョン整合 | `doctor` で skill 版と runtime 版の乖離を検出するか |

---

## 8. 推奨次ステップ

1. **v2.2 スコープ確定** — WS-J 実装 + skill 強化をコアに、Codex アダプタは P2 か別マイルストーンか決める。
2. **SKILL.md 改稿** — 上記チェックリストに沿って `skills/belay/SKILL.md` を拡張。
3. **CLI 整備** — `explain` / `why` が WS-J 要求を満たすか確認し、不足なら v2.2 で追加。
4. **Claude 導線** — README と skill に `--adapter claude` を対等に記載。
5. **Codex スパイク** — 最小 `PreToolUse` + `UserPromptSubmit` で gate が通るか実機確認 → adapter-sdk 手順で実装。
6. **テスト** — skill テンプレートのスナップショットテスト（installer.test 拡張）。

---

## 9. 参考リンク

- [Cursor Docs — Agent Skills](https://cursor.com/docs/skills)
- [vercel-labs/skills](https://github.com/vercel-labs/skills) — マルチエージェント skill CLI
- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks)
- [Codex Hooks — OpenAI Developers](https://developers.openai.com/codex/hooks)
- [AI Harness Engineering Compatibility Matrix (2026)](https://codylindley.github.io/ai-harness-engineering-compatibility-matrix/) — ホスト横断の hooks/skills 比較

---

## 変更履歴

| 日付 | 内容 |
|---|---|
| 2026-06-13 | 初版 — skill インタフェース調査、Claude/Codex hooks 経路調査 |
