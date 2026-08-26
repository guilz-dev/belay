# Shell argv境界解析と構造化tokenの段階導入 Design

Date: 2026-08-26
Status: Approved in chat; pending written-spec review

## 背景

Belayのshell loweringは、`sh -c`のscript operandと`docker compose run`配下の
shell commandを再帰解析する。従来はquote除去後の`string[]`からscript flagを横断検索し、
過去にはscript以後のargvを再結合したことで閉じquoteを欠落させた。

直近修正はscript operandを1要素として保持することで既知事例を直したが、次の構造的な
弱点は残っている。

- shellとコードインタープリタが同じscript flag集合を共有している。
- script/file operandより後ろの`-c`や`-e`も再帰scriptとして誤認できる。
- Composeのservice／command境界を確定せず、`run`以後を横断検索している。
- tokenizerがquote、source span、空文字word、展開可能性を失う。
- unit testとDocker／LLM live testの実行境界が曖昧である。

一方、tokenizer、構造演算子分割、unparseable検出、substitution検出を単一parserへ
統合する変更は影響範囲が大きい。この統合は今回実施せず、独立した技術的負債として
Markdownを正本に記録する。

## 目標

1. インタープリタ固有のargv文法に従って、script operandを位置で確定する。
2. Composeの`run [OPTIONS] SERVICE [COMMAND] [ARGS...]`境界を保守的に解析する。
3. quoteと空文字wordを失わない構造化tokenizerを追加し、既存APIを互換維持する。
4. wrapper変換前後の認可厳格度が弱まらないことを性質テストで固定する。
5. unit testと外部substrate依存testを分離し、ローカルとCIのNode majorを揃える。
6. scanner統合の将来作業はローカルMarkdownだけを正本とし、GitHub Issueは索引にする。

## 非目標

- shell全体のAST構築
- 既存scannerの統合、置換、削除
- 未知shell構文を推測して許可すること
- command名、prefix、corpusを認可根拠にすること
- `sh -c "$CMD"`など実行時に決まるscriptを静的scriptとして扱うこと
- Docker Composeの全subcommandを解析すること

## 不変条件

- ADR-004に従い、EffectPlanだけをnormalized shell actionの認可入力とする。
- ADR-005に従い、インタープリタ名とCompose option表は構文選択にのみ使用し、
  command allowlistとして使用しない。
- 不明なoption、operand不足、動的script、深さ超過はfail-closedにする。
- ASK／`deny_pending_approval`対象をwrapper追加によってALLOWへ弱めない。
- 既存の公開`tokenizeShell(input): string[]`は維持する。

## 採用方式

### 1. 構造化lexerを互換APIの下に追加する

`src/core/shell-tokenizer.ts`へ、次の内部表現を追加する。

```ts
type ShellQuoteMode = 'unquoted' | 'single' | 'double'

interface ShellWordPart {
  value: string
  raw: string
  start: number
  end: number
  quote: ShellQuoteMode
  hasExpansion: boolean
}

type ShellToken =
  | {
      kind: 'word'
      value: string
      raw: string
      start: number
      end: number
      parts: ShellWordPart[]
    }
  | {
      kind: 'operator'
      value: string
      raw: string
      start: number
      end: number
    }

interface ShellLexResult {
  tokens: ShellToken[]
  complete: boolean
}
```

`lexShell(input)`を構造化APIとし、既存`tokenizeShell(input)`は
`lexShell(input).tokens.map(token => token.value)`として提供する。

wordはquoteされた空文字でも必ずemitする。escapeは次の保守的なPOSIX shell規則に
合わせる。

- unquotedのbackslashは次の1文字をliteralにする。
- single quote内のbackslashはliteralとして保持する。
- double quote内のbackslashは`$`、backtick、`"`、`\\`、newlineだけをescapeする。
- 閉じていないquoteまたは末尾backslashは`complete: false`にする。

`hasExpansion`はunquoted／double quote内の`$`またはbacktickを記録する。
single quote内の同じ文字はliteralである。今回この情報をscanner全体へ共有せず、
recursive invocation decoderだけが静的／動的境界の判定に使う。

### 2. recursive invocationをtyped resultで表す

`src/core/verdict/recursive-invocation.ts`を新設し、shell／code interpreterのargvを
個別profileで解釈する。

```ts
type RecursiveInvocation =
  | { kind: 'static'; interpreter: string; script: string }
  | { kind: 'dynamic'; interpreter: string; signal: string }
  | { kind: 'none' }
  | { kind: 'indeterminate'; interpreter: string; signal: string }
```

最低限サポートするscript optionは次のとおりとする。

- `bash`、`sh`、`zsh`、`dash`、`fish`: `-c`および`-lc`、`-ec`等の`c`を含む
  妥当なshort-option group
- `python`、`python3`: `-c`
- `node`: `-e`、`--eval`、`--eval=SCRIPT`
- `ruby`、`perl`、`osascript`: `-e`

script optionは最初のfile／positional operandより前にある場合だけ有効とする。
profileがoperand数を確定できない未知optionは`indeterminate`とする。script operandが
欠けた場合も`indeterminate`とし、空文字scriptは有効な`static` invocationとして表す。

script wordに展開可能なpartがあれば`dynamic`とし、内容を再帰loweringしない。
single-quoted`'$CMD'`はliteral、double-quoted`"$CMD"`はdynamicである。

既存の`extractRecursiveScript`、`isDynamicRecursiveEvaluation`、`isBareInterpreter`は
このtyped resultから導出し、判定ロジックを重複させない。外部互換のため既存exportは
維持する。

### 3. Compose runのargv境界を位置で解析する

`docker compose`と`docker-compose`の両形式を対象に、次の順序で解析する。

```text
docker compose [GLOBAL_OPTIONS] run [RUN_OPTIONS] SERVICE [COMMAND [ARGS...]]
```

global optionとrun optionは、Docker公式CLI referenceにあるoption名とoperand arityを
構文表として保持する。`--name=value`形式もarityに従って扱う。option表はEffectPlanや
PolicyDecisionを直接変更せず、service／command境界の決定にだけ使う。

- `run`以外のsubcommandは`none`。
- 未知option、値不足、service不足は`indeterminate`。
- service確定後の最初のwordだけをCOMMANDとする。
- COMMANDが対応shell interpreterの場合だけrecursive decoderへ渡す。
- COMMAND以後のargument内に現れる偶然の`sh -c`は再帰commandとして扱わない。

Compose invocationが`indeterminate`の場合、shell loweringは
`shell.compose_argv_indeterminate`を持つindeterminate requirementを生成する。

### 4. EffectPlanへの接続

`src/core/effect-ir/shell-lower.ts`は各segmentを`lexShell`し、既存のstring token経路と
recursive decoder用のstructured token経路を同じlex resultから得る。

- `static`: process spawnを記録し、空文字以外は深さを1増やして再帰loweringする。
- 空文字`static`: process spawnだけを記録し、完全なeffect-free scriptとして終了する。
- `dynamic`／`indeterminate`: process spawnとindeterminate requirementを記録する。
- `none`: 既存decoderへ処理を継続する。

旧scanner群の呼出し順序と責務は変更しない。structured tokenを他scannerへ横展開する
作業は技術的負債Issueの範囲とする。

### 5. 回帰防止テスト

固定ケースに加えて、次のdecision-diff／metamorphic matrixを追加する。

- base command
- `sh -c 'BASE'`
- 二重`sh -c`
- `docker compose run --rm SERVICE sh -c 'BASE'`

検証する性質は次のとおり。

- baseがASKならwrapper後もASK以上に厳しい。
- 対応可能な静的baseはnested EffectPlanを失わず、partialにならない。
- 動的、未知option、operand不足、壊れたquoteはindeterminateのまま。
- script以後の`-c`／`-e`をscript flagとして誤認しない。
- Composeのoption value、service、command argument内の`sh -c`をcommand境界と誤認しない。
- lowering depthの8／9、wrapper peel depthの32／33を明示的に固定する。
- `sh -c ''`、single quote内backslash、double quote内backslashを固定する。

テストは公開判定またはEffectPlanという利用者可視の結果を検証し、private helperの
存在だけを検査しない。

### 6. テスト実行境界とローカル環境

- 通常の`pnpm test`／`test:stable`から実Docker daemonとlive Ollamaに依存するtestを
  除外する。
- Docker testは`pnpm test:docker`、LLM accuracyは`pnpm test:llm`で明示実行する。
- fake Docker dependencyを使うunit testは通常suiteに残す。
- dedicated integration configを追加し、実process／Git／Docker testにだけ個別timeoutを
  設定する。unit suiteのglobal timeoutは延長しない。
- `.node-version`を`24`として追加し、CIのNode majorと揃える。
- repo-local pnpm storeは成果物ではないため`.pnpm-store/`を`.gitignore`へ追加する。

## 技術的負債Issueの正本契約

`docs/issues/0004-unify-shell-scanners.md`をscanner統合作業の唯一の正本とする。
ここに背景、対象scanner、移行条件、非目標、受け入れ基準、着手トリガーを記載する。

GitHub Issueは次だけを持つ索引とする。

- 正本のrepo-relative path
- Issue本文を仕様として更新しない旨
- 実装PRではMarkdownを先に更新する旨

受け入れ基準や設計本文をGitHub Issueへ複製しない。これにより二重管理を避ける。

## 代替案と不採用理由

### 現行string tokenのままargv decoderだけ追加

工数と直近リスクは最小だが、空文字word、quote mode、展開可能性を表現できず、
今回合意した構造改善を満たさないため不採用とする。

### tokenizerと全scannerを一括置換

最終形は単純になるが、EffectPlan、unparseable、substitution、redirect判定を同時に
変更し、ASKからALLOWへの回帰を切り分けにくい。今回見送ると合意したscanner統合も
含むため不採用とする。

### 採用: structured lexer + compatibility facade +限定導入

quote情報を将来利用できる形で保持しつつ、既存scannerは`string[]`互換APIで維持する。
変更範囲をrecursive shellとCompose境界に限定できるため、この方式を採用する。

## 検証ゲート

最低限、次をfresh runする。

```bash
pnpm exec vitest run \
  src/__tests__/shell-tokenizer.test.ts \
  src/__tests__/verdict/parser-docker-compose.test.ts \
  src/__tests__/effect-ir/shell-lower.test.ts
pnpm typecheck
pnpm lint
pnpm test
git diff --check
```

Docker／LLM suiteは利用可能なsubstrate上で、それぞれ専用commandを実行する。
外部substrateが利用できない場合は通常suiteの成功と混同せず、未実行として報告する。

## ロールアウトと失敗時の扱い

runtime shadow modeは追加しない。代わりにfixture corpusに対する新旧decision diffを
テスト内で固定し、安全側以外の差分を明示レビューする。

未知入力は新decoderから`indeterminate`へ戻すため、主な互換リスクはfalse BLOCKの増加で
ある。ASKからALLOWへの差分が発生した場合はリリースせず、EffectPlan要件単位で原因を
特定する。command例外やallowlistで差分を埋めない。
