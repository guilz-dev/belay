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
