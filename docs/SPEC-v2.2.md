# agent-belay SPEC v2.2 — skill 配布フロントドアと他エージェント横展開

Status: **Canonical（実装可能）** — 規範。ただし一部ワークストリームは下記「スコープとゲート」の
ゲート通過を着手条件とする（探索段階は終了）。
Builds on: SPEC-v2.1 / SPEC-v2.1.1（WS-J の意図を本書で展開）。関連: CONCEPT-v2.0 §7 / adapter-sdk.md
Consolidates: `SPEC-v2.2-draft-skill-interface-superseded.md`（Composer 調査）を本書に統合。
skill frontmatter 契約・品質チェックリスト・Codex 運用制約・
WS-J→CLI マッピング・ホスト横断イベント表を取り込み済み。

本書が規定する2軸:
1. belay を **skill 配布フロントドア**にする際の skill インタフェース/性質（§2, R-S*）。
2. **Claude Code / Codex の hooks** への横展開と配布 packaging（§3, R-X*）。

---

## スコープとゲート（正本の前提）

本書は規範だが、ワークストリームごとに成熟度が異なる。**着手条件（ゲート）**を明示する。

| WS | 内容 | 状態 | 着手ゲート |
| --- | --- | --- | --- |
| **WS-Codex** | Codex アダプタ（per-repo hooks） | **実装済み・GO**（R-X1 で TUI 実証） | なし。残るは belay 実適配器の TUI smoke で experimental を外すのみ（G-B2） |
| **WS-Skill** | skill フロントドア（R-S1〜S4） | 規範化済み・**未実装** | **G-A**（O1/O5 の決定）＋ **G-B1**（Cursor commands/skills UX 実機検証） |
| **WS-Pkg** | 配布 packaging（plugin/hook-package/skill） | 要件化（R-X4） | WS-Codex/WS-Skill 安定後 |

**ゲート定義:**
- **G-A（決定・人間）**: ✅ **クローズ**。O1=`true`（明示のみ）確定 / O5=R-S5 scope 軸で解決 /
  v2.2 スコープ＝WS-Skill 全部入れ（R-S1〜S5）で確定。残る着手ゲートは **G-B（検証）のみ**。
- **G-B1（検証待ち・Cursor 実機）**: skill の明示呼び出し UX（commands vs skills）。R-S3 の
  実装はこれの通過を条件とする（§2.1）。
- **G-B2（検証待ち・Codex 実機）**: belay 実適配器を `.codex/config.toml` に入れ、`dropdb`/
  `docker push` 相当が belay 自身でブロックされることを TUI で確認 → experimental 解除（R-X3）。

> 規範だが「全部今すぐ実装可能」ではない。**WS-Codex は即実装可能**（実際に実装済み）、
> **WS-Skill は G-A/G-B1 通過後に実装可能**、という段階を本書が確定させる。

## 0. 結論サマリ（先に要点）

- **skill と hook は役割が違う。混ぜると安全契約が壊れる。**
  - skill = 配布チャネル + 対話 UX（モデルが「読む」助言。クロスエージェント標準）。
  - hook = 強制力（runtime が「割り込んで止める」基盤。floor を成立させる唯一の層）。
  - **skill 単体は floor になれない**。skill だけ入れた状態は「助言モード」であって、
    belay の中核主張（取り消せない×破滅的だけを非バイパスで止める床）ではない。
- したがって v2.2 の skill 化は「**skill を front door（配布と UX）、hook を floor（強制）**」
  と明確に二層化し、skill は hook の導入/健全性を**ブートストラップ・検証**する役にする。
- 横展開の調査結果（2026-06 時点）:
  - **Claude Code**: 既に実装済み（`src/adapters/claude`、PreToolUse/UserPromptSubmit/
    PostToolUse）。新規ではなく既存。
  - **Cursor**: 既に実装済み（`src/adapters/cursor`、hooks + 薄い SKILL）。
  - **Codex CLI**: **GO（2026-06-13 対話 TUI で実証）**。`codex exec` ヘッドレスでは未発火
    だったが、**対話 TUI で正しく trust された PreToolUse deny は shell コマンドを実際に
    ブロックした**。さらに実ペイロードで `tool_name:"Bash"` / `tool_input:{command}` が
    判明し、**Claude と同一**＝ belay の shell 経路はそのまま機能する（後述 R-X1）。

---

## 1. なぜ skill 形態か（動機）

- Cursor では **生 hooks 単体の配布はほぼ流通しておらず**、skill 配布（marketplace /
  `npx skills add` / GitHub `filename:SKILL.md`）が主流かつ導入が容易。
- SKILL.md は**クロスエージェント標準**で、Claude Code / Cursor / Codex CLI 間で
  そのまま再利用できる（配布面での移植性が高い）。
- 一方で belay は「非バイパスの床」を売りにする。skill の本質は**助言**（モデルが従う/
  従わないを選べる）であり、強制ではない。この緊張を設計で正面から扱う必要がある。

### 1.1 安全境界（最重要・非交渉）

- **skill-only インストール = 助言モード（advisory）**。runtime gate（hook）が未導入なら、
  belay は「止める」ことができない。これを floor と誤認させてはならない。
- skill は起動時に **hook の導入状態を検出**し、未導入なら明示的に警告し、導入導線
  （`npx agent-belay init`）を提示する（現行 SKILL.md の注意書きを契約に格上げ）。
- 「skill だけで安全になった」と利用者が誤解しうる表現を SKILL.md / marketplace 説明から
  排除する。配布の容易さのために安全主張を薄めない。

---

## 2. skill インタフェース設計（front door）— WS-Skill

belay-as-skill が満たす規範。**実装着手は G-A（O1/O5 決定）＋ R-S3 のみ G-B1 通過が条件**。

### R-S1 — skill は「導入と説明」、enforcement は hook に委譲する（MUST）
- SKILL.md の `description` は「高リスク操作が belay に止められたときの承認フロー、および
  belay の導入/状態確認」を担うことを明記する。
- 判定ロジック（Tier0/Tier1/fallback）を skill 本文・skill 経路に**実装してはならない**。
  判定は常に hook → shared gate-runtime の単一コアで行う。
- **受け入れ基準**: T20（skill 経由に判定ロジックが無い／同一コアを呼ぶことの確認）。

### R-S2 — bootstrap：skill は init ウィザードを起動し、hook の健全性を検出・案内する（MUST）
- skill は hook 未導入・整合性破れ・judge 未設定（cloud key 不在等）を検出し、人間可読に報告
  して **`agent-belay init`（対話ウィザード）/ `agent-belay doctor`** へ誘導しなければならない。
- **対話ウィザードは CLI 側に実装する**（ロジックは belay コード）。skill はそれを呼ぶ薄い
  front door に徹し、判定・配置の実体を skill 本文に持たない。ウィザードは scope（R-S5）と
  adapter を対話で確定し、`init --adapter X --scope Y` を実行する。
- skill は install/doctor を**暗黙実行してはならない**（明示実行のみ）。
- **「永続インストールせずに試したい」**は ephemeral な hook トグルではなく、**project scope +
  audit モード**（`init --adapter X --dogfood`）で受ける（消すのも容易、止めず観測）。
- **受け入れ基準**: T21（hook 未導入リポジトリで skill 手順が advisory 警告 + init 導線を返す）。

### R-S3 — 対話インタフェース（SHOULD・**実装は G-B1 通過後**）
skill は**判定をしない**。`/belay …` を受けて `agent-belay` CLI を叩かせる薄い
オーケストレーション層に徹する（判定は常に core）。

| ユーザー向け | エージェントが実行する CLI | 目的 | CLI 現状 |
| --- | --- | --- | --- |
| `/belay why <command>` | `agent-belay explain --command "..."` | verdict（location/opacity/effect/permission、reason、Tier0/Tier1、judgeTrace）の人間可読説明 | `explain` は既存（`src/cli.ts:509`）。`--command` 形は**本 WS で追加**（T22） |
| `/belay explain` | `agent-belay explain` | 直近 `ask` の根拠と承認/却下の選択肢 | 既存 |
| `/belay status` | `agent-belay status` | provider（ollama / openai-compatible）・cloud 同意・model 解決・hook 導入・dogfood | 既存 |
| `/belay approve <id>` | （既存）prompt 経由の承認 | one-shot 承認。現行 `/belay-approve` を整理統合 | 既存 |

- **不変条件（MUST）**: hook 経路と同じ判定コアを呼ぶだけで、新しい緩和/停止を導入しない。
- **ゲート**: 明示起動（slash）か description 自動発火かの設計は G-B1（§2.1）の実機検証で確定。
- **受け入れ基準**: T22（`explain --command` が verdict 要素を出力）。

### R-S4 — skill の「性質」要件（Agent Skills 標準への準拠・MUST）

| 要素 | 要件 | belay への含意 |
| --- | --- | --- |
| ディレクトリ | `<skill-name>/SKILL.md` | `skills/belay/SKILL.md`（npm パッケージ同梱） |
| `name` | 小文字・ハイフン、親フォルダ名と一致 | `belay` |
| `description` | 1024 字以内・**三人称**・WHAT + WHEN | 承認/停止/explain 等のトリガー語（denied, blocked, high-risk, belay-approve）を含める |
| 本文 | 手順・例・出力形式 | init 前提、CLI コマンド、失敗時の `doctor` 導線 |

frontmatter 方針（O1 確定）:

| フィールド | 用途 | 決定 |
| --- | --- | --- |
| `disable-model-invocation` | `true` で `/belay` 明示時のみ起動 | **`true`（明示のみ）に確定**。理由: belay は「見えない床」（98% 黙過）で自動注入は不可視性に反する／即時の承認案内は hook の deny メッセージが既に担う／自動起動挙動（G-B1）に依存せず頑健。G-B1 で自動起動が綺麗と分かれば `false`+タイト description に再評価可 |
| `paths` | 特定ファイルパターンにスコープ | 未設定（リポジトリ全体で有効）とする |

- **自動起動を切るため（MUST）**: hook の deny メッセージは「詳しくは `/belay`（why/explain）」へ
  の導線を含めること（`true` でも richer help にたどり着けるようにする）。

性質上の不変条件（MUST）:
- 単一責務・自己完結・description で発火条件が明確（クロスエージェントで誤発火しない）。
- 破壊的副作用を skill 自身が持たない（install/doctor は明示実行）。
- バンドル物（承認コマンド等）は skill ディレクトリに自己完結させる。
- **受け入れ基準**: T23（SKILL.md スナップショット + description トリガー語の存在）。

### R-S5 — install scope（project / global / managed・MUST）

導入先を **scope 1 軸**で決める。scope は **skill 配置と hook 配置の両方**を、provider ごとに
解決する（O5 を scope に統合）。**blast radius が広がるほど明示オプトインを要求する。**

| scope | Cursor | Claude | Codex | blast radius |
| --- | --- | --- | --- | --- |
| **project**（既定） | `.cursor/` | `.claude/` | `.codex/`（+ `/hooks` trust） | リポジトリ |
| **global**（明示） | `~/.cursor/` | `~/.claude/` | `~/.codex/`（+ `/hooks` trust） | そのユーザの全セッション |
| **managed**（明示・sudo・Codex のみ） | — | — | `/etc/codex/managed_config.toml`（**pre-trusted**） | マシン全体 |

- **既定は `project`**（per-repo）。`global` / `managed` は `--scope` / `--managed` の明示指定のみ。
  ユーザが選ばない限り project より広く影響させてはならない（安全原則）。
- scope は hybrid（§ R-S1 周辺）の **A（init が skill を置く）も hook 配置も同一に支配**する。
  `init --with-skill --scope global` なら skill も `~/.cursor/skills/` 等へ。
- **Codex trust は scope に従う**: `project`/`global` は手動 `/hooks` trust + experimental ガード
  （R-X3）、`managed` は pre-trusted（trust 不要、`allow_managed_hooks_only` で非バイパス床）。
- **実装含意**: 現 layout は repoRoot 相対（= project 固定）。`global`/`managed` のため layout を
  **scope 対応のパス解決**（repoRoot / homedir / `/etc`）にリファクタする（layout 集約済みで波及は局所）。
- **受け入れ基準**: T29（`--scope project|global` が provider 別の正しい場所へ skill+hook を書く／
  既定が project／`managed` は Codex のみ・sudo 要件を明示）。

### 2.1 G-B1 — Cursor commands/skills UX 検証（R-S3 実装の前提ゲート）
Cursor における skill の**明示呼び出し UX**（slash 的な明示起動か、description 一致による
自動発火か、その併用か）を実機で確認する。現行 belay は `.cursor/commands/belay-approve.md`
を併用しているため、commands と skills の役割分担を確定してから R-S3 を実装する。
**これは Codex の TUI smoke（R-X1）と同種の「実装前に確かめる」ゲートである。**

---

## 3. 他エージェント横展開（調査結果）

### 3.1 現状とホスト横断イベント表（実コードで裏取り）

belay の関心ごとに、各ホストの hook イベントを対応づけた表。Cursor / Claude Code / Codex 列は
belay の実コードと一致を確認済み（Codex の shell は R-X1 の TUI 実測で `tool_name:"Bash"` 確定）。

| belay 関心 | Cursor | Claude Code | Codex | block 応答 |
| --- | --- | --- | --- | --- |
| Shell gate | `beforeShellExecution` | `PreToolUse` / `Bash` | `PreToolUse` / `Bash`（実測確定） | Cursor: `permission: allow\|deny\|ask` / Claude・Codex: `permissionDecision: "deny"` or exit 2 |
| Tool・File gate | `preToolUse` | `PreToolUse` / `Write\|Edit\|Delete` | `PreToolUse`（`.*`→統合ハンドラ。apply_patch 等は要実測） | 同上 |
| 承認プロンプト | `beforeSubmitPrompt` | `UserPromptSubmit` | `UserPromptSubmit`（`decision: block`） | block / exit 2 |
| 監査 | `postToolUse` | `PostToolUse` | `PostToolUse`（事後・undo 不可） | — |
| Subagent | `subagentStart` | `PreToolUse` / `Task` | `SubagentStart`（専用イベント・登録済み） | — |
| belay 実装 | ✅ `adapters/cursor` | ✅ `adapters/claude` | ✅ `adapters/codex`（experimental, R-X3） | — |

→ 「Claude Code hooks として使う」は将来構想ではなく**既に存在する**
（`init --adapter claude` で `.claude/settings.json` に配線済み）。v2.2 では
これを skill front door と接続し、配布動線を揃えることが課題。

**Claude skill 同梱ギャップ**: 現状 `writeSkillArtifacts()` は Cursor 向け
（`.cursor/skills/belay/`）のみで、Claude の `.claude/skills/belay/` には skill を
配置していない。`npx skills add … -a claude-code` は skill だけ入り、hook は別途
`init --adapter claude` が要る。v2.2 で `--with-skill` の Claude 版（installer 拡張）を
検討する。

### 3.2 Codex CLI（新規・実現可能性が高い）

調査（2026-06, developers.openai.com/codex/hooks）で判明した事実:

- Codex は **hooks** を持つ。lifecycle イベント: `SessionStart` / **`PreToolUse`** /
  **`PermissionRequest`** / **`PostToolUse`** / **`UserPromptSubmit`** / `SubagentStart` /
  `SubagentStop` / `Stop`。
- **ブロック可能**:
  - `PreToolUse` → `hookSpecificOutput.permissionDecision: "deny"`、または exit code 2。
  - `PermissionRequest` → `decision.behavior: "deny"`、または exit code 2。
  - `UserPromptSubmit` → `decision: "block"` / exit 2。
  - `PostToolUse` は実行を取り消せない（結果差し替えのみ）。
- 設定は `hooks.json` または `config.toml` の inline `[[hooks.PreToolUse]]`。スキーマは
  `{ "hooks": { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command",
  "command": "...", "timeout": 30 }] }] } }`。
- hook は stdin で JSON 入力、stdout で decision 出力。

**運用上の制約（オンボーディング UX に影響）**:
- hooks は既定で有効（`[features] hooks = true`）。探索パスは `~/.codex/hooks.json` /
  `~/.codex/config.toml` / `<repo>/.codex/hooks.json` / `<repo>/.codex/config.toml`。
- **trust レビュー**: 非 managed な hook は `/hooks` で trust が必要。プロジェクト hook は
  `.codex/` レイヤが trusted のときのみ読み込まれる → belay の init / skill 出力で
  trust 導線を案内する必要がある。
- **Windows では hooks が無効**（公式制限）。Cursor/Claude の Windows runner と同列には
  扱えない。対応表/doctor で明示する。

**含意**: このスキーマと deny 契約は belay の **Claude Code アダプタとほぼ同形**
（`src/adapters/claude/hooks.ts` の PreToolUse/UserPromptSubmit/PostToolUse、prepend
配置、command runner）。したがって **Codex アダプタは新規実装ではなく移植**に近い:

- 既存の **shared gate-runtime をそのまま再利用**（判定コアは不変）。
- 追加するのは (a) layout（Codex の設定ファイル位置: `config.toml` inline / `hooks.json`）、
  (b) matcher の tool 名マッピング（Codex の tool 名に合わせる）、(c) deny 出力フォーマット
  （Claude 形式 `permissionDecision` と概ね一致。差分は出力アダプタで吸収）。
- runner（`belay-runner`）と core.mjs レンダリングの既存機構を流用できる。

### R-X1 — Codex アダプタ feasibility 確認（**結果: GO**）

**検証結果2（確定・2026-06-13 対話 TUI）**

実 `~/.codex/config.toml` に PreToolUse deny フックを設定し、`/hooks` で trust した対話 TUI で実測:

- `echo BELAY_TUI_DENY` → **ブロックされた**（`Command blocked by PreToolUse hook: ...sentinel blocked`）
- `echo HELLO_CONTROL`（対照）→ 通常実行

→ **正しく trust された PreToolUse deny は、対話 TUI で shell を実際にブロックする。Codex は
床になれる（GO）。** headless `codex exec`（下記検証結果1）が未発火だったのは exec 側の
不完全さで、ユーザの実面である TUI は機能する。

さらにフックが記録した**実ペイロード**で tool 契約が判明:

```json
{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo ..."},
 "cwd":"...","permission_mode":"default","tool_use_id":"call_..."}
```

→ **`tool_name:"Bash"` / `tool_input:{command}` は Claude と同一**。belay の `mapCodexToolName`
（`bash`→shell）と `normalizeCodexToolPayload`（command 抽出）はそのまま正しい。shell の
TODO-verify は解決。残るは shell 以外の tool 名（apply_patch / read 系 / subagent）の確定。

> 未解決(要追検証): `.*` matcher で全 PreToolUse を捕捉し未マップを fail-closed deny する現行
> 実装は、read 系など benign tool まで deny してエージェントを壊しうる。shell=Bash が確定した
> ので、matcher を危険 tool に絞るか、未マップを allow に戻すかを R-X1 追検証で決める。

---

**検証結果1（headless・参考）— Codex 0.136.0, gpt-5.5, macOS arm64**

隔離した `CODEX_HOME` にインライン TOML hooks を設定し、`codex exec`（ヘッドレス）で
PreToolUse deny フックの発火を実機テストした。**結論: feasibility は未確認（headless では
フックが発火せず）。**

判明した事実:
- **deny 機構・config スキーマは実在**: バイナリに `Command blocked by PreToolUse hook:` /
  `Tool call blocked by PreToolUse hook:` の文字列。`hooks` はトップレベル config キーで
  `HooksToml` 構造体（`[[hooks.PreToolUse]]` + `[[hooks.PreToolUse.hooks]]` type/command/
  timeout）。誤った string 指定では `expected struct HooksToml` で明確にエラー = 正しい
  TOML は確実にパースされている。`--dangerously-bypass-hook-trust` で「Enabled hooks may
  run」警告も出る = config は認識されている。
- **しかし実際にはフックが一度も発火しなかった**。`codex exec` で次のいずれも未発火:
  shell（`echo` / `--full-auto`=workspace-write）、apply_patch（ファイル作成）、SessionStart。
  `RUST_LOG=codex_core=trace` でも hook_runtime のトレースが皆無 = ランタイムが評価して
  いない。フックスクリプト単体は正常（stdin→ログ書込→deny JSON 出力を確認済み）。
- **`--dangerously-bypass-approvals-and-sandbox` はフックを無効化する**（公式解説と一致）。
  `--full-auto` でも本検証では発火しなかった点が、公式解説（「`--full-auto` では shell
  PreToolUse が発火する」）と**食い違う**。
- **既知の弱点**: apply_patch / 多くの MCP tool はフック傍受に穴があり upstream 追跡中
  （openai/codex#16732）。"Hooks no longer run after Desktop update" の退行報告もある
  （openai/codex#21639）。

**含意**: belay の中核は**非バイパスの床**。だが Codex のフック発火は
バージョン/フラグ/trust に敏感で**out-of-the-box で再現しなかった**。「発火するか
どうかが環境依存のフック」は、現時点では belay の enforcement 基盤として依存できない。

**判断: Codex アダプタの実装は保留**。次の再検証ゲートを通すまで着手しない:
1. **対話 TUI** で実 `/hooks` trust を行い、PreToolUse deny が shell をブロックするかを実測
   （headless ではなく TUI が trust UI の本来の経路。startup_hooks_review.rs はそこにある）。
2. headless（`codex exec --full-auto`）でフックが発火しなかった原因の切り分け
   （0.136 の退行か、CODEX_HOME 経由 config の未読込か、未文書の trust 要件か）。
3. apply_patch / MCP 傍受の穴（#16732）が belay の対象操作に影響しないか。

通った場合のみ `src/adapters/codex` を `claude` アダプタからの差分として実装する
（adapter-sdk: layout `codex.ts` → runtime-entry/hooks 定義 → `registry.ts` 登録 →
conformance test → runtime バンドル → `gateVerdictToCodexPreToolUseResponse`）。
Windows は hooks 無効のため対応 OS を明示する。

> 教訓: このスパイクは「作る前に確かめる」ゲートとして機能した。ドキュメント上は
> 「Codex hooks ≈ Claude Code hooks」だが、**実機では発火が確認できず**、Codex アダプタを
> 先に実装していたら不安定な基盤の上に作ることになっていた。

### R-X1.1 — 実装方針の更新（assumed-pass、クレジット枯渇により検証保留）

Codex クレジット枯渇で TUI 実測が一時不能になったため、方針を「**通る前提で先行実装し、
検証で外れたら修正**」に切り替える。ただし FN=0（非バイパスの床）の核心を守るため、
次のガードを必須とする:

- **配布モード**: まず **per-repo `.codex/config.toml`**（user hook, trust 必要）を主軸に実装
  （既存 claude/cursor アダプタと同じ layout 抽象を再利用する機械的差分）。
  managed 配置（`/etc/codex/managed_config.toml` / `requirements.toml [hooks]`・pre-trusted・
  sudo）は**後追いの deployment mode** として §3.2 managed 調査に基づき別途。
- **確実な部分は今ユニット検証**: deny 出力形式（`permissionDecision:"deny"` / exit 2）と
  verdict→Codex JSON マッピング（`gateVerdictToCodexPreToolUseResponse`）は純関数なので
  conformance テストで検証する（ライブ発火不要）。
- **不確実な部分は fail-loud に隔離**:
  - (a) フックが実際に発火するか → **doctor が `firing-unverified` を赤警告**し、Codex
    アダプタを **experimental** 扱いにする。スモーク（センチネル deny）が通るまで「保護済み」と
    名乗らせない（サイレントな偽の床を禁止）。
  - (c) shell tool の実 matcher 名 → 広めの暫定値 + `TODO-verify` コメントで局所化。
- **検証手順を残す**: TUI スモーク（実 `~/.codex/config.toml` で trust → センチネル deny 確認）
  と managed スモークの手順を docs に残し、クレジット復活時に実行。通れば experimental を外す。

> この節は「assumed-pass で建てた」ことの記録。R-X1 が GO になり、下記 R-X3 が as-built を規定する。

### R-X3 — Codex アダプタ（**実装済み・experimental**・as-built 規範）

WS-Codex は実装済み。本節がその規範を確定する。

**配置・配線（MUST、実装済み）**
- per-repo `.codex/config.toml` に belay 管理の TOML hooks ブロックを**マーカー区切りで冪等
  マージ**する（`# BELAY MANAGED HOOKS BEGIN/END`）。belay 設定は `.codex/belay.config.json`。
- 登録イベント: `PreToolUse`（matcher `.*`→統合ハンドラ）/ `SubagentStart` / `UserPromptSubmit`
  / `PostToolUse`。runner・core.mjs は既存機構を流用、bundle は `codex-runtime.mjs`。
- deny 出力は Claude 同形（`hookSpecificOutput.permissionDecision:"deny"`）。
  UserPromptSubmit は `decision:"block"`。

**未マップ tool の安全姿勢（MUST、実装済み）**
- PreToolUse を `.*` で全捕捉し、`mapCodexToolName` が tool 種別（shell/subagent/tool）を解決。
  shell=`Bash`/`tool_input.command` は R-X1 実測で確定。
- **未マップ tool の既定は `deny`（fail-closed）**。サイレントな床の素通り（FN）を禁止する。
  設定 `policy.codexUnmappedTool: 'allow' | 'deny'`（既定 `deny`）で `allow`（監査記録付き
  オプトアウト）に切替可。`allow` は「実機で read 系まで過剰ブロックされた」証拠が出た時のみ。
- 分類失敗・unmapped はいずれも fail-closed（deny）。

**experimental ガード（MUST、実装済み）**
- `doctor` は Codex アダプタを **`firing-unverified` として赤警告**し、belay 自身の発火スモークが
  通るまで「保護済み」と名乗らせない（サイレントな偽の床の禁止）。
- **G-B2（experimental 解除ゲート）**: belay 実適配器を `.codex/config.toml` に入れ、`dropdb`/
  `docker push` 相当が belay 自身でブロックされることを TUI で確認 → doctor の experimental 警告
  を外し、`mapCodexToolName` の shell 以外（apply_patch 等）の実 tool 名を確定する。

**運用制約（MUST 明示）— scope（R-S5）に従う**: Windows は Codex hooks 無効。
`project`/`global` scope は非 managed hook なので `/hooks` 手動 trust が必要（doctor/skill で
trust 導線を案内 + experimental ガード）。`managed` scope（`/etc/codex/managed_config.toml`・sudo）
は **pre-trusted**（`/hooks` 不要・`allow_managed_hooks_only` で非バイパス床）。managed は WS-Pkg
の deployment mode として扱い、v2.2 既定は project（手動 trust）。

**受け入れ基準**: T24（TOML 冪等マージ）/ T25（deny 契約 = Claude 同形）/ T26（未マップ既定 deny）
/ T27（doctor の experimental 警告）。いずれも `src/__tests__/v2/codex-adapter.test.ts` で実装済み。

### 3.3 横展開の限界（正直な注記）
- skill（SKILL.md）はクロスエージェント標準だが**助言層**。各エージェントの floor は
  それぞれの **hook** に依存する（Cursor hooks / Claude Code hooks / Codex hooks）。
- 「skill 1 つ配れば全エージェントで床になる」ことはない。skill は front door を統一し、
  floor は各エージェントの hook アダプタが受け持つ、という二層構造が前提。

### 3.4 配布 packaging（plugin / hook-package / skill）

「belay を hook として取り込む」際の**配布チャネル**は、2026-06 時点で
**2 層**に分かれている。技術的 deny 契約（§3.2）とは別に、この packaging 軸を押さえる。

#### 層 A — クロスエージェント skill CLI（hook は運べない）
- `npx skills add owner/repo`（vercel-labs/skills 系）が Cursor / Claude Code / Codex 等
  多数のエージェントに skill を配置する事実上の標準。belay なら:
  ```bash
  npx skills add guilz-dev/agent-belay --skill belay -a cursor -y
  npx skills add guilz-dev/agent-belay --skill belay -a claude-code -y
  npx skills add guilz-dev/agent-belay --skill belay -a codex -y
  ```
- エージェント別の skill 配置先（skills CLI 互換表より。*claimed*・実機要確認）:

  | エージェント | CLI 名 | プロジェクト | グローバル |
  | --- | --- | --- | --- |
  | Cursor | `cursor` | `.agents/skills/` or `.cursor/skills/` | `~/.cursor/skills/` |
  | Claude Code | `claude-code` | `.claude/skills/` | `~/.claude/skills/` |
  | Codex | `codex` | `.agents/skills/` | `~/.codex/skills/` |

- ただし**この CLI は skill のみ。hook は配布対象外**（互換表で Hooks 列は Cursor/Codex で No）。
- → belay の **front door（SKILL.md）はここで広く配れる**が、floor（hook）は運べない。

#### 層 B — 各ホストのネイティブ plugin / marketplace（hook を運べる）
| ホスト | hook の配布単位 | 導入インタフェース |
| --- | --- | --- |
| **Claude Code** | **plugin**（skills + hooks + MCP のバンドル） | `/plugin marketplace add org/repo` → install。`claude plugin init` で雛形。hook 単体の専用インストーラは無く、**配布単位は plugin** |
| **Codex CLI** | **plugin / standalone skill / standalone hook package** | `codex marketplace add github:org/repo`。**hook package を単独配布できる**（Claude Code との差分）。定義は `$REPO/.agents/plugins/marketplace.json` |
| **Cursor** | hooks はプロジェクト同梱が基本 | 公式の hook パッケージマネージャは無い。skill は marketplace / `npx skills add` |

> 補足: Composer 調査の「hooks には相当する配布経路がない」は層 A（クロスエージェント
> skill CLI）に限れば正しい。層 B（各ホスト native）まで見ると、**Claude Code は plugin、
> Codex は hook package**として hook を配布できる、と精緻化される。

#### belay の現状と含意
- belay は独自インストーラ `npx agent-belay init [--adapter X]` で各アダプタの設定へ
  hook を書き込む（層 A/B いずれにも依存しない自前チャネル）。
- **含意（packaging 戦略）**: floor を「広く・容易に」配るには、各ホストの native 単位に
  packaging するのが筋。
  - Claude Code → belay を **plugin** 化（hooks + SKILL + `/belay-approve` を 1 plugin に）。
    手動 `init` 依存を減らし plugin marketplace 経由で配れる。
  - Codex → **standalone hook package** か plugin。
  - Cursor → front-door **skill**（`npx skills add`）+ hooks（`init`）。
- いずれも中身は単一の **shared gate-runtime**。外側の packaging だけ各ホスト単位に合わせる、
  という三層構造（skill=front door / hook=floor / **plugin・hook-package=配布単位**）になる。

### R-X4 — 配布 packaging（WS-Pkg・SHOULD）

R-X1 が GO になったので packaging に着手できる。各ホストの native 単位で belay を
packaging する。中身は単一の shared gate-runtime で、外側だけ各ホストに合わせる。

| ホスト | packaging 単位（SHOULD） | 内容 |
| --- | --- | --- |
| Cursor | **skill**（`npx skills add`）+ hooks（`init`） | front door は skill marketplace、floor は hooks |
| Claude Code | **plugin**（`/plugin marketplace add`） | hooks + SKILL + `/belay-approve` を 1 plugin に束ね、手動 init 依存を削減 |
| Codex | **standalone hook package** または plugin（`codex marketplace add`） | hook 単独配布が可能。managed 配置（pre-trusted）も選択肢 |

- **G（着手条件）**: WS-Codex（実装済み）と WS-Skill（G-A/G-B1 後）が安定してから。
- **受け入れ基準**: 各ホストの marketplace/CLI から導入→`doctor` 緑が再現できること（T28）。
- managed Codex（`/etc/codex/managed_config.toml` / `requirements.toml [hooks]`・pre-trusted・
  sudo・`allow_managed_hooks_only`）は「非バイパスの真の床」として WS-Pkg の deployment mode で扱う。

---

## 4. 非ゴール（v2.2）

- 判定ロジック（Tier0/Tier1、wrapper 剥がし、launcher 解決、三値 boolean）の変更。
- skill を強制力の代替にすること（安全境界 §1.1 に反する）。
- **ephemeral な hook トグル**（`belay-run` 的な「一時的に on/off」）。床は常設であり、
  fence 的な一時有効化は床思想に反する。「お試し」は project scope + audit で受ける（R-S2）。
- Codex 以外の新規エージェント対応（Gemini CLI 等）は本書の対象外。

## 5. v2.1.1 との関係

- 本書は SPEC-v2.1.1 の **WS-J（v2.2 候補）を展開**したもの。
- 前提として v2.1.1（cloud provider 正直化・v0.3 残渣撤去・テスト隔離・精度計測）が
  先に入っていることを想定する。判定コアと provider 表層が安定した上で、配布形態（skill）
  と横展開（Codex）に着手する順序。

## 6. skill 品質チェックリスト（v2.2 出荷ゲート案）

skill として配布するときに満たすべき性質（実装時のゲート）:

- [ ] `description` に WHAT（belay 承認・ゲート補助）と WHEN（denied, blocked, high-risk,
      belay-approve）を含む（R-S4）
- [ ] hook 未導入時に `npx agent-belay init` を促す手順がある（R-S2 / 安全境界 §1.1）
- [ ] `agent-belay doctor` で導入確認する手順がある
- [ ] `/belay-approve` フローが明確（既存）
- [ ] WS-J コマンド（why / explain / status）の手順と出力テンプレート（R-S3）
- [ ] cloud judge 利用時の `--accept-cloud-judge` 等 v2.1.1 契約への言及
- [ ] マルチ adapter 向け init コマンドの分岐（Cursor / Claude / Codex）
- [ ] `disable-model-invocation` の方針を決め frontmatter に明記（O1）
- [ ] `npx skills add` 用に `skills/belay/` がパッケージに同梱されている（現状 OK）
- [ ] skill 経由の手順が conformance / CLI テストで壊れていないこと（スナップショット）
- [ ] **README / marketplace 説明の安全境界を退行させない**: skill-only=助言モード・
      enforcement は `init` 必須、という現行の明記（README L98 / L153-154）を保持し、
      skill 前面化で「skill だけで床になる」と誤読される表現を入れない（§1.1）
- [ ] **README が多ホスト導入を反映**: Cursor / Claude Code（既存）/ Codex（実装後）の
      `init --adapter X` と `npx skills add -a X` を対等に記載。stale なロードマップ
      （現 README は v0.4 で停止）を v2.x に更新

> docs は spec の**受け入れ基準を満たすべき artifact**。spec は契約のみを規定し、
> README 文面は spec に貼らない（spec-first を保ちつつ doc 肥大を避ける）。

## 7. テスト要件 (v2.2)

v2.1/v2.1.1 と同じ粒度の受け入れゲート。WS-Codex 分（T24〜T27）は実装済み、WS-Skill/Pkg 分は
当該 WS 着手時に追加する。

| # | 対象 | 検証内容 | 状態 |
| --- | --- | --- | --- |
| T20 | R-S1 安全境界 | skill 経路に判定ロジックが無く、判定が単一コア経由であること | WS-Skill |
| T21 | R-S2 advisory | hook 未導入リポジトリで skill 手順が advisory 警告 + `init` 導線を返す（skill-only=floor でない負テスト） | WS-Skill |
| T22 | R-S3 CLI | `agent-belay explain --command "..."` が verdict 要素（location/effect/permission/reason）を出力 | WS-Skill |
| T23 | R-S4 skill 品質 | SKILL.md スナップショット + `description` トリガー語の存在 | WS-Skill |
| T24 | R-X3 Codex TOML | `.codex/config.toml` の管理ブロックが冪等マージ（再 init で重複しない） | ✅ 実装済み |
| T25 | R-X3 deny 契約 | verdict→Codex JSON が Claude 同形（`permissionDecision:"deny"`）/ allow→空 | ✅ 実装済み |
| T26 | R-X3 未マップ | 既定で `policy.codexUnmappedTool='deny'`（fail-closed）であること | ✅ 実装済み |
| T27 | R-X3 doctor | Codex を `EXPERIMENTAL / firing-unverified` と警告すること | ✅ 実装済み |
| T28 | R-X4 packaging | 各ホストの marketplace/CLI 導入→`doctor` 緑が再現 | WS-Pkg |
| T29 | R-S5 scope | `--scope project\|global` が provider 別の正しい場所へ skill+hook を書く／既定 project／`managed` は Codex のみ | WS-Skill |

## 8. オープンクエスチョン（ゲート対応）

| # | 論点 | 確定方法 / ゲート |
| --- | --- | --- |
| O1 | `disable-model-invocation` の方針 | ✅ **解決（`true`=明示のみ）**。理由は R-S4。G-B1 後に `false` 再評価の余地あり |
| O2 | Cursor の skill 明示呼び出し UX | **G-B1 実機検証**（§2.1）。R-S3 実装の前提 |
| O3 | Codex hook の実ブロック挙動・tool 名・trust | ✅ **解決**（R-X1 GO・`tool_name:"Bash"` 確定） |
| O4 | Codex の v2.2 スコープ | ✅ **解決**（正式アダプタ実装済み・experimental、R-X3） |
| O5 | skill 配置（init 統一 vs skills CLI） | ✅ **解決**（R-S5 scope 軸 + hybrid: B=marketplace 表口 / A=init が scope に従い per-host 配置） |
| O6 | skill ↔ runtime のバージョン整合 | `doctor` で乖離検出するか（WS-Skill で決定） |
| O7 | skill-only =「助言モード」の表示担保 | marketplace 説明文レベルでどう保証するか（WS-Pkg / 安全境界 §1.1） |

## 出典（調査）

belay 実コードで裏取り済み: Cursor イベント名（`beforeShellExecution` 他）= `src/adapters/cursor`、
Claude イベント = `src/adapters/claude/hooks.ts`、`explain` サブコマンド = `src/cli.ts:509`。

- [How to Use SKILL.md Skills in Cursor (2026 Guide)](https://www.agensi.io/learn/how-to-use-skill-md-in-cursor)
- [The SKILL.md Open Standard — Full Specification (2026)](https://www.agensi.io/learn/skill-md-specification-open-standard)
- [Cursor Docs — Agent Skills](https://cursor.com/docs/skills)
- [vercel-labs/skills — マルチエージェント skill CLI](https://github.com/vercel-labs/skills)
- [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks)
- [Create and distribute a plugin marketplace — Claude Code Docs](https://code.claude.com/docs/en/plugin-marketplaces)
- [Hooks – Codex | OpenAI Developers](https://developers.openai.com/codex/hooks)
- [Build plugins – Codex | OpenAI Developers](https://developers.openai.com/codex/plugins/build)
- [Advanced Configuration – Codex | OpenAI Developers](https://developers.openai.com/codex/config-advanced)
