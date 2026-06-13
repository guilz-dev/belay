# agent-belay SPEC v2.1.1 — cloud judge の正直化・v0.3 残渣撤去・計測/隔離の堅牢化

Status: Draft（spec-first。実装前のレビュー用）
Supersedes: SPEC-v2.1 の一部（R16 の `cursor` 実装、R17 の配布既定）
Builds on: SPEC-v2.1（judge provider 抽象 / config v4 / R19 同意 / R23 redaction）

## Summary

v2.1 で judge provider を抽象化したが、cloud 側の標準実装 `cursor` は
`https://api.cursor.com/v1/chat/completions` を前提にしており、この endpoint は
**実在しない**（api.cursor.com は Cloud Agents `/v1/agents` のみ）。現状は
fail-closed なので安全側に倒れるが、cloud judge は実質非機能で、かつ「Cursor が
chat-completions API を持っているかのような」誤った物語を SPEC に固定してしまっている。

v2.1.1 は次を行う:

1. **cloud provider を正直にする** — `cursor` 専用を撤回し、OpenAI 互換エンドポイント
   汎用 provider に再定義する。endpoint は必須・既定 base は撤去。
2. **v0.3 の OQ3 / control-plane spike を完全撤去する** — doctor からは v2.1.1 直前の
   コミットで隠したが、機能自体は 12 ファイルに配線が残っている。Phase 3 を完了する。
3. **テスト隔離を堅牢化する** — 承認ラウンドトリップ系の順序依存フレークを除去し、
   フルスイートを決定的に緑にする。
4. **Tier1 精度計測ハーネスを整える** — 非ゲートの `v2/llm` を「床（復元可能性）」の
   継続検証として測定レポート化する。

安全契約（R1〜R14, catastrophic-first / FN=0）と Tier0/Tier1 の分業は**一切変更しない**。
本リリースは provider 表層・撤去・計測・隔離のみを対象とし、判定ロジックには触れない。

## 規範上の位置づけ（CONCEPT v2.0 / SPEC-v2.1 との関係）

1. **安全契約**（R1〜R14）は常に最優先。本 SPEC はこれを緩めない。
2. v2.1 の WS-E（provider 抽象・config v4・R19・R23）は維持。R16/R17 の cloud 部分のみ
   R24〜R27 で置換する。
3. **同意なし既定は `local-ollama` のまま**（M2 サイレント egress 禁止 / R19）。
   cloud は常に明示オプトイン。v2.1.1 はこの不変条件を強化こそすれ緩めない。

## 非ゴール

- 判定ロジック（Tier0 決定論 / Tier1 三値 boolean / wrapper 剥がし / launcher 解決）の変更。
- 特定 cloud ベンダー（OpenAI / Cursor / Anthropic 等）への結線・依存追加。本 SPEC は
  **契約（OpenAI 互換 chat-completions）** のみを規定し、宛先は利用者が指定する。
- 新しい承認 UX や skill コマンドの実装（WS-J は v2.2 候補として意図のみ記載）。

---

## v2.1.1 で追加/変更するワークストリーム

### WS-F — cloud provider の正直化（OpenAI 互換）
### WS-G — v0.3 OQ3 / control-plane の完全撤去
### WS-H — テスト隔離の堅牢化
### WS-I — Tier1 精度計測ハーネス
### WS-J —（v2.2 候補）Cursor skill としての呼び出し UX

---

## WS-F — cloud provider の正直化

### R24 — provider `cursor` を `openai-compatible` に再定義する（R16 cloud 部分を置換）

top-level `judge.provider` が受け付ける値を次へ変更する:

- `ollama`（変更なし）: ローカル Ollama 経由で Tier1 を実行
- `openai-compatible`（**新**）: OpenAI Chat Completions 契約に準拠した任意の
  エンドポイント経由で Tier1 を実行
- `cursor`: **廃止予定エイリアス**。設定に現れた場合は `openai-compatible` として
  扱い、endpoint 未指定なら R25 によりエラー（M4 参照）

`openai-compatible` 実装の要件:

- POST `${endpoint}/chat/completions`、`Authorization: Bearer ${apiKey}`、
  OpenAI chat 形式の request/response を用いる
- JSON 構造化出力（Tier1 三値 boolean）を強制し、parse 不能時は fallback（`ask`）へ倒す
- 解決後の model ID を `judgeModelResolved` として監査に記録する
- outbound 送信前に **R23 の redaction を必ず適用**する（cloud egress の不変条件）
- R19 の cloud 同意（`--accept-cloud-judge`）が無ければ起動時に
  `CloudJudgeConsentRequiredError` で停止する

根拠: api.cursor.com に chat-completions API は存在しない。Cursor 専用を装うより、
契約（OpenAI 互換）だけを規定し宛先を利用者に委ねる方が、正直で再利用可能（OpenAI /
vLLM / LiteLLM / Together / 自前プロキシ等いずれも指せる）かつ閉域要件とも両立する。

### R25 — endpoint を必須化し、既定 base を撤去する

- `openai-compatible` は `judge.endpoint` を**必須**とする。未指定での init / 起動は
  明示エラー（黙って既定 base に落とさない）。
- judge.ts の `DEFAULT_CURSOR_API_BASE`（`https://api.cursor.com/v1`）を削除する。
- ベンダー名を埋め込んだ難読化（`https://api.${'cursor'}.com/v1`）も削除する。

### R26 — API key は環境変数のみ、config に保存しない

- API key は env から読む。既定参照名を `BELAY_JUDGE_API_KEY` とし、後方互換で
  `OPENAI_API_KEY` も許容してよい（順位は実装で固定し、doctor で表示）。
- key が config ファイルや audit に**書き込まれないこと**を不変条件とする（R23 と整合）。
- key 不在時は fail-closed（`ask`）へ倒し、doctor で「cloud judge: key 未設定」を警告する。

### R27 — 配布既定 `cursor-composer` を撤回する（R17 配布既定を置換）

- 「配布既定 = cursor-composer」を削除する。新規 `init` の**同意なし既定は
  `local-ollama`**（R19/M2）。
- cloud を使う場合は明示オプトインのみ:
  `init --judge-provider openai-compatible --judge-endpoint <url> --accept-cloud-judge`。
- `local-ollama` プロファイル（provider=ollama / model=gemma4:e2b /
  endpoint=http://localhost:11434 / timeoutMs=25000 / keepAlive=30m）は据え置き。

---

## WS-G — v0.3 OQ3 / control-plane の完全撤去

### R28 — OQ3 spike / control-plane isolation の機能を撤去する

背景: v2.1.1 直前のコミットで doctor の OQ3 診断は撤去したが、`oq3Spike` /
`spikeOnPrompt` / control-plane spike / isolation の配線は以下に残存:
`src/cli.ts` `src/types.ts` `src/core/control-plane-spike.ts`
`src/core/control-plane-isolation.ts` `src/operational-insights.ts`
`src/core/config.ts` `src/adapters/cursor/runtime-entry.ts`
`src/adapters/claude/runtime-entry.ts` `src/adapters/shared/gate-runtime.ts`
`src/commands/doctor.ts` `src/commands/dogfood.ts` `src/commands/status.ts`
（`control-plane-isolation.ts` は `src/services/sandbox-service.ts` がまだ参照）。

要件:

- `spikeOnPrompt` 設定フィールド・`oq3Spike` 型・control-plane spike の読み書き・
  関連 CLI フラグ/notes/warnings を削除する。
- `control-plane-isolation` は `sandbox-service` の利用実態を確認したうえで、
  Tier0/Tier1 と独立した「保護ルート（protectedArtifactRoots）」へ役割を一本化するか、
  完全撤去するかを決める（撤去が既定方針。sandbox-service が真に必要とする最小機能のみ
  残す）。
- config の version を上げずに（v4 内で）後方互換移行する（M4 参照）。未知フィールドは
  読み飛ばし、書き戻し時に落とす。

非ゴール: 撤去は**機能削除のみ**で、新しい isolation/sandbox 機能は追加しない。

---

## WS-H — テスト隔離の堅牢化

### R29 — 承認ストアをテストごとに分離し、フルスイートを決定的に緑にする

観測: 単独実行では緑だが、フルスイートでまれに
`cli-ops > status and revoke` と `conformance/adapters > approval roundtrip` が
順序依存で落ちる（承認/保留の状態がテスト間で共有される疑い）。

要件:

- 承認（pending/approved）の保存先・読み取り元が、テストごとに分離された temp dir に
  解決されること。グローバル `~/.config` / 既定 control-plane dir への暗黙フォールバックを
  テスト経路から排除する。
- judge factory 等のモジュール級キャッシュ（`cachedPinnedModels` 等）が
  テスト間状態を汚染しないこと（必要なら reset 経路を用意）。
- CI で `vitest run` を**連続 N 回**（N≥3）実行し、すべて緑であることをゲート化する。

---

## WS-I — Tier1 精度計測ハーネス

### R30 — 「床（復元可能性）」の継続検証を測定レポート化する（非ゲート）

- 非ゲートの `v2/llm`（`describe.skipIf(!hasOllama)`）を、固定コーパスに対する
  Tier1 三値 boolean の精度・取りこぼし（FN）・過剰停止（FP）を**測定し記録**する
  形へ拡張する。
- 出力はレポート（JSON/markdown）として保存し、ゲートにはしない（理念既定の
  `local-ollama` を回したときのみ走る）。
- bypass-equivalence の核（catastrophe core × wrapper）を再利用し、構造スイート
  （FN=0 ハードゲート）との役割境界を維持する: 構造=硬い床、LLM=計測。
- 目的は「床が時間とともに劣化していないか」を dogfood で裏付けること。出荷ゲートでは
  ない。

---

## WS-J —（v2.2 候補）Cursor skill としての呼び出し UX

> 本ワークストリームは **意図の記録のみ**。実装は v2.2 で再評価する。v2.1.1 では着手しない。

動機: 現状 belay は hook（before-submit / shell-gate / tool-gate / audit）として
主に働くが、`.cursor/skills/belay` の SKILL としても配布される。skill として明示的に
呼び出されたときに「何ができるか」を設計し、UX を高めたい。

検討メモ（決定ではない）:

- `/belay why <command>` — 直近 or 任意コマンドの verdict（location/opacity/effect/
  permission と reason、Tier0/Tier1 のどちらが決めたか、judgeTrace）を人間可読に説明する。
- `/belay explain` — 直近に停止（ask）した判断の根拠と、承認/却下の選択肢を提示する。
- `/belay status` — judge provider（ollama / openai-compatible）、同意状態、
  model 解決結果、dogfood 稼働を一覧する。
- skill から呼んだときも**判定ロジックは hook 経路と同一**であること（二重実装禁止）。

v2.2 で行う理由: UX 設計は判定コアの安定（v2.1.1 で表層と残渣を整理した後）を前提に
すべきで、本リリースのスコープ（正直化・撤去・計測・隔離）とは独立に評価したい。

---

## Config Contract（v2.1.1 差分）

version は **4 のまま**（破壊的スキーマ変更なし。provider 値の追加と既定の撤回のみ）。

```json
// 同意なし既定（変更なし）: local-ollama
{
  "version": 4,
  "judge": {
    "provider": "ollama",
    "model": "gemma4:e2b",
    "endpoint": "http://localhost:11434",
    "timeoutMs": 25000,
    "keepAlive": "30m"
  }
}
```

```json
// cloud オプトイン（新）: openai-compatible（endpoint 必須・key は env）
{
  "version": 4,
  "judge": {
    "provider": "openai-compatible",
    "model": "auto",
    "endpoint": "https://api.openai.com/v1",
    "timeoutMs": 8000
  }
}
```

| field | 値 | 既定 | 備考 |
| --- | --- | --- | --- |
| `judge.provider` | `"ollama"` \| `"openai-compatible"` | `ollama`（理念既定） | `openai-compatible` は `--accept-cloud-judge` 明示時のみ（M2/R19） |
| `judge.endpoint` | URL | ollama=`http://localhost:11434` | `openai-compatible` では**必須**・既定 base なし（R25） |
| `judge.model` | string \| `"auto"` | ollama=`gemma4:e2b` | `auto` は CI ゲートに使わない |
| (API key) | — | — | config に保存しない。env `BELAY_JUDGE_API_KEY`（R26） |
| `judge.provider="cursor"` | 廃止予定 | — | 読み込み時 `openai-compatible` として扱う（M4） |

---

## 互換性と移行

### M4 — config v4 内での移行（version は上げない）

- `judge.provider="cursor"` を読み込んだ場合: `openai-compatible` として解釈し、
  `endpoint` が無ければ R25 によりエラー（cloud は明示設定を要求）。書き戻し時に
  provider 値を `openai-compatible` へ正規化する。
- `spikeOnPrompt` / control-plane 系の未知フィールドは読み飛ばし、書き戻しで落とす（R28）。
- v2.1 の `local-ollama` 設定はそのまま有効。

---

## テスト要件（v2.1.1 追加）

### T15 — openai-compatible provider parity（DI fetch stub・CI ゲート）
- fetch を DI スタブ化し、scrub→POST→parse→三値 boolean の往復を検証。
- endpoint 必須（未指定でエラー）、key 不在で fail-closed（`ask`）、parse 不能で `ask`。

### T16 — no default base / no vendor leak
- `DEFAULT_CURSOR_API_BASE` および api.cursor.com 参照がコードから消えていること。
- `openai-compatible` で endpoint 未指定の init/起動が明示エラーになること。

### T17 — 撤去の確認（OQ3 / control-plane）
- `spikeOnPrompt` / `oq3Spike` を含む設定を読み込んでもエラーにならず、書き戻しで
  落ちること。doctor が OQ3/isolation の notes/warnings を一切返さないこと。

### T18 — full-suite isolation（連続実行ゲート）
- `vitest run` を連続 3 回実行し、すべて緑（承認ラウンドトリップ系の順序依存フレーク無し）。

### T19 — accuracy harness（非ゲート・Ollama 必須）
- `skipIf(!hasOllama)` 下で固定コーパスに対する精度/FN/FP を測定しレポート出力。
  ゲートにはしない。

---

## 出荷判定（v2.1.1 Done の定義）

1. R1〜R14（安全契約・FN=0 構造スイート）が緑のまま。
2. cloud provider が `openai-compatible` に再定義され、既定 base・ベンダー難読化が
   コードから消え、endpoint 必須・key=env・R23/R19 が効いている（T15/T16）。
3. OQ3 / control-plane spike の配線が撤去され、移行が後方互換（T17）。
4. フルスイートが連続実行で決定的に緑（T18）。
5. 精度計測ハーネスがレポートを出す（非ゲート、T19）。
6. **docs が provider 契約に追従**: README / SKILL.md の judge 記述が新モデル
   （`ollama` 既定 / `openai-compatible` オプトイン / cloud は `--accept-cloud-judge`）を
   反映し、config 版表記の stale（現 README「migrate to v3」）を **v4** に修正する。
   spec はこの**受け入れ基準のみ**を規定し、README 文面そのものは持たない。
7. WS-J は未着手（v2.2 候補として本 SPEC に意図のみ記録）。

### R30.1 — docs-as-artifact の受け入れ基準（spec は文面を持たない）
- 本 SPEC は「README / SKILL.md / marketplace 説明が満たすべき契約」を出荷判定として
  規定するが、prose は spec に書かない（spec-first を保ちつつ doc 肥大を避ける）。
- v2.1.1 で更新が要る既知の stale: ① config 版表記（v3→v4）、② judge provider の不在
  （ollama 既定 / openai-compatible / consent）。

## 備考

- 本 SPEC は「正直化・撤去・計測・隔離」のリリース。判定の床（restorability floor）には
  触れない。新しい停止・新しい緩和のいずれも導入しない。
- cloud は常にオプトイン。同意なし既定は `local-ollama` を堅持する。
