# Dogfood 導入先リポジトリ

Belay を **dogfood モード**（`mode: audit` + `policy.unknownLocalEffect: deny`）で入れているリポジトリの一覧。
リリース後の `upgrade` 対象と、active cohort 監査ログの収集先として使う。

英語版（GitHub 中心の短い表）: [dogfood-install-targets.md](./dogfood-install-targets.md)

## 定義

| 項目 | 値 |
| --- | --- |
| dogfood | `mode: "audit"` かつ `unknownLocalEffect: "deny"` |
| 確認 | `belay doctor` が `Dogfood: active` を示すこと |
| enforce 移行 | 各リポの **active cohort** が readiness を満たすまで不可（[監査 remediation §1](../dogfood-audit-remediation-2026-08-22.ja.md)） |

## アクティブ導入先（2026-08-22 時点）

| GitHub | ローカルパス（maintainer 端末） | adapter | 役割 |
| --- | --- | --- | --- |
| [guilz-dev/belay](https://github.com/guilz-dev/belay) | `/Users/kaz/product/guilz/belay` | cursor | 製品本体。リリース検証 |
| [DriveX-Co/scheduling-editor](https://github.com/DriveX-Co/scheduling-editor) | `/Users/kaz/product/drivex/scheduling-editor` | cursor | 実分布 dogfood の主戦場 |
| [guilz-dev/pr-tour](https://github.com/guilz-dev/pr-tour) | `/Users/kaz/product/zoe/pr-tour` | cursor | 副次 dogfood |
| [agency-star/freelance.modis.co.jp](https://github.com/agency-star/freelance.modis.co.jp) | `/Users/kaz/modis/freelance.base/repos/freelance.modis.co.jp` | cursor | 副次 dogfood |

**最終 upgrade:** `@guilz-dev/belay@0.9.1`（2026-08-22）

以下で説明する remediation runtime は、まだ release も各対象への install も行っていない。
release、他リポジトリの upgrade、新 cohort の収集、限定 enforce trial は、いずれも operator
action 待ちである。

## リリース後 upgrade

active な各リポジトリで、`dogfood`、`upgrade`、`doctor`、`status` をそれぞれ別の host Shell action として実行する。host action の `working_directory` には対象リポジトリの絶対パスを設定する。この値は host が渡すものであり、hook プロセスのカレントディレクトリで policy や state を選択してはならない。

各 action はコマンドを一つだけ実行し、同じリポジトリの絶対パスをリテラルの `--target` に指定する。変数由来のパス（`dir` や `wt` など）へ移動する shell function や loop でコマンドをまとめてはならない。readiness 収集は動的なディレクトリ遷移をサポートしない。

**guilz-dev/belay 本体**（製品リポジトリ内）では、同名パッケージ解決の都合で `npx @guilz-dev/belay@…` が失敗することがある。Shell action の `working_directory` を `/absolute/path/to/belay` に設定し、ソースビルドを別々の action で使う:

```bash
pnpm build
node /absolute/path/to/belay/dist/cli.js dogfood --target /absolute/path/to/belay
node /absolute/path/to/belay/dist/cli.js upgrade --with-skill --target /absolute/path/to/belay
node /absolute/path/to/belay/dist/cli.js doctor --target /absolute/path/to/belay
node /absolute/path/to/belay/dist/cli.js status --target /absolute/path/to/belay
```

main 同期込み: [update-local-belay スキル](../../.cursor/skills/update-local-belay/SKILL.md)。

**その他の dogfood 導入先**では、対象リポジトリの絶対パスを `working_directory` に設定し、別々の Shell action を作成する:

```bash
npx -y @guilz-dev/belay@<version> dogfood --target /absolute/target/path
npx -y @guilz-dev/belay@<version> upgrade --with-skill --target /absolute/target/path
npx -y @guilz-dev/belay@<version> doctor --target /absolute/target/path
npx -y @guilz-dev/belay@<version> status --target /absolute/target/path
```

monorepo や linked Git worktree では、Cursor が hook を実行しうる各 worktree にこの action セットを作成する。`belay.config.json` がない sibling worktree は default（`mode: enforce`）のままであり、main worktree が dogfood（`mode: audit`、`unknownLocalEffect: deny`）でも host action を block しうる。

`npx -y`、パッケージ公開、push、control-plane mutation は、引き続き正確な approval を要求することがある。これらは classifier による effect の判断であり、action の working directory を利用できない失敗ではない。

## 対象ごとの readiness evidence

最初に許可された upgrade の直前に、release-window の ISO8601 cutoff を一つ記録し、active
な全対象で同じリテラル値を使う。local implementation verification の時点では cutoff を決めない。
各対象の upgrade、診断、harvest review、quality、将来の enforce 移行は、それぞれ別の host
action で実行し、リテラルの `working_directory` とリテラルの `--target` を同じリポジトリに
一致させる。ある対象の evidence で別の対象を移行してはならない。

各対象について、次の checklist を別々に記録する。raw audit row と raw session ID は記録しない:

- install 済み package/runtime version、完全な `runtimeArtifactHash`、完全な
  `decisionConfigFingerprint`、`boundaryProfile`;
- 共通 cutoff と retained storage diagnostics（read した file 数・byte 数、parsed record 数、
  skip した malformed line 数・oversized line 数）;
- cutoff 以降の active cohort availability-caused ask が 0;
- 少なくとも 150 件の reviewed `provably-benign` active-cohort event が、少なくとも 3 個の
  distinct かつ valid な session correlation にまたがること;
- reviewed benign block rate が 2% 未満; および
- must-ask corpus miss が 0、provably-benign corpus block が 0、
  `readyForEnforce: true`。

active cohort の raw/classifier would-block rate は診断には有用だが、移行判定基準ではない。
移行には、reviewed benign の denominator と上記 availability/corpus hard gate だけを使う。

`quality --target <target>` は、実行している Belay package に同梱された canonical corpus を
既定で使う。target-local corpus は `--corpus <path>` を明示した場合だけ使われる。意図的に
override した場合は、その path も evidence に記録する。evidence に使う check は次のとおり:

```bash
node /absolute/path/to/belay/dist/cli.js quality --target /absolute/target/path --json
```

### Current cohort を review する

選択した対象の active cohort から、cutoff 以降の候補だけを list する。既定では、最新の完全一致
`(fingerprint, kind, boundaryProfile)` review が存在する候補を除外する:

```bash
node /absolute/path/to/belay/dist/cli.js harvest list --target /absolute/target/path --since <shared-cutoff-iso> --json
```

残った候補をすべて review する。JSON 出力の exact command と full fingerprint を使い、
`provably-benign`、`accepted-benign`、`must-ask`、`reject` のいずれかを選び、短く privacy-safe
な reason だけを保存する。captured command body が canonical source corpus へ自動的に入らない
よう、canonical corpus の disposable copy を用意して全 review に渡す（`reject` は copy を読まずに
review を記録する）:

```bash
node /absolute/path/to/belay/dist/cli.js harvest apply --target /absolute/target/path --command "<exact-command>" --fingerprint <64-hex> --outcome <outcome> --reason "<short-reason>" --corpus /private/tmp/belay-harvest-review/shell-commands.json
```

current-cohort list に残件がなくなるまで再実行する。privacy-safe かつ structurally
representative な case を別途 source corpus へ選定した場合は `pnpm corpus` も再実行する。
`--include-reviewed` は review 済み候補の監査用である。`--all-cohorts` は mixed history の
forensic mode 専用で、移行 evidence に使ってはならない。
[dogfood-harvest-review-2026-09-07.md](./dogfood-harvest-review-2026-09-07.md) の frozen 35-item
batch は、特定の記録済み review error を先に文書化しない限り reopen しない。

### Retained audit generation

既定値は `audit.maxBytes: 33554432`（32 MiB）と `audit.maxFiles: 5` で、active
`audit.ndjson` も 5 file に含む。numbered file は `.1` が最新、`.4` が最古で、reader は保持された
完全な set を最古から active の順に stream する。rotation は audit lock で直列化される。
metrics と doctor は read した file/byte、parsed record、skip した malformed/oversized line を
表示するため、その count を readiness evidence に残し、skip が 0 でなければ調査する。
numbered rotation は `audit.ndjson.legacy-*.ndjson` archive を削除しない。

## Release-window blocking check

最初に許可された upgrade の直前に一つの release-window cutoff（`since`、ISO8601）を選び、
上記 entry に対応する **active な各 local repository** で、その対象の upgrade 後に次を一回ずつ
実行する:

```bash
scripts/pre-release-dogfood-check.sh <target-dir> <since-iso>
```

全 active repository で check が通らなければならない。cutoff と各 command output を release PR
へ記録し、上記 post-upgrade cohort check にも同じ cutoff を使う。cutoff は、最初に許可された
upgrade の直前までは pending のままとする。

## 対象外（この一覧に含めない）

| GitHub | 理由 |
| --- | --- |
| [zoe-llc/avoid-shadow](https://github.com/zoe-llc/avoid-shadow) | `mode: enforce`、runtime 0.4.x の legacy。別途移行計画が必要 |
| `guilz-dev/belay`（`archive---agent-belay` 作業コピー） | アーカイブ用。active dogfood 対象外 |

## 一覧の更新

導入・除外するとき:

1. このファイル（と [dogfood-install-targets.md](./dogfood-install-targets.md)）を更新
2. 対象リポで `upgrade` + `doctor` を実行
3. 監査分析ドキュメント（[dogfood-audit-remediation](../dogfood-audit-remediation-2026-08-22.ja.md) 等）でログパスを参照するときは、**この一覧を正**とする

ローカルパスは maintainer 端末依存。GitHub リポジトリ名を識別子の正本とする。
