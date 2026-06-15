# Tier1 judge プロバイダ切り替え UX — 設計メモ

ステータス: **Phase 1–3 実装済み**（PR #13）/ Follow-up 追跡中
対象（現行）: `src/commands/config.ts`, `src/commands/judge.ts`, `src/core/judge-config.ts`,
`src/core/judge-model-discovery.ts`, `src/core/judge-runtime-detection.ts`,
`src/core/verdict/judge-catalog.ts`, `src/core/verdict/judge-factory.ts`, `src/core/verdict/judge-cli.ts`
作成日: 2026-06-15 / 最終更新: 2026-06-15

---

## 0. TL;DR（現行）

| 項目 | 実装 |
|------|------|
| 正規 provider id | `ollama` / `codex` / `claude` / `cursor`（`judge.providerId`） |
| 主設定経路 | **`belay config`**（対話・`set`/`get`/`credential`/`judge`） |
| 副経路 | `belay judge use` / `belay init` フラグ |
| transport | `http` / `codex-cli` / `cursor-cli` / `claude-cli` / `ollama-http` / `unavailable` |
| keyless | API キー未設定時は native CLI を優先（host-session）。HTTP は endpoint + consent 必須 |
| credential | `mode: project`（既定）\| `apiKey`（store/env 参照） |
| model discovery | ollama=`/api/tags`、cursor/codex/claude=host CLI または API（キー時） |
| 移行 | `--migrate-judge-default` で暗黙 factory-default `ollama` のみ host 既定へ（audit 記録） |
| 廃止 | `init-wizard` → `belay config` へ誘導 |

**Known limitations（Follow-up）:** `model: auto` 読込残存、vitest では CLI discovery スキップ、
対話 `belay config` は既存 repo で judge-only 変更に不向き（`config set` 推奨）。
詳細は README / `docs/config-schema.md` §judge Known limitations。

### Phase 3 実装メモ（2026-06-15）

- **正規 provider id**: `ollama` / `codex` / `claude` / `cursor`（`judge.providerId`）
- **主経路**: `belay config`（対話・`set`/`get`/`credential`/`judge`）と `belay judge`（`status`/`test`/`use`）
- **transport**: `http` / `codex-cli` / `cursor-cli` / `claude-cli` / `ollama-http` / `unavailable`
- **keyless**: API キー未設定時は native CLI を優先（host-session）。HTTP は endpoint + consent 必須
- **model discovery**: ollama=`/api/tags`、cursor=`cursor-agent --list-models`、codex=`codex debug models`、claude=Anthropic `/v1/models`（キー時）
- **移行**: `--migrate-judge-default` で暗黙の factory-default `ollama` のみ host 既定へ（audit 記録）

---

## 歴史: 実装前の問題分析（§1 以降）

> **注意:** §1–8 は Phase 1 着手前の現状分析・再設計案である。`init-wizard.ts` 参照、
> `local`/`openai` 2 値モデル、`belay judge` 未実装などは**解消済み**。
> 現行の正は README、`docs/config-schema.md`、`src/__tests__/plan/judge-phase{1,2,3}-plan.test.ts`。

---

## 1. 当時のデータモデル（解消済み）

### 1.1 設定の最終形（config の `judge` ブロック）

`BelayJudgeConfig`（[config.ts:105](../../src/core/config.ts)）が唯一の正:

```ts
interface BelayJudgeConfig {
  provider: 'ollama' | 'openai-compatible'   // 実体は 2 種類だけ
  model: string                              // 'auto' を含む
  timeoutMs: number
  endpoint: string | null                    // openai-compatible は必須
  keepAlive: string | null                   // ollama のみ
}
```

つまり**最終的に意味を持つ軸は `provider`（2値）+ `model` + `endpoint` だけ**。

### 1.2 入力経路（ユーザーが触る面）

ところが入力は 4 軸に膨張している（[judge-config.ts:37](../../src/core/judge-config.ts),
[cli.ts:120-157](../../src/cli.ts)）:

| 入力軸 | 取りうる値 | 実体への写像 |
|--------|-----------|-------------|
| `--judge-profile` | `local-ollama` \| `cursor` \| `claude` \| `codex` | プリセット束 |
| `--judge-provider` | `ollama` \| `openai-compatible` \| `cursor` | normalize で 2 値へ |
| `--judge-model` | 文字列 \| `auto` | そのまま |
| `--judge-endpoint` | URL | そのまま |
| `--accept-cloud-judge` | bool | 同意ゲート（永続化されない） |
| env `BELAY_JUDGE_API_KEY` / `OPENAI_API_KEY` | キー | 実行時のみ参照、config 非保存 |
| env `BELAY_JUDGE_MODEL_RESOLVED` | モデル id | `auto` の解決先を上書き |

入力 4 軸 → 実体 3 軸への縮約が複数箇所（CLI parse / `resolveJudgeConfig` /
`normalizeJudgeProvider` / `resolveCloudModel`）に散らばっており、写像規則が一望できない。

---

## 2. 問題の深掘り

### P1. 「プロファイル名 = ホスト名」という致命的なミスリード

プリセット定義（[judge-config.ts:14-35](../../src/core/judge-config.ts)）:

```ts
export const JUDGE_PROFILE_CURSOR = {
  provider: 'openai-compatible', model: 'auto',
  endpoint: 'https://api.openai.com/v1', timeoutMs: 8000, keepAlive: null,
}
export const JUDGE_PROFILE_CLAUDE = { ...JUDGE_PROFILE_CURSOR }   // 完全コピー
export const JUDGE_PROFILE_CODEX  = { ...JUDGE_PROFILE_CURSOR }   // 完全コピー
```

- `cursor` / `claude` / `codex` の 3 プロファイルは**バイト単位で同一**であり、すべて
  **OpenAI のエンドポイント**を指す。
- すなわち「judge を `claude` にする」と指定しても **Anthropic ではなく OpenAI** に redacted
  コマンドが飛ぶ。「judge を `cursor` にする」と指定しても **Cursor の API ではなく** OpenAI を指す。
- プロファイル名は**ホストアダプタ名**（cursor/claude/codex = エージェント実行環境）から借用した
  ものだが、judge の軸は**LLM API プロバイダ**であり、両者は直交する。この借用が混乱の根源。

さらに wizard はこれを増幅する（[init-wizard.ts:83](../../src/commands/init-wizard.ts)）:

```ts
const defaultJudgeProfile = adapter   // adapter=claude なら judge も 'claude'
```

→ Claude アダプタを選んだユーザーに、OpenAI を指す judge が「claude」という名前で既定提示される。

### P2. 切り替え専用コマンドが無い

CLI のサブコマンド一覧（[cli.ts:408-](../../src/cli.ts)）には
`init / doctor / audit / simulate / metrics / report / recover / status / explain / egress /
sandbox / approve / revoke` …はあるが、**`judge` サブコマンドは無い**。

プロバイダを変えるための公式手段は 2 つだけ:

1. `belay init --judge-profile … --accept-cloud-judge` を**再実行**
   → init はフック/ランタイム/スキル等の他成果物も書き換えうる重い操作。プロバイダだけ変えたい
     のに副作用が広い。
2. `.cursor/belay.config.json` の `judge` を**直接手編集**

どちらも「ちょっとプロバイダを切り替える」には過剰で、idempotent な軽量操作が存在しない。

### P3. dogfood パラドックス（自己ロック）

上記 2 手段は**いずれも Belay 自身のゲートにブロックされる**:

- `belay init …` は shell 実行 → 高リスク shell として `ask`/`deny`（transcript の
  `belay_4861777ba097`)。
- `.cursor/belay.config.json` の編集は**control-plane パス配下のファイル変更**として
  `control_plane_mutation` で分類・ブロックされる
  （[classify-tool.ts:201-210](../../src/core/classify-tool.ts)）。transcript の
  `belay_773eddf21cf3` がこれ。

結果、**「ロックを司る設定」を変えるのに、そのロックが立ちはだかる**。ユーザーは方式ごとに別々の
承認 ID（`/belay-approve <id>`）を踏まされ、しかも「どちらの ID がどちらの操作用か」を取り違える。
冒頭の transcript はまさにこの状態を再現している。

### P4. 失敗が実行時まで silent → 過剰ブロック

judge が誤設定でも、即時エラーにならず**実行時に fail-closed**する:

- API キー未設定 → `openai_compatible_auth_error` で `ask`
  （[judge.ts:248-257](../../src/core/verdict/judge.ts)）。
- endpoint 欠落 → `createFailClosedJudge('openai_compatible_endpoint_missing')`
  （[judge-factory.ts:74-81](../../src/core/verdict/judge-factory.ts)）。
- Ollama 未起動 / モデル未取得 → `ollama_unavailable`。

CONCEPT 上「judge 不在 → ask に倒す」は正しい安全設計だが、**ユーザー視点では「急に全部ブロック
され始めた」**としか映らない。診断は `belay doctor` を能動的に叩かないと得られず、ブロック自体は
原因（judge 誤設定）を名指ししない。

### P5. `model: "auto"` の不透明な解決

`auto` は `fixtures/judge-models.json` 経由で `composer-2.5` に解決される
（[judge-factory.ts:48-60](../../src/core/verdict/judge-factory.ts)）。
上書きは env `BELAY_JUDGE_MODEL_RESOLVED` のみ。

- 既定プロファイル `cursor` は `endpoint=api.openai.com/v1` かつ `model=auto→composer-2.5`。
  **`composer-2.5` は OpenAI のモデルではない**ため、この既定の組み合わせはそのままでは
  整合しない（OpenAI 側で 404 相当）。「名前と実体の乖離」(P1) がモデル軸でも起きている。
- ユーザーは「実際に何のモデルが走るか」を `doctor` か env を読まない限り知り得ない。

### P6. クラウド同意が永続化されない

`--accept-cloud-judge` は CLI フラグ（[judge-config.ts:130](../../src/core/judge-config.ts)）で、
config に記録されない。再 init のたびに再同意を強いられ、かつ「いつ誰が同意したか」の監査痕跡も無い。
`CloudJudgeConsentRequiredError` のメッセージは「同意」「API キー」「local-ollama に逃げる」を
1 つの壁に詰め込んでおり読みにくい。

### P7. 用語が半分だけマイグレーションされている

`createCursorJudge`（→ `createOpenAiCompatibleJudge`）、`resolveCursorModel`、
`DEFAULT_JUDGE_CURSOR_COMPOSER` など `@deprecated` エイリアスが残存
（[judge.ts:315](../../src/core/verdict/judge.ts),
[judge-factory.ts:62](../../src/core/verdict/judge-factory.ts),
[config.ts:130](../../src/core/config.ts)）。
"cursor" 由来の語彙と "openai-compatible" が混在し、config / ドキュメント / コードで呼称が揺れる。

### P8. 現状の状態が一目で分からない

現プロバイダ・モデル・キーの有無を確認する手段は `doctor`（重い実プローブ付き）か JSON 目視のみ。
軽量な「いま何が有効か」表示が無い。

---

## 3. 設計目標

1. **1 つの概念軸 = 1 つの名前**。ホストアダプタ名と judge プロバイダ名を完全分離する。
2. **切り替えは 1 コマンド・idempotent**。`judge` ブロックだけを安全に書き換える。
3. **自己ロックを解く**。Belay 自身による judge 切り替えはゲートを正規ルートで通す。
4. **失敗は切り替え時に前倒しで顕在化**。実行時 fail-closed に至る前に警告する。
5. **クラウド同意とモデル解決を可視・永続化**する。

---

## 4. 提案

### 4.1 プロバイダ語彙の再定義（P1, P5, P7）

ホスト名の借用をやめ、**LLM API プロバイダを正面から名指しする catalog** を導入する。
内部実体は引き続き `ollama` / `openai-compatible` の 2 ドライバだが、ユーザーに見せる名前は
プロバイダ・カタログのキーにする。

```ts
// 提案: src/core/verdict/judge-catalog.ts
interface JudgeProviderSpec {
  id: 'local' | 'openai' | 'cursor' | 'openrouter' | 'custom'
  driver: 'ollama' | 'openai-compatible'
  defaultEndpoint: string | null   // custom は null（必須入力）
  defaultModel: string             // 実在する具体モデル。'auto' は廃止 or 各 provider 固有に解決
  apiKeyEnvVars: string[]          // 例: ['OPENAI_API_KEY','BELAY_JUDGE_API_KEY']
  isCloud: boolean
}
```

| `id` | driver | defaultEndpoint | 既定 model | キー env |
|------|--------|-----------------|-----------|---------|
| `local` | ollama | `http://localhost:11434` | `gemma4:e2b` | （不要） |
| `openai` | openai-compatible | `https://api.openai.com/v1` | 実在の OpenAI モデル | `OPENAI_API_KEY` |
| `cursor` | openai-compatible | Cursor の実エンドポイント | `composer-2.5` | `CURSOR_API_KEY` |
| `openrouter` | openai-compatible | `https://openrouter.ai/api/v1` | 任意 | `OPENROUTER_API_KEY` |
| `custom` | openai-compatible | （null・必須） | （必須） | `BELAY_JUDGE_API_KEY` |

ポイント:
- **`--judge-profile` は廃止**（後方互換のため 1 マイナー版だけ deprecation 警告付きで受理し、
  `cursor/claude/codex` → 対応する真の provider へ写像 or エラーで明示誘導）。
- `model: "auto"` の魔法解決は廃止し、provider ごとの具体既定値に置換。env override は残してよいが
  既定は「名前から推測できる実在モデル」にする。
- config の `judge.provider` は **互換のため従来どおり driver 値**（`ollama` /
  `openai-compatible`）として保持し、新たに **`judge.providerId`** を追加して catalog id を持たせる
  （migration は §4.5）。既存 reader が `judge.provider` を読み続けても意味が壊れないことを優先する。

> スコープ注記: **v1 catalog には `anthropic` を含めない。**
> 現状 judge 実装は OpenAI Chat Completions 形状前提であり、Anthropic Messages API を直接扱うには
> 別の互換層が要る。将来追加するなら `providerId` の拡張として扱う。

### 4.2 第一級サブコマンド `belay judge`（P2, P8）

```
belay judge status                 # 現プロバイダ/モデル/endpoint/キー有無/解決モデルを表示（軽量）
belay judge list                   # catalog 一覧と各プロバイダの必要キー
belay judge use <provider-id>      # judge ブロックだけを idempotent に書換え
        [--model <id>] [--endpoint <url>] [--timeout <ms>] [--accept-cloud]
belay judge test                   # 現設定で dry-run（doctor の judge 部分を切り出し）
```

- `use` は **config の `judge` ブロックのみ**を書き換える。フック/ランタイム/スキルには触れない
  （init の副作用 P2 を回避）。
- 書き換え前後の **diff を表示**し、クラウド・ローカルの別、必要 env キーの有無を併記。
- 不足があれば即座に警告（§4.4）。

`status` 出力イメージ:

```
Judge provider : openai (cloud)
Endpoint       : https://api.openai.com/v1
Model          : gpt-4.1-mini        (resolved, requested: gpt-4.1-mini)
API key        : OPENAI_API_KEY  ✓ set
Cloud consent  : accepted 2026-06-15 (config.judge.cloudConsent)
Tier1 fallback : ask (fail-closed) — judge unreachable would block, not allow
```

### 4.3 自己ロックの解消（P3）★最重要

Belay が自分の judge 設定を変える操作を、ゲートが**正規の制御経路として**通せるようにする。
選択肢を比較し、推奨を示す:

| 案 | 内容 | 評価 |
|----|------|------|
| **A'（推奨）** | `belay judge use` を **CLI 内の限定ミューテーション経路**にし、repo config の `judge.*` と repo-local credential store だけを書けるようにする。一方で **cloud consent の付与だけは別境界**とし、対話 TTY の人間確認または `capability-approval` を必須にする。 | UX と安全性の折衷。二重ダンスを消しつつ、外部送信への同意はエージェント単独で完了できない。 |
| B | judge 切り替え全体を `capability-approval`（[capability-approval.ts](../../src/core/capability-approval.ts)）の専用ケイパビリティとして扱い、1 度の承認で完了。 | 監査痕跡は明快。ただしローカル Ollama への切替まで毎回承認になる。 |
| C | 現状維持＋ドキュメントで `/belay-approve` 手順を案内。 | パラドックス温存。非推奨。 |

推奨は **A'**。ただし「エージェントが belay CLI を騙って control-plane を書く」「勝手にクラウド送信へ同意する」
攻撃面を塞ぐため:
- 許可するのは **repo config の `judge.*` と repo-local credential store** のみ。
- それ以外の control-plane フィールド（gates/policy/mode 等）の書込は従来どおりブロックを維持。
- **`--accept-cloud` は非対話実行では効かない。** 対話 TTY なら人間に確認プロンプトを出し、エージェント経由なら
  `judge_cloud_consent` の capability-approval を要求する。
- 監査ログに `judge_provider_changed { from, to, by, ts }` と
  `judge_cloud_consent_recorded { providerId, endpoint, by, ts }` を必ず記録する。

これにより「LLM プロバイダの切替」という**低リスクで頻度のある操作**だけが解放され、ロック本体
（gates/policy）の改変は守られる。ローカル切替や既存同意済みクラウドへの変更では二重承認ダンスが消え、
新規クラウド同意だけは人間の明示確認が残る。

### 4.4 API キー & 同意を切り替え時に前倒し（P4, P6）

- `belay judge use <cloud-provider>` 実行時に **その場で**対応 env キーの有無を検査し、
  無ければ「このプロバイダは `OPENAI_API_KEY` が必要。未設定だと Tier1 は ask に倒れる」と**警告**
  （ブロックはしない＝設定自体は保存可、ただし状態を明示）。
- `--accept-cloud` は **人間が直接操作している対話 TTY** か、明示の capability-approval がある場合に限り
  有効化する。その条件を満たしたときだけ config に
  `judge.cloudConsent = { accepted: true, at: '<ISO>', providerId, endpoint, by }` を**永続化**する。
  次回以降は再同意不要。`status` に表示。同意なしでクラウド provider を選んだ場合は、設定保存自体は許すが
  `judge test` / 実行時に「未同意のため cloud judge は無効」と明示する。
- `CloudJudgeConsentRequiredError` のメッセージを「同意 / キー / ローカル退避」の 3 論点に分けて
  整形（現状は 1 段落に密結合）。

### 4.5 マイグレーション & 後方互換（P7）

- config 読込時、旧 `provider: "cursor"` は既に `openai-compatible` へ normalize 済み
  （[config.ts:436](../../src/core/config.ts)）。これに加え、**catalog id を推定**して
  `judge.providerId` を補完するレイヤを `normalizeJudgeConfig` に追加する。
  - 旧 endpoint が `api.openai.com` → `openai`、Cursor endpoint → `cursor`、それ以外 → `custom`。
  - `judge.provider` は旧来どおり driver 値のまま保持するため、旧 reader が新 config を読んでも
    `openai` を `ollama` に誤解釈する事故を防げる。
- `--judge-profile` / `createCursorJudge` / `resolveCursorModel` /
  `DEFAULT_JUDGE_CURSOR_COMPOSER` は 1 マイナー版 deprecation 警告 → 次メジャーで削除。
- ドキュメント（[config-schema.md](../config-schema.md), [README.md](../../README.md)）と
  `doctor` 文言を新語彙へ更新。

---

## 5. 影響範囲（実装時の着手点）

| 領域 | ファイル | 変更 |
|------|---------|------|
| catalog 新設 | `src/core/verdict/judge-catalog.ts`(新) | provider spec テーブル |
| 解決ロジック | `judge-config.ts`, `judge-factory.ts` | profile 廃止、catalog 経由解決、`auto` 撤去 |
| config 型/正規化/migration | `core/config.ts` | `judge.providerId`, `judge.cloudConsent`, `judge.credential` 追加、normalize 拡張 |
| CLI | `cli.ts` | `judge` サブコマンド（status/list/use/test）、`--judge-profile` deprecate |
| 自己ロック解除 | `classify-tool.ts`, `installer.ts`/新 `commands/judge.ts` | `judge.*` と repo-local credential store 限定の正規書込経路、cloud consent は人間確認付き |
| wizard | `commands/init-wizard.ts` | adapter と judge profile の連動を解除、provider を独立選択 |
| 診断 | `judge-doctor.ts` | `judge test` として切り出し、status と共通化 |
| キー/同意 | `judge-api-key.ts` | provider 別 env、同意永続化の参照 |
| docs | `config-schema.md`, `README.md`, `CONCEPT.md` | 新語彙・新コマンド |

---

## 6. 受け入れ基準（このリデザインが「UX 改善」と言える条件）

1. `belay judge use openai` で judge 切替が完了し、**`/belay-approve` の二重ダンスが不要**になる。
   ただし新規 cloud consent の初回付与だけは、対話 TTY の人間確認または 1 回の capability-approval を要求する
   （P3/P6 解消）。
2. プロバイダ名が実体と一致する：`openai`/`cursor`/`openrouter`/`custom` を選んで別プロバイダに飛ばない
   （P1 解消）。
3. キー未設定・endpoint 欠落・モデル未取得は**切り替え時点で警告**され、実行時に初めて気づく状況が
   なくなる（P4 解消）。
4. `belay judge status` で現在の provider/model(解決値)/key/consent が 1 画面で分かる（P8 解消）。
5. 既存 config（v4, `provider: cursor`）が無改変で読め、警告付きで新語彙へ誘導される。新 config を旧 reader が
   読んでも `judge.provider` の意味は壊れない（P7/互換）。

---

## 7. 未決事項（要確認）

- cloud consent を「対話 TTY の確認」と「capability-approval」のどちらで表現するか。
  あるいは両対応にするか。セキュリティモデル上の許容を CONCEPT/ADR と突き合わせる必要あり。
- API キーを env のみとするか、control-plane dir 配下のキーファイルも許容するか（保存=漏洩面の
  トレードオフ）。
- `model: "auto"` を完全廃止するか、provider 別 `auto`（catalog 既定へ解決）として温存するか。

---

## 8. 認証情報の指定方法 ——「API キー指定」と「プロジェクト設定を使う」（追加要件）

> 要件: 設定をもっと簡易にし、judge のキー解決を **(1) API キーを指定する方法** と
> **(2) プロジェクト設定を使う方法** からユーザーに選ばせたい。これは技術的に可能か。

### 8.1 現状の事実（調査結果）

- judge のキーは **env のみ**から解決される：`BELAY_JUDGE_API_KEY` → `OPENAI_API_KEY` の順
  （[judge-api-key.ts:1-14](../../src/core/judge-api-key.ts)）。config には**一切保存されない**。
- belay は**ホスト（Cursor/Claude/Codex）の資格情報を一切読んでいない**。アダプタが触るのは
  hooks 設定（`.cursor/hooks.json` / `.claude/settings.json` / `.codex/config.toml`）と belay 自身の
  config だけで、ホストの API キー/認証ストアにはアクセスしない
  （[layouts/*.ts](../../src/adapters/layouts/)）。
- config は層構造を持つ：`builtin → team(agent-belay/team.config.json, 共有) → repo(.cursor/belay.config.json) → protected`
  （[config-layers.ts:6-93](../../src/core/config-layers.ts)）。
  **repo config は gitignore 推奨のローカル成果物**（[README.md:281-297](../../README.md)）、
  **team config は共有**。→ **秘密は team 層に置けない。repo 層もコミットされうるため理想ではない。**

### 8.2 「プロジェクト設定を使う」が技術的に指せるもの — ホスト別の実現可能性

「プロジェクト設定（=ホスト/プロジェクトが既に持つ認証）を流用する」が成立するかはホストで異なる。
正直な可否判定：

| 流用元 | 形態 | belay から使えるか | 判定 |
|--------|------|-------------------|------|
| **環境変数**（シェル/プロジェクトの env、direnv、CI secret 等） | `OPENAI_API_KEY` 等の平文キー | そのまま読める。移植性◎、ホスト非依存 | ✅ **完全に可能**（既に部分実装） |
| **Codex** `~/.codex/auth.json` | API キー モード = 平文キー | ファイルを読めば取得可 | ⚠️ 可能だが要 opt-in（後述） |
| Codex `~/.codex/auth.json` | ChatGPT OAuth モード | サブスク用 OAuth トークン。直叩き API キーではない | ❌ 直接 API には不可・非サポート |
| **Claude Code** | `ANTHROPIC_API_KEY` env | env 経由 = ✅（上段と同じ） | ✅ |
| Claude Code | `~/.claude/.credentials.json` / Keychain の OAuth トークン | claude.ai サブスク用トークン。API 形式が異なり ToS 上もグレー | ❌ 非推奨・非サポート |
| **Cursor** | アプリ内 DB に暗号化保存 / 借用可能なローカル endpoint なし | 読み取り経路が無い | ❌ 不可 |

**結論:** 「プロジェクト設定を使う」を**移植性のある形で確実に実装できるのは「環境変数からの継承」**。
OAuth サブスクリプショントークンの流用（Cursor 全般・Claude/Codex の OAuth モード）は
**技術的に不可 or 非サポート/ToS リスク**であり、設計には含めない。Codex の平文キーモードのみ
「ホストファイル読込」をオプションで足す余地がある。

### 8.3 設計 — `judge.credential`（2 モードの discriminated union）

config の `judge` に **資格情報ソース**を表す `credential` を追加。秘密値そのものは
**原則 config に書かない**（§8.1 の層構造より team/repo どちらも不適）。

```jsonc
"judge": {
  "provider": "openai-compatible", // driver（既存互換）
  "providerId": "openai",          // §4.1 catalog
  "model": "gpt-4.1-mini",
  "endpoint": "https://api.openai.com/v1",
  "credential": {
    // --- モード(2): プロジェクト設定を使う（既定・推奨）---
    "mode": "project"
    // env チェーンから解決。belay は何も保存しない。
    // 解決順: BELAY_JUDGE_API_KEY → <provider 既定 env, 例 OPENAI_API_KEY>
    //         → (opt-in 時のみ) ホスト平文キーファイル
  }
}
```

```jsonc
  "credential": {
    // --- モード(1): API キーを指定する ---
    "mode": "apiKey",
    "ref": "store:judge"     // 値は config 外の専用ストアに保存（下記）
    // もしくは "ref": "env:MY_CUSTOM_KEY" で参照する env 名を明示
  }
```

**`mode: "apiKey"` の保存先**（コミット/共有事故を防ぐため config 本体には書かない）:
- 第一候補: **repo-local state dir 配下の専用ストア** `(.cursor|.claude|.codex)/belay/credentials.json`
  — 既に `.cursor/belay/` ごと gitignore 推奨済み（[README.md:284](../../README.md)）。`chmod 600`。
  このストアへの read/write は §4.3 の**限定ミューテーション経路**でのみ許可する。
- env 名参照（`env:NAME`）も許可 = 実質モード(2)の明示版。
- インライン平文（`credential.key`）は**受理はするが強警告**（disk 平文・コミット事故面）。team 層に
  現れた場合は**ロード時に拒否**。

**解決の優先順位（両モード共存を安全に）:**
`mode:"apiKey"` のストア/env 参照 → （無ければ）`BELAY_JUDGE_API_KEY` → provider 既定 env。
`mode:"project"` では apiKey ストアを参照せず env チェーンのみ。

### 8.4 CLI（§4.2 の `judge use` を拡張、簡易化）

```bash
# (2) プロジェクト設定を使う ＝ env から継承（何も保存しない）
belay judge use openai --credential project

# (1) API キーを指定（標準入力で受け取り、ローカル 0600 ストアへ書く）
belay judge use openai --credential apiKey --key-stdin
#   → プロンプトせず stdin から読む。argv に置かない＝シェル履歴/プロセス一覧/audit に残さない

# env 名を明示参照（保存しない）
belay judge use openai --credential apiKey --key-env MY_OPENAI_KEY
```

- **キーを argv で渡させない**（`--key <value>` は提供しない）。stdin か env 参照のみ。audit/scrub に
  鍵が漏れないことを保証する（既存 scrub と整合）。
- `belay judge status` はモードと**解決ソース名・キー有無**のみ表示し、**鍵値は絶対に出さない**:
  ```
  Credential : project (env)  →  OPENAI_API_KEY ✓ set
  Credential : apiKey (store) →  .cursor/belay/credentials.json ✓ present (0600)
  ```

### 8.5 wizard（簡易化の要）

provider 選択の直後に 1 問だけ足す（§4.1 で adapter 連動は解除済み）:

```
Judge provider [local | openai | cursor | openrouter | custom] (local):
How to provide credentials? [project (use env) | apiKey (enter a key)] (project):
  └─ apiKey 選択時のみ: Paste API key (hidden):   ← stdin、ストアへ保存
```

local(ollama) を選んだ場合はこの質問自体をスキップ（キー不要）。

### 8.6 ホストキーファイル読込（後続拡張 — 初版スコープ外と決定）

**決定: 初版には含めず、後続拡張とする。** 初版の `mode:"project"` は **env チェーンのみ**で解決し、
ホストの平文キーファイルは読まない（安全側既定）。

後続で「プロジェクト設定を使う」を広げる際にのみ、`mode:"project"` の解決チェーン末尾へ
**Codex `~/.codex/auth.json` の API キーモード**読込を **opt-in**（`credential.allowHostFile: true`）で追加する。
Cursor（暗号化）・OAuth トークン類は §8.2 の通り恒久的に対象外。

初版で `credential.allowHostFile` は **未実装（受理しない／無視）**とし、スキーマだけ将来枠として予約する。

### 8.7 実現可能性まとめ（要件への直接回答）

| 要件 | 可否 | 方式 |
|------|------|------|
| (1) API キーを指定する | ✅ 可能 | stdin → repo-local 0600 ストア。または env 名参照。config 本体・team 層には保存しない |
| (2) プロジェクト設定を使う | ✅ 可能（env 継承として） | provider 別 env チェーンから解決、belay は無保存 |
| (2') ホストの認証を借用（Cursor/OAuth） | ❌ 不可/非サポート | 暗号化ストア・サブスク OAuth は直接 API に流用不可。設計に含めない |
| (2'') Codex 平文キーファイル流用 | ⏭ 後続拡張（初版スコープ外と決定） | opt-in で実装、§8.6 |

→ ユーザーが求める 2 択（API キー指定 / プロジェクト設定を使う）は **両方とも技術的に実装可能**。
ただし「プロジェクト設定」の実体は **環境変数の継承**として定義するのが移植性・安全性の点で唯一健全。
ホスト資格情報の直接借用は Cursor 不可・OAuth 非サポートのため、設計の中心には据えない。

### 8.8 §5 への追加実装ポイント（当時の案 — 多くは実装済み）

| 領域 | ファイル | 変更 | 状態 |
|------|---------|------|------|
| 資格情報解決 | `judge-api-key.ts` | `credential` を解釈：mode 別の解決チェーン、provider 別 env、ストア読込 | ✅ |
| 専用ストア | `core/credential-store.ts` | repo-local `credentials.json`(0600) | ✅ |
| config 型 | `core/config.ts` | `judge.providerId`, `judge.credential` | ✅ |
| CLI | `cli.ts` / `commands/judge.ts` | `--credential` `--key-stdin` `--key-env`、status のソース表示 | ✅ |
| 主設定 UI | `commands/config.ts` | `init-wizard` 代替、対話 setup | ✅（wizard 行は superseded） |
| model discovery | `judge-model-discovery.ts` | live 照合 | ✅（parity follow-up 残） |
| CLI transport | `verdict/judge-cli.ts` | codex/cursor/claude native judge | ✅ |
