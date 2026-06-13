# agent-belay SPEC v2.2（草案）— skill 配布形態と他エージェント横展開

Status: **Draft / exploration**（spec 確定前の検討メモ。実装着手の合意ではない）
Builds on: SPEC-v2.1 / SPEC-v2.1.1（WS-J の意図を本書で展開）。関連: CONCEPT-v2.0 §7 / adapter-sdk.md
Consolidates: `SPEC-v2.2-draft-skill-interface.md`（Composer 調査）を本書に統合（同ファイルは
`-superseded` として退避）。skill frontmatter 契約・品質チェックリスト・Codex 運用制約・
WS-J→CLI マッピング・ホスト横断イベント表を取り込み済み。
扱う問い:
1. belay を **Cursor skill として配布**する場合、skill インタフェース/性質をどう設計するか。
2. 将来 **Claude Code / Codex の hooks** として使う経路はありうるか（調査結果）。

---

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
  - **Codex CLI**: **保留（要再検証）**。hook スキーマ・deny 機構は実在し Claude Code と
    ほぼ同一だが、2026-06-13 の実機スパイク（0.136.0）では `codex exec` ヘッドレスで
    フックが**一度も発火せず**、feasibility を確認できなかった（後述 R-X1）。実装着手前に
    対話 TUI での再検証が必要。

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

## 2. skill インタフェース設計（front door）

belay-as-skill が提供すべき性質と表面:

### R-S1 — skill は「導入と説明」、enforcement は hook に委譲する
- SKILL.md の `description` は「高リスク操作が belay に止められたときの承認フロー、および
  belay の導入/状態確認」を担うことを明記する。判定そのものは hook 経路と**同一コア**
  （shared gate-runtime）で行い、skill 側に判定ロジックを二重実装しない。

### R-S2 — bootstrap：skill 呼び出しで hook の導入/検証を行う
- skill から `init`/`doctor` 相当を実行できる導線を持つ。hook 未導入・整合性破れ・
  judge 未設定（R26: cloud key 不在等）を検出して人間可読に報告する。
- これにより「skill を入れた → 促されて floor（hook）も入る」という導入動線を作る。

### R-S3 — 対話インタフェース（候補。要 UX 検証）
skill は**判定をしない**。ユーザー向けの `/belay …` を受けて、エージェントに
`agent-belay` CLI を叩かせる**薄いオーケストレーション層**に徹する（判定は常に core）。

| ユーザー向け | エージェントが実行する CLI | 目的 | CLI 現状 |
| --- | --- | --- | --- |
| `/belay why <command>` | `agent-belay explain --command "..."` | verdict（location/opacity/effect/permission、reason、Tier0/Tier1、judgeTrace）の人間可読説明 | `explain` は既存（`src/cli.ts:509`）。`--command` 形は要拡張 |
| `/belay explain` | `agent-belay explain` | 直近 `ask` の根拠と承認/却下の選択肢 | 既存 |
| `/belay status` | `agent-belay status` | provider（ollama / openai-compatible）・cloud 同意・model 解決・hook 導入・dogfood | 既存 |
| `/belay approve <id>` | （既存）prompt 経由の承認 | one-shot 承認。現行 `/belay-approve` を整理統合 | 既存 |

**不変条件**: これらは hook 経路と同じ判定コアを呼ぶだけで、新しい緩和/停止を導入しない。

### R-S4 — skill の「性質」要件（Agent Skills 標準への準拠）
skill として配布する以上、標準が求める契約を満たす。最低限の必須:

| 要素 | 要件 | belay への含意 |
| --- | --- | --- |
| ディレクトリ | `<skill-name>/SKILL.md` | `skills/belay/SKILL.md`（npm パッケージ同梱） |
| `name` | 小文字・ハイフン、親フォルダ名と一致 | `belay` |
| `description` | 1024 字以内・**三人称**・WHAT + WHEN | 承認/停止/explain 等のトリガー語（denied, blocked, high-risk, belay-approve）を含める |
| 本文 | 手順・例・出力形式 | init 前提、CLI コマンド、失敗時の `doctor` 導線 |

任意だが v2.2 で方針を決める frontmatter:

| フィールド | 用途 | belay への論点 |
| --- | --- | --- |
| `disable-model-invocation` | `true` で `/belay` 明示時のみ起動 | 誤自動発火を避けるなら `true`、停止時の自動案内なら `false`（§6 O1） |
| `paths` | 特定ファイルパターンにスコープ | 通常は未設定（リポジトリ全体で有効） |

性質上の不変条件:
- 単一責務・自己完結・description で発火条件が明確（クロスエージェントで誤発火しない）。
- 破壊的副作用を skill 自身が持たない（install/doctor は明示実行、暗黙実行しない）。
- バンドル物（承認コマンド等）は skill ディレクトリに自己完結させる。

### 2.1 未確定（要検証）
- Cursor における skill の**明示呼び出し UX**（slash command 的な明示起動か、description
  一致による自動発火か、その併用か）。現行 belay は `.cursor/commands/belay-approve.md` を
  併用しているため、commands と skills の役割分担を実機で確認してから R-S3 を確定する。

---

## 3. 他エージェント横展開（調査結果）

### 3.1 現状とホスト横断イベント表（実コードで裏取り）

belay の関心ごとに、各ホストの hook イベントを対応づけた表。Cursor / Claude Code 列は
belay の実コードと一致を確認済み、Codex 列は公式ドキュメントベース（未実装）。

| belay 関心 | Cursor | Claude Code | Codex | block 応答 |
| --- | --- | --- | --- | --- |
| Shell gate | `beforeShellExecution` | `PreToolUse` / `Bash` | `PreToolUse` / `Bash` | Cursor: `permission: allow\|deny\|ask` / Claude・Codex: `permissionDecision: "deny"` or exit 2 |
| Tool・File gate | `preToolUse` | `PreToolUse` / `Write\|Edit\|Delete` | `PreToolUse`（tool 名要実測） | 同上 |
| 承認プロンプト | `beforeSubmitPrompt` | `UserPromptSubmit` | `UserPromptSubmit`（`decision: block`） | block / exit 2 |
| 監査 | `postToolUse` | `PostToolUse` | `PostToolUse`（事後・undo 不可） | — |
| Subagent | `subagentStart` | `PreToolUse` / `Task` | `SubagentStart`（別イベント） | — |
| belay 実装 | ✅ `adapters/cursor` | ✅ `adapters/claude` | ❌ 未実装 | — |

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

### R-X1 — Codex アダプタ feasibility 確認（実施済み・結果は **保留/要再検証**）

**検証結果（2026-06-13 実施。Codex 0.136.0, gpt-5.5, macOS arm64）**

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

### R-X2 — packaging 方針の確定（feasibility 後）
- §3.2 の Codex deny スパイク（R-X1）が通った後、各ホストの native packaging
  （Claude Code plugin / Codex hook package）の最小スキャフォールドを試作し、
  `npx agent-belay init` 依存をどこまで marketplace 配布に置換できるかを見極める。

---

## 4. 非ゴール（v2.2 草案）

- 判定ロジック（Tier0/Tier1、wrapper 剥がし、launcher 解決、三値 boolean）の変更。
- skill を強制力の代替にすること（安全境界 §1.1 に反する）。
- Codex 以外の新規エージェント対応（Gemini CLI 等）は本草案の対象外。

## 5. v2.1.1 との関係

- 本草案は SPEC-v2.1.1 の **WS-J（v2.2 候補）を展開**したもの。
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

## 7. オープンクエスチョン

| # | 論点 | 選択肢 / 確定方法 |
| --- | --- | --- |
| O1 | `disable-model-invocation` の方針 | `true`（明示 `/belay` のみ）vs `false`（停止時に自動案内） |
| O2 | Cursor の skill 明示呼び出し UX | commands（`.cursor/commands/belay-*.md`）と skills の役割分担。実機検証（§2.1） |
| O3 | Codex hook の実ブロック挙動・tool 名・trust フロー | R-X1 スパイクで確定 |
| O4 | Codex の v2.2 スコープ | スパイクのみ vs 正式アダプタ同梱（R-X1/R-X2） |
| O5 | Claude skill 同梱 | `init --with-skill` を Claude に拡張するか、skills CLI に任せるか（§3.1 ギャップ） |
| O6 | skill ↔ runtime のバージョン整合 | `doctor` で skill 版と runtime 版の乖離を検出するか |
| O7 | skill-only =「助言モード」の表示担保 | marketplace 説明文レベルでどう保証するか（配布チャネル制約） |

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
