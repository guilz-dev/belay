# Belay コードベース リファクタ分析

Date: 2026-06-24

## 対象

このメモは、Belay のコードベースを構造的に読み、主に以下を対象に整理したものです。

- `src/core`
- `src/adapters`
- `src/commands`
- `src/config-io.ts`
- `src/installer.ts`

重視した観点は次の4点です。

- 外部挙動を変えずに内部構造を改善できるか
- runtime / config / adapter 間の隠れた結合を減らせるか
- 新しい host / tool 追加コストを下げられるか
- 既存テスト資産を活かして段階的に進められるか

## 要約

Belay の大きな構造自体は良いです。

- 共通の classifier / gate runtime を持つ
- host ごとの差分は adapter に寄せている
- `src/__tests__` 配下に `91` 個のテストがあり、安全網が広い

一方で、保守負債は少数の巨大ファイルに集中しています。

| 領域 | ファイル | 行数 | 主な問題 |
| --- | --- | ---: | --- |
| Config ドメイン | `src/core/config.ts` | 1259 | 型・既定値・migration・normalization・judge 設定・state path が1ファイルに集約 |
| Verdict エンジン | `src/core/verdict/verdict.ts` | 1034 | rule 順序、再帰、path 判定、Tier1 呼び出しが密結合 |
| Gate orchestration | `src/adapters/shared/gate-runtime.ts` | 1034 | approval 保存、audit、replay、transactional、response 生成を同居 |
| CLI | `src/cli.ts` | 949 | 引数解析と dispatch が単一ファイルに集中 |
| Config UX | `src/commands/config.ts` | 701 | 機械向け設定変更と対話 wizard が混在 |

結論としては、挙動を書き換える前に「境界を切り出す」リファクタを優先すべきです。今のテスト量なら、互換 facade を残しながら中身を分割していく進め方が現実的です。

## 主な観察結果

### 1. Config は独立ドメインなのに、実装とドキュメントの責務が分散している

`src/core/config.ts:26-1259` は現在、以下を同時に持っています。

- 公開 config 型
- version ごとの既定値
- judge provider の既定値
- judge normalization
- v1/v2/v3/v4 migration
- normalize / merge
- state / control-plane path helper

特に変更リスクが高いのは以下です。

- judge normalization: `src/core/config.ts:530-650`
- raw config migration: `src/core/config.ts:677-885`
- full normalization / merge: `src/core/config.ts:921-1198`

この状態だと、設定項目を1つ増やすだけでも schema、migration、runtime default がまとめて影響範囲になります。

さらに、外部ドキュメントの source-of-truth も揺れています。

- `README.md:187-193` は `version: 3` 前提
- `docs/README.ja.md:95` も `config-schema.md` を v3 と説明
- `docs/config-schema.md:1-5` と実装は v4 前提

つまり config は内部実装だけでなく、公開説明も drift しやすい構造になっています。Config を P1 で触るなら、コード分割と同時に「どの文書が正本か」を整理しないと、移行後も再発します。

### 2. Verdict エンジンは分岐順序への依存が強い

`src/core/verdict/verdict.ts` は、宣言的な rule table と命令的な判定パイプラインが同居しています。

- Tier0 command table: `src/core/verdict/verdict.ts:49-139`
- 再帰的な本体: `src/core/verdict/verdict.ts:470-1034`
- path 判定ループの重複: `src/core/verdict/verdict.ts:724-777`, `819-891`

`evaluateSegment()` が同時に扱っている責務は以下です。

- parseability
- substitution recursion
- interpreter recursion
- launcher expansion
- egress classification
- path containment
- sensitive path check
- Tier1 routing
- 最終結果の合成

加えて、同種の path-sensitive / Tier1 mutation 判定は tool 側にも重複しています。

- `src/core/classify-tool.ts:99-182` の file mutation Tier1 判定
- `src/core/classify-tool.ts:247-414` の file mutation path 判定
- `src/core/classify-tool.ts:416-493` の `apply_patch` 再帰処理

動作はしていても、分岐の順番自体が仕様になっているうえ、shell と tool で似た判定が別実装になっているので、新しい rule を安全に足しにくい状態です。

### 3. Gate runtime が責務を抱えすぎている

`src/adapters/shared/gate-runtime.ts` は実質的に次の役割を兼務しています。

- config loader: `175-192`
- approval persistence adapter: `132-173`, `234-390`
- classifier orchestration: `392-538`
- transactional wrapper: `461-499`
- approval decision engine: `581-793`
- prompt approval workflow: `795-953`
- host response mapper: `955-1017`

さらに approval state の永続化ロジックが以下で重複しています。

- `src/config-io.ts:74-157`
- `src/config-io.ts:227-257`
- `src/adapters/shared/gate-runtime.ts:153-171`

この重複は、approval file format の drift や subtle な state handling 差分を生みやすいです。

### 4. Host adapter は似た構造なのに、抽象化すべき層と分けるべき層が混ざっている

runtime entry は3実装とも同じ初期化パターンを繰り返しています。

- `src/adapters/cursor/runtime-entry.ts:14-40`
- `src/adapters/claude/runtime-entry.ts:17-43`
- `src/adapters/codex/runtime-entry.ts:17-42`

3つとも重複しているものは以下です。

- stdin JSON 読み込み
- JSON response 書き出し
- runtime context 解決
- approval prompt hook 処理
- audit hook 処理

installer 側にも同種の重複があります。

- `src/installer.ts:85-132`
- `src/adapters/claude/adapter.ts:77-130`
- `src/adapters/codex/adapter.ts:35-72`

ただし、ここで一括抽象化を急ぐと別の問題が出ます。`src/installer.ts:170-302` はすでに次の2層をまとめて持っています。

- host 固有 artifact install
- judge / preset / dogfood / integrity の横断 orchestration

3 host のうちは耐えますが、host 追加や host 固有の tool normalization が増えると急速に重くなります。一方で adapter 抽象化は、host 差分と横断 policy を再び同じ抽象へ押し込まないように層を分けて進める必要があります。

### 5. CLI 複雑性が `src/cli.ts` に集中している

`src/cli.ts:30-537` は全 command / subcommand の手書き parser で、`src/cli.ts:577-949` が dispatch と出力整形をまとめて持っています。

実務上の問題は3つです。

- help text と parse rule が乖離しやすい
- flag を1つ増やすだけでグローバル parser を触る必要がある
- command 単位でなく CLI 全体の結合面を毎回意識する必要がある

外部依存を増やさない方針自体は妥当ですが、内部実装は registry ベースに寄せた方が保守しやすいです。

### 6. `belay config` がドメインロジックと対話 UX を混ぜている

`src/commands/config.ts` は以下を1ファイルで扱っています。

- judge field getter / setter: `147-289`
- credential mutation: `301-389`
- interactive wizard prompt: `407-640`
- command 実行: `643-701`

特に brittle なのは API key の一時受け渡しです。

- 一時 env var へ書く: `src/commands/config.ts:425-429`
- 後段で読んで削除する: `src/commands/config.ts:516-520`, `565-568`

これは wizard の一時状態を `process.env` に逃がしている形で、専用の in-memory session object に切り出すべきサインです。

### 7. `doctor` は有用だが、単一巨大関数になっている

`src/commands/doctor.ts:55-416` は、実質的には check registry ですが、実装は1関数に集約されています。

確認している内容は広いです。

- config shape / provenance
- integrity
- hook install 状態
- runtime version
- audit 由来の dogfood 状態
- sandbox / egress posture
- skill-only install

ただし今の形だと、新しい check の追加、個別失敗の切り分け、対象限定の診断がやりにくいです。

## リファクタ提案

### 1. Config ドメインを分割する

優先度: P1

主対象:

- `src/core/config.ts`
- `src/core/config-layers.ts`
- `src/config-io.ts`

提案:

- `config-types`, `config-defaults`, `config-judge`, `config-migrate`, `config-normalize`, `config-paths` のように責務分割する
- `src/core/config.ts` は互換維持の facade として残し、public API を再 export する
- approval / control-plane path helper を schema normalization から分離する
- config の公開説明について `docs/config-schema.md` を正本に寄せ、README / `docs/README.ja.md` の version 記述を同期する

これを最初にやる理由:

- ほぼ全サブシステムが config を import している
- 後続の大きなリファクタがやりやすくなる
- 外部挙動を変えずに進めやすい

進め方:

1. まず pure type / constant を移す
2. 次に judge normalization を移す
3. その後 migration helper を移し、v1/v2/v3 入力の characterization test を維持する
4. 最後に state path helper を移す

成功条件:

- `src/core/config.ts` がほぼ facade 化される
- config migration 系テストがそのまま通る
- v3 / v4 の説明揺れが README 群から消える

### 2. `ApprovalRepository` と `AuditSink` を gate runtime から切り出す

優先度: P1

主対象:

- `src/adapters/shared/gate-runtime.ts`
- `src/config-io.ts`

提案:

- `loadPending`, `loadApproved`, `savePending`, `saveApproved` を持つ shared approval persistence module を作る
- audit append を専用 `AuditSink` に切り出す
- `GateRuntimeDeps` から file format 詳細を追い出し、orchestration 依存だけにする

理由:

- approval state IO が重複している
- gate runtime は policy 決定に集中すべきで、JSON serialization 詳細を持つべきではない
- approval replay / signing / 将来の storage 差し替えがやりやすくなる

進め方:

1. 既存 JSON file の上に repository interface を先に作る
2. `config-io.ts` と `gate-runtime.ts` を両方その経路へ寄せる
3. テスト通過後に重複 read/write 実装を削除する

成功条件:

- approval file schema の実装が1箇所に集約される
- `gate-runtime.ts` から file-path / JSON-shape 関心が減る

### 3. Verdict エンジンを detector pipeline 化する

優先度: P1

主対象:

- `src/core/verdict/verdict.ts`
- `src/core/classify-tool.ts`
- `src/core/verdict/parser.ts`
- `src/core/verdict/containment.ts`
- `src/core/verdict/judge.ts`

提案:

- parse 結果から一度だけ `SegmentFacts` または `VerdictFacts` を構築する
- shell 専用 pipeline ではなく、tool file-mutation 判定も共有できる mutation risk service を切り出す
- 判定を次のような ordered detector に分ける
- parseability detector
- recursion / interpreter detector
- launcher detector
- Tier0 external detector
- path-risk detector
- Tier1 detector
- finalization detector

理由:

- 現状は branch 順序自体が仕様になっている
- 新しい high-stakes rule を追加する時の副作用が読みづらい
- detector 単位にすれば、decision trace のテストもしやすい
- shell と tool で似た判定を二重管理しなくて済む

進め方:

1. まず `SegmentFacts` と file-mutation facts の共通表現を導入する
2. path / sensitive / Tier1 mutation 判定を shared service へ寄せる
3. branch 群を少しずつ detector へ移す
4. どの detector が最終判断を出したかを snapshot できるようにする

成功条件:

- `evaluateSegment()` が orchestration shell に縮む
- `classify-tool.ts` の file mutation 分岐と shell verdict の危険判定が同じ service を使う
- Tier0 rule と Tier1 routing を独立に進化させられる

### 4. Host adapter spec を作り、runtime entry と installer を共通化する

優先度: P2

主対象:

- `src/adapters/*/runtime-entry.ts`
- `src/adapters/*/adapter.ts`
- `src/installer.ts`

提案:

- 以下を持つ `HostRuntimeSpec` を定義する
- hook config merger
- tool / event normalization rule
- response mapper
- runtime-entry の共通 bootstrapping は shared helper へ寄せる
- host 固有差分だけを adapter ごとに残す
- installer は別途 `HostArtifactInstaller` と横断 orchestration に分ける

理由:

- Cursor / Claude / Codex で初期化コードがかなり重複している
- Codex / Claude ですでに tool normalization 差分が増え始めている
- host が増えるほど copy-paste コストが増す
- ただし installer まで一気に単一抽象へ寄せると、host 差分と judge/preset/dogfood orchestration を再結合しやすい

進め方:

1. `readStdinJson`, `jsonResponse`, `loadRuntimeContext` を shared 化する
2. host ごとの tool mapping table を定義する
3. runtime entry の共通化が固まってから、installer は artifact install と横断 orchestration を別々に抽出する

成功条件:

- adapter file が宣言的になる
- `installer.ts` では host 固有 artifact install と横断 orchestration の境界が明示される
- 新 host 追加時に runtime-entry 一式を複製しなくて済む

### 5. CLI を command registry 化する

優先度: P2

主対象:

- `src/cli.ts`
- `src/commands/*`

提案:

- command registry を定義し、以下を command ごとに持たせる
- command name
- subcommand
- option schema
- handler
- help text

理由:

- parse と dispatch が1ファイル集中になっている
- flag 追加で global parser を触る必要がある
- help text の同期が手作業

進め方:

1. `metrics`, `status`, `report` など単純 command から registry 化する
2. `config`, `judge`, `audit` のようなネスト command は後段で移す
3. `printHelp()` を registry から生成する

成功条件:

- `src/cli.ts` が薄い bootstrapper になる
- command ごとに parse / validate の責務が閉じる

### 6. `belay config` の service 層と wizard UX を分離する

優先度: P2

主対象:

- `src/commands/config.ts`
- `src/commands/stdin-key.ts`

提案:

- `JudgeConfigService` を作り、set / unset / credential mutation を集約する
- `ConfigWizardSession` を作り、prompt の順序と一時状態を管理する
- `BELAY_CONFIG_WIZARD_JUDGE_KEY` を内部状態の受け渡しに使うのをやめる

理由:

- automation path と terminal UX が同じ制御フローを共有している
- env var 経由の一時状態は追跡しづらい
- config command のテストを terminal mock なしで書きやすくなる

進め方:

1. judge field mutation を pure service へ移す
2. wizard 関数が一時 secret を含む構造化結果を返すようにする
3. CLI prompt 文言と外部挙動は維持する

成功条件:

- 非対話 config mutation が terminal mock なしでテストできる
- wizard が `process.env` を内部 transport として使わない

### 7. `doctor` を check registry 化する

優先度: P3

主対象:

- `src/commands/doctor.ts`
- 周辺 health module

提案:

- `{ issues, warnings, notes }` を返す `DoctorCheck` interface を作る
- check を次のカテゴリに分ける
- config
- hooks / runtime
- control plane
- transactional
- containment
- skill / install health

理由:

- 現状は巨大 checklist を1関数で持っている
- check 追加、対象限定実行、個別失敗の切り分けがしづらい

進め方:

1. 既存ロジックを1 check ずつ外出しする
2. report shape は維持する
3. check 単位の unit test を足す

成功条件:

- `doctorProject()` が aggregator になる

## 推奨順序

低リスクで進めるなら、次の順番が妥当です。

1. Config 分割
2. Approval repository + audit sink 抽出
3. CLI registry の土台作成
4. `belay config` service 分離
5. Verdict detector pipeline 化
6. Adapter runtime / installer 共通化
7. Doctor check registry 化

最初から verdict 全面書き換えに入るのは勧めません。最も挙動影響が大きい層なので、config と runtime の境界を先に整えてから触る方が安全です。

## 実施時のガードレール

- `src/index.ts` と `src/core/index.ts` の public export は最後まで維持する
- 第1段階では config file format と approval file format を変えない
- import を一気に崩すより、互換 facade を残しながら中身を差し替える
- `verdict.ts`, `gate-runtime.ts`, `cli.ts` は先に characterization test を補強してから動かす
- 1PR で全部やらず、責務単位で小さく分ける

## 期待される状態

この順序で進めれば、Belay は現行挙動を保ったまま次の状態に近づけます。

- 新しい host runtime を足しやすい
- verdict / approval 層の変更が安全になる
- config / CLI の保守コストが下がる
- subsystem 単位でテストしやすくなる
