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

各リポのルートで:

```bash
npx @guilz-dev/belay@<version> upgrade --with-skill
npx @guilz-dev/belay@<version> doctor
npx @guilz-dev/belay@<version> status
```

`guilz-dev/belay` 本体で `npx` が `belay: command not found` になる場合は、publish 済み tarball の CLI を直接使う:

```bash
cd /Users/kaz/product/guilz/belay
TMP=$(mktemp -d)
npm pack @guilz-dev/belay@<version> --pack-destination "$TMP" >/dev/null
tar -xzf "$TMP"/guilz-dev-belay-<version>.tgz -C "$TMP"
node "$TMP/package/dist/cli.js" upgrade --with-skill
node "$TMP/package/dist/cli.js" doctor
rm -rf "$TMP"
```

ソースから揃える場合（npm ではなく main ビルド）: [update-local-belay スキル](../../.cursor/skills/update-local-belay/SKILL.md)。

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
