# AGENTS ガイドライン（Belay）

このリポジトリで作業するエージェントは、以下を厳守すること。

## プロジェクト境界

- Orbit は別プロジェクトであり、Belay 本体の要件・設計・実装とは無関係とする。
- 本リポジトリでは、Orbit を前提にした提案・設計・手順・実装を行わない。

## 記述言語（Git / GitHub）

**ユーザーとの会話は日本語でよいが、Git および GitHub に残る記述はすべて英語で書く。**

対象（英語必須）:

- `git commit` の subject / body（コミットメッセージ全文）
- ブランチ名（例: `feat/shell-semantics`, `fix/path-boundary`）
- Pull Request の title / body / review comment / inline review comment
- Issue コメント、Merge / Squash 時のメッセージ
- `gh pr create`, `gh pr comment`, `gh api` 等で投稿するテキスト

禁止・注意:

- コミットメッセージ・PR 本文を日本語で書かない
- `--trailer` や Cursor 署名（`Made with Cursor`, `Co-authored-by: Cursor` 等）を付けない
- ユーザー向けチャットの要約を、そのままコミットメッセージや PR 本文に貼らない（英語に書き直してから記録する）

対象外（この節の英語必須は適用しない）:

- エージェントがユーザーへ返す通常の説明・報告（日本語可）
- リポジトリ内の既存ドキュメント（`docs/`, `README`, 本ファイル等）の言語
- ソースコード内コメント（周辺コードの慣例に従う）

例:

- ✅ Commit: `refactor: centralize shell command semantics to fix false positives`
- ✅ PR title: `refactor: centralize shell command semantics to fix verdict false positives`
- ❌ Commit: `refactor: シェル意味解析を共通化して偽陽性を修正`
- ❌ PR body の Summary を日本語のみで書く

## 記述と実装の禁止事項

- ドキュメント、スクリプト、コメント、CLI 例に Orbit の製品名や実行例を新規追加しない。
- 外部ワークフロー実行基盤を前提にした説明をしない。

## 自律品質改善の前提

- 自律品質改善は Belay 単体の機能（session / runner / verify / corpus / ratchet）で設計・実装する。
- `deny_pending_approval` は自動承認せず、停止して人間へエスカレーションする。
