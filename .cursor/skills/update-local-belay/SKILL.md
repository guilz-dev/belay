---
name: update-local-belay
description: >-
  Syncs the belay repository main branch and refreshes the locally installed
  belay hooks/runtime from a source build. Use when the user says
  update-local-belay, /update-local-belay, sync main and upgrade belay, refresh
  local belay install, or dogfood the latest belay on this repo.
---

# update-local-belay

`guilz-dev/belay` リポジトリで **main を最新化**し、**ローカルにインストール済みの belay**（`.cursor/` 配下の hooks / runtime / skill）をソースビルドで更新する。

## いつ使うか

- ユーザーが **update-local-belay** / **/update-local-belay** と言ったとき
- 「main を pull してローカルの belay を更新」「dogfood 用に belay を最新化」と依頼されたとき
- `belay doctor` で runtime バージョン不一致が出たあと、ソースから揃えたいとき

## 前提

- 作業ディレクトリは **belay リポジトリのルート**（`package.json` の `name` が `@guilz-dev/belay`）
- Node **22+** と **pnpm** が使えること
- ローカル install は `belay init` / `belay upgrade` で入った **project scope**（`.cursor/belay.config.json` 等）を想定。`installScope: global` の場合は `~/.cursor/` 側も更新される

## 手順（この順で実行する）

**説明だけで終わらせず、必ずシェルで実行する。**

### 1. プリフライト

```bash
git rev-parse --show-toplevel
git status --short
git branch --show-current
```

- リポジトリ外なら中止し、ルートへ移動するよう案内する
- **未コミット変更がある場合**は pull 前にユーザーへ共有する（stash / commit はユーザー指示があるときだけ）
- 破壊的 git（`reset --hard`、`pull --rebase` の強制など）は使わない

### 2. main を最新化

```bash
git fetch origin
git checkout main
git pull origin main
```

- `git pull` がコンフリクトや未コミット変更で失敗したら **そこで止める**。無理に続行しない

### 3. 依存とビルド

```bash
pnpm install
pnpm build
```

`pnpm build` は `dist/` と hook 用 runtime バンドル（`dist/bundle/`）を生成する。`upgrade` の前に必須。

### 4. ローカル belay を upgrade

CLI の解決（PATH に `belay` が無ければビルド成果物を使う）:

```bash
if command -v belay >/dev/null 2>&1; then
  BELAY=belay
else
  BELAY="node dist/cli.js"
fi
```

リポジトリルートで upgrade（hooks / runtime / config マイグレーション。`--with-skill` で `skills/belay/` も同期）:

```bash
$BELAY upgrade --with-skill
```

- アダプターが Cursor 以外の場合は設定に合わせて `--adapter claude|codex` を付ける
- judge 既定の移行が必要なときだけ `--migrate-judge-default` を付ける（ユーザー明示時）

### 5. 検証

```bash
$BELAY doctor
$BELAY --version
```

`doctor` が `ok: false` なら報告に失敗理由を含める。コード変更も検証する場合は [verify-parallel](../verify-parallel/SKILL.md) を続けて実行してよい（ユーザー依頼時）。

### 一括実行（推奨）

上記 2〜5 をまとめて走らせる場合:

```bash
.cursor/skills/update-local-belay/scripts/sync-and-upgrade.sh
```

スクリプトは **未コミット変更があると exit 1** で止まる。続行する場合はユーザー確認後に手順を分けて実行する。

## 報告形式（必須・日本語）

```markdown
## update-local-belay 結果

- **main**: `<旧 SHA>` → `<新 SHA>`（fast-forward | 既に最新 | 失敗）
- **package 版**: `vX.Y.Z`（`node dist/cli.js --version` または `belay --version`）
- **upgrade**: OK | FAILED
- **doctor**: OK | FAILED

### 失敗・注意（あれば）
- ...
```

## 禁止事項

- `git config` の変更、`git pull --rebase` の強制、未確認の `stash` / `reset --hard`
- `git commit --trailer` / `--no-verify`（commit が必要なときは [push スキル](../push/SKILL.md) の safe スクリプト）
- `.cursor/belay/` や `.cursor/hooks/belay-*` など **gitignore 対象の install 成果物をコミットしない**

## 補足

- 公開 npm の `@guilz-dev/belay` を更新する手順ではない（リリースは [release スキル](../release/SKILL.md)）
- フックがブロックしたら [belay スキル](../belay/SKILL.md) の承認フローに従う
