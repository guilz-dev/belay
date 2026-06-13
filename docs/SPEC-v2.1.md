# agent-belay SPEC v2.1 — Cursor Skill 配布向け judge provider 拡張

> 規範:
> [`CONCEPT-v2.0.md`](./CONCEPT-v2.0.md)、
> [`SPEC-v2.0.md`](./SPEC-v2.0.md)、
> [`IMPLEMENTATION-PLAN-v2.md`](./IMPLEMENTATION-PLAN-v2.md)。
>
> v2.1 は v2.0 の契約を置換しない。**Tier0/Tier1/fallback の合成規則と
> catastrophic-first の床は据え置き**であり、変更点は
> 「Tier1 judge の provider 選択」「配布時セットアップ導線」「config v4 の
> `judge` フィールド」のみである。
>
> Status: Draft

## Summary

v2.1 の目的は、Cursor Skill としての導入体験を改善しつつ、v2.0 の safety contract を
壊さないこと。

具体的には次を追加する:

1. Tier1 judge の provider 抽象化(`cursor` / `ollama`)
2. Skill 配布時の**配布既定**プロファイル `cursor-composer` の定義
3. 推奨モデル `auto`(= Composer 最新系へ追従)のサポート
4. `init` セットアップと `doctor` 診断の provider aware 拡張
5. config `version: 4` と top-level `judge` フィールド
6. cloud judge 向け outbound redaction 契約

この変更は「model を強くする」だけの話ではない。v2.1 の要件は、
**平坦な 3 boolean 問い**と **Tier0 による構造判断の優先**を保ったまま、
Tier1 の実行先だけを差し替え可能にすることにある。

---

## 規範上の位置づけ（CONCEPT v2.0 との関係）

`CONCEPT-v2.0` §4 は **理念既定(principle default)** としてローカル LLM
(`gemma4:e2b`) を採る理由を述べる:

- エグレスゼロ
- プライバシー
- API キー不要

v2.1 はこれを否定しない。追加するのは **配布既定(distribution default)** の層だけである。

| 用語 | 意味 | v2.1 での値 |
|------|------|-------------|
| **理念既定** | 閉域・プライバシー・エグレスゼロを最優先する運用の推奨 | `local-ollama` (`gemma4:e2b`) |
| **配布既定** | Cursor Skill 経由の新規導入で最初に提示する選択肢 | `cursor-composer` (`model: auto`) |

優先規則:

1. **安全契約**(R1〜R14, catastrophic-first)は常に最優先
2. **理念既定**は閉域要件の説明・`doctor` 警告・`local-ollama` プロファイルで体現
3. **配布既定**は `init` の初期選択肢であり、利用者が明示的に選んだ provider を上書きしない
4. `CONCEPT-v2.0` と衝突する場合、**安全契約 > 理念既定 > 配布既定**の順で解釈する

cloud judge は「正しい唯一解」ではなく、**導入摩擦を下げるオプション**として位置づける。

---

## 非ゴール

- v2.0 の `allow|ask` 合成規則を変えること
- Tier0 の責務(git remote, path containment, high-stakes path)を Tier1 に戻すこと
- Cursor cloud を唯一の実装として固定すること
- Skill 単体インストールだけで runtime gate 有効化まで完結させること
- `policy.modelAssist`(v1 系)を Tier1 judge の代替として流用すること

---

## v2.1 で追加するワークストリーム

### WS-E — Judge Provider & Setup UX

**狙い:** 配布経路に応じた「使える初期値」を提供し、導入直後の
judge unavailable / cold setup 由来ノイズを減らす。

### R15 — Tier1 judge は provider 抽象で呼び出す

Tier1 呼び出しは次の論理 IF を実装する:

```ts
interface Tier1Judge {
  evaluate(input: {
    text: string
    context: { cwd: string; repoRoot: string }
  }): Promise<{
    external_change: boolean
    destroys_outside_repo: boolean
    destroys_history_or_secrets: boolean
    reason: string
  }>
}
```

必須条件:

- 返却スキーマは v2.0 の 3 boolean + reason から変更しない
- provider 差し替えで判定軸を増減させない
- uncertain は `true` へ倒す(fail-closed)

### R16 — provider は `cursor` と `ollama` を標準実装とする

top-level `judge.provider` は少なくとも次を受け付ける:

- `cursor`: Cursor API/SDK 経由で Tier1 を実行
- `ollama`: ローカル Ollama 経由で Tier1 を実行

`cursor` 実装の要件:

- API key は `CURSOR_API_KEY` を既定参照
- model 指定 `auto` を許容する
- `auto` は「そのアカウントで解決される Composer 最新系」を意味する
- 解決後の model ID は `judgeModelResolved` として監査に記録する
- JSON 構造化出力を強制し、parse 不能時は fallback(`ask`)へ倒す
- outbound 送信前に R23 の redaction を必ず適用する

`ollama` 実装の要件:

- endpoint 既定 `http://localhost:11434`
- model 未指定時の既定は `gemma4:e2b`(理念既定)
- keep-alive/timeout を設定可能にする

### R17 — プロファイル `cursor-composer` と `local-ollama` を定義する

**配布既定** `cursor-composer`:

```json
{
  "version": 4,
  "judge": {
    "provider": "cursor",
    "model": "auto",
    "timeoutMs": 8000
  }
}
```

**理念既定** `local-ollama`:

```json
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

意味:

- `model: "auto"` は固定 pin ではなく最新系追従。**CI ゲートには使わない**(T10 参照)
- `composer-2.5` 等の pin はオプションで上書き可能
- 新規 `init` は配布既定を**最初に提示**するが、閉域要件を示す利用者には
  `local-ollama` を同格で選べる

### R18 — セットアップは対話/非対話の両方を提供する

`init` は次の入力経路を持つ:

- 対話: profile 選択(`cursor-composer` / `local-ollama`)
- 非対話: フラグで明示

最小フラグ:

- `--judge-profile <cursor-composer|local-ollama>`
- `--judge-provider <cursor|ollama>`
- `--judge-model <id|auto>`

優先順:

1. 明示フラグ
2. 既存 config の `judge`
3. 配布既定(`cursor-composer`)

`init` 完了時、書き込む config は **`version: 4` と top-level `judge` を含む**こと。

### R19 — Cloud judge 利用時の明示同意を要件化する

`judge.provider=cursor` を初回有効化する際、`init` は次を明示する:

- shell command が **R23 で redaction されたうえで** cloud 判定に送信されること
- 完全な秘匿は保証されないこと(パス構造・コマンド意図は残る)
- API key が必要なこと
- 理念既定 `local-ollama` へ切替可能なこと

同意が得られない場合は `local-ollama` を提案し、設定を書き込まず終了してよい。

### R20 — fallback 契約は provider 非依存で不変

以下はいずれの provider でも不変:

- timeout / network / parse error / auth error は `ask` 側へ倒す
- fallback reason は監査に記録する
- `allow` の条件は Tier0/Tier1 合成規則でのみ決まり、provider 種別で緩めない

### R21 — `doctor` は provider-specific な診断を返す

`doctor` は `judge.provider` に応じて次を診断する:

- `cursor`:
  - `CURSOR_API_KEY` の存在
  - model 解決可否(`auto` は解決先 ID を note に記録)
  - 最小 dry-run 判定の成功/失敗
  - cloud egress 有効である旨の warning(理念既定との差)
- `ollama`:
  - endpoint 到達性
  - 指定 model の存在
  - warm 呼び出し可否

診断結果は `issues` / `warnings` / `notes` へ分類し、`--fix` で可能な範囲を補助する。

### R22 — 監査スキーマに provider 情報を追加する

v2.1 では判定トレースへ次を追加する:

- `judgeProvider`: `cursor` | `ollama` | `fallback`
- `judgeModelRequested`: 例 `auto`, `gemma4:e2b`
- `judgeModelResolved`: 例 `composer-2.5`, `gemma4:e2b`
- `judgeLatencyMs`: number
- `judgeOutboundRedacted`: boolean (cloud 送信時に R23 を通したか)

禁止事項:

- API key / bearer token / 生 credential の永続化
- redaction 前コマンドの保存
- cloud 送信前の生コマンドを監査に残すこと

### R23 — cloud judge 向け outbound redaction

`judge.provider=cursor` で provider 境界を越える直前に、**監査 redaction と同系の
scrub パイプライン**を必ず通す。送信本文と監査記録で適用ルールを分けない。

#### 必ずマスクする

- bearer token / API key / `Authorization` ヘッダ相当
- `key=value` 形式の secret(`password`, `token`, `secret`, `api_key` 等)
- 高エントロピー文字列(既存 `redaction.maskHighEntropyStrings` が有効なら適用)
- `classifier.sensitivePaths` に一致するパス実体(`.env`, `*.pem`, `id_rsa` 等)
- approval ID / 署名トークン

#### 判定に必要なため保持する

- コマンド構造(verb, flags, subcommand)
- 相対/絶対パスの**ディレクトリ階層**(ファイル名は sensitive なら `[REDACTED]`)
- host / service 名(`postgres`, `s3`, `registry.npmjs.org` 等)
- HTTP メソッドと path テンプレート(`/api/v1/...`)

#### 原則

- **過剰マスクより漏洩を避ける**: 迷ったらマスクし、判定は fail-closed(`true`)へ倒す
- scrub 失敗時は cloud 送信せず fallback(`ask`)
- `judgeOutboundRedacted: true` は scrub 成功時のみ記録する

---

## Config Contract (v2.1)

v2 engine は config **`version: 4`** を使用する。`judge` は **top-level** フィールドとし、
v1 系 `policy.modelAssist` とは別物である。

**fresh `init` が consent 無しで書き込む既定は `local-ollama`**(理念既定)である。
`cursor-composer`(cloud)は `--accept-cloud-judge` を明示したとき**のみ**書き込まれる
(M2 サイレント egress 禁止 / R19)。下の JSON は `cursor-composer` プロファイル(consent
必須)の例であり、consent 無しの fresh 既定ではない。

```json
// cursor-composer プロファイル(--accept-cloud-judge 明示時のみ書き込まれる)
{
  "version": 4,
  "mode": "audit",
  "judge": {
    "provider": "cursor",
    "model": "auto",
    "timeoutMs": 8000,
    "endpoint": null,
    "keepAlive": null
  },
  "redaction": { "maskApprovalIds": true, "maskBearerTokens": true, "maskAuthHeaders": true, "maskKeyValueSecrets": true, "maskHighEntropyStrings": false }
}

// consent 無しの fresh 既定(local-ollama)
{
  "version": 4,
  "mode": "audit",
  "judge": { "provider": "ollama", "model": "gemma4:e2b", "endpoint": "http://localhost:11434", "timeoutMs": 25000, "keepAlive": "30m" }
}
```

| Field | Type | Default (fresh `init`, consent 無し) | Notes |
|-------|------|----------------------|-------|
| `version` | `4` | `4` | v2.1 以降必須 |
| `judge.provider` | `"cursor"` \| `"ollama"` | `ollama`(理念既定) | `cursor` は `--accept-cloud-judge` 明示時のみ(M2/R19) |
| `judge.model` | string \| `"auto"` | `gemma4:e2b` | `auto` は cursor のみ。`cursor-composer` 選択時は `auto` |
| `judge.timeoutMs` | number | `25000`(ollama)/ `8000`(cursor) | provider 別推奨値 |
| `judge.endpoint` | string \| null | `http://localhost:11434`(ollama) | cursor は `null`(→ `CURSOR_API_BASE` / 既定 base) |
| `judge.keepAlive` | string \| null | `30m`(ollama) | cursor は `null`(未使用) |

実装要件:

- `normalizeConfig` / `migrateConfig` は `version: 4` で `judge` を読み込む
- `judge` 未定義の v2.0 互換読み込み時のみ、理念既定 `ollama` + `gemma4:e2b` を合成してよい
- runtime は **`policy.modelAssist` を Tier1 judge に使わない**
- `init` は明示フラグで `cursor` を選んだ場合も `--accept-cloud-judge` 無しでは
  `CloudJudgeConsentRequiredError` で停止し、`cursor` config を書き込まない(M2/R19)

---

## 互換性と移行

### M1 — v2.0 互換の保持

既存 v2.0 実装で `judge` 未定義の場合:

- loader は理念既定(`ollama` + `gemma4:e2b`)を合成してよい
- 新規 Skill 導入フローでは配布既定 `cursor-composer` を**提示**する(自動適用は M2 に従う)

### M2 — サイレント egress の禁止

既存環境を migration する際、`ollama` から `cursor` へ
自動で切り替えてはならない。切替は明示操作(フラグまたは対話選択)のみ。

### M3 — config version 4 への移行

| 元 | 動作 |
|----|------|
| `version: 3` + `policy.modelAssist` | v2 engine では **無視**。`upgrade` 時に deprecation warning |
| `version: 3`、judge なし | `version: 4` へ bump し、理念既定 `judge` を書き込む(ollama) |
| 新規 `init --judge-profile cursor-composer` | `version: 4` + 配布既定 `judge` を書き込む |

`policy.modelAssist.enabled: true` を検出した場合:

- 自動で `judge.provider=cursor` に昇格してはならない(意味論が異なる)
- `doctor` は「v1 modelAssist は v2 Tier1 に未接続」と warning を出す

---

## テスト要件 (v2.1 追加)

### T10 — Provider parity suite（pin 固定・CI ゲート）

CI ハードゲートでは **resolved model を pin** する:

- `cursor`: 例 `composer-2.5`(リポジトリ内 `fixtures/judge-models.json` で管理)
- `ollama`: `gemma4:e2b`

同一コーパスに対し両 provider で次を検証:

- catastrophic 見逃し 0(FN=0)
- 差分は偽陽性率として別計測し、閾値逸脱時は警告

`model: auto` は **T10 の対象外**とする。

### T10b — Auto tracking suite（非ゲート・定期計測）

`model: auto` は別ジョブで計測のみ:

- 解決先 model ID を記録
- FN/F P を trend として保存
- 回帰検知時は issue 化するが、**merge をブロックしない**

### T11 — Setup matrix

`init` の組み合わせを検証:

- `--judge-profile cursor-composer` → `version: 4` + `judge.provider=cursor`
- `--judge-profile local-ollama` → `version: 4` + `judge.provider=ollama`
- 非対話フラグ優先
- 既存 config 優先
- 書き込み config が loader で正しく読めること(T10 前提)

### T12 — Doctor matrix

provider 別に「欠落時の診断が正しく fail-closed を案内する」ことを検証:

- key 欠落
- model 未解決
- endpoint 不達
- timeout
- `policy.modelAssist` 残存時の deprecation warning

### T13 — No silent loosen

provider 変更時でも次が不変であること:

- Tier0 高stakes path 判定
- fallback 時 `ask`
- 監査 redaction
- cloud 送信前 scrub 失敗時の fallback

### T14 — Outbound redaction suite

R23 に対し、少なくとも次を検証:

- token / `.env` 実体 / bearer が送信 payload に含まれない
- scrub 失敗時に cloud 送信されず `ask` へ倒れる
- 判定に必要な verb / host / メソッドは保持される

---

## 出荷判定

v2.1 を出荷可能とする最小条件:

1. v2.0 既存スイートが回帰しない
2. T10, T11, T12, T13, T14 が green
3. T10b は初回出荷時に 1 回以上計測記録があること(ゲート外)
4. `init --with-skill` で `cursor-composer` が選択可能
5. `doctor` が provider 別の復旧アクションを表示できる
6. `version: 4` config が `normalizeConfig` で正しく読み込まれること

---

## 備考

`cursor-composer` は**配布既定**であり、**理念既定**は `local-ollama` のままである。
v2.1 は「どちらが正しいか」を固定しない。固定するのは、**どの provider でも
catastrophic-first contract を崩さない**ことと、**cloud 利用時は egress と redaction を
利用者が明示的に選んだときだけ有効にする**こと。
