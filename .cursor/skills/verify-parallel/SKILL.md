---
name: verify-parallel
description: >-
  Runs `make verify-parallel` (lint, typecheck, test in parallel) from the
  repository root and reports per-task results in Japanese. Use when the user
  says verify-parallel, /verify-parallel, parallel verify, or wants CI-like
  local checks quickly.
---

# verify-parallel

リポジトリの検証を **lint / typecheck / test** の3本で並列実行する。

## いつ使うか

- ユーザーが **verify-parallel** / **/verify-parallel** と言ったとき
- 「並列で検証」「CI 相当をローカルで早く回して」と依頼されたとき
- 変更後の品質確認をまとめて行いたいとき

## 手順（この順で実行する）

### 1. リポジトリルートを確認

`Makefile` があるディレクトリで作業する。無ければ `git rev-parse --show-toplevel` でルートへ移動する。

### 2. 並列検証を実行する（必須）

**説明だけで終わらせず、必ずシェルで実行する。**

```bash
make verify-parallel
```

`make` が無い場合:

```bash
set -e
(pnpm lint) & LINT_PID=$!
(pnpm typecheck) & TYPECHECK_PID=$!
(pnpm test) & TEST_PID=$!
status=0
wait $LINT_PID || status=1
wait $TYPECHECK_PID || status=1
wait $TEST_PID || status=1
exit $status
```

### 3. 失敗時は個別タスクで切り分ける

`make verify-parallel` が非ゼロ終了したら、次を **順に** 実行してどのタスクが落ちたか特定する:

```bash
make lint
make typecheck
make test
```

個別実行でも失敗したタスクの **先頭の actionable なエラー**（ファイルパス・行番号があれば含める）を記録する。

### 4. 結果を報告する（必須・日本語）

次の形式で返す:

```markdown
## verify-parallel 結果

- **総合**: success | failed
- **lint**: OK | FAILED
- **typecheck**: OK | FAILED
- **test**: OK | FAILED

### 失敗詳細（failed のときのみ）
- タスク名:
- エラー要約:
- 該当ファイル:
```

## 注意

- `pnpm install` は本スキルの対象外。依存エラーならユーザーに共有する。
- 修正まで行うかはユーザー指示がある場合のみ。デフォルトは **実行と報告**。
- `make verify`（順次）や `make corpus` はユーザーが明示したときだけ追加実行する。
