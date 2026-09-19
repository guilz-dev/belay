# freelance unknown_local_effect triage — 2026-09-17

## 目的

`freelance.modis.co.jp` と `freelance.admin` の audit ログから `unknown_local_effect`（ULE）をパターン別に分解し、avoidable / classifier gap / must-ask を切り分ける。enforce 移行ではなく **audit ノイズ低減** がゴール。

## ベースライン（active cohort, runtime `0.12.1@61e8d5c542a5cbff`）

| 指標 | freelance.modis.co.jp | freelance.admin |
|---|---|---|
| gate events | 3,037 | 3,037 |
| would-block 合計 | 181 | 181 |
| **ULE** | **121** | **121** |
| external_effect | 35 | 35 |
| outside_repo_mutation | 18 | 18 |
| tier1_catastrophic | 7 | 7 |
| availability asks | 0 | 0 |

両 repo は同一 runtime artifact（`0.12.1@61e8d5c542a5cbff`）の active cohort を共有。audit log は repo 別パスだが、2026-09-17 再計測時点で上表の数値は一致。

全履歴（forensic, modis）では ULE **171** 件（would-block 259 中）。

## パターン別バケット

| パターン | 典型コマンド | active cohort 件数 | disposition | 対策 |
|---|---|---:|---|---|
| executable heredoc | `python3 <<'PY'` / `python3 - <<'PY'` | 20 | **must-ask** | ルールで回避不可。indeterminate 維持 |
| bash -c opaque wrapper | `'...' bash -c '...'` | 4 | **must-ask** | wrapper 分解・Write 経由 |
| sleep && gh | `sleep 1500 && gh run view ... --repo ...` | 2 | classifier gap | **belay: sleep を no-effect 化**（本 PR） |
| cd チェーン | `cd /other && npm test` | 6+ | **avoidable** | `working_directory` + 1 repo = 1 Shell |
| ctx + flags | `ctx search ... --refresh off --since 60d` | 1+ | opaque argv delegate | ops: `ctx-resilient` skill 経由 |
| gh 単体 read-only | `gh run view ... --repo ... --log-failed` | 0（既に allow） | stale log | 回帰テスト追加のみ |
| commit heredoc | `git commit -m "$(cat <<'EOF'..."` | 0（既に allow） | stale log | 回帰テスト追加のみ |
| tier1 .env read | Read `.env*` / `.env.test.example` | 11 | **must-ask** | パス指定の見直し |
| outside_repo Read | Read 他 repo ファイル | 18 | **must-ask** | tool path を repo 内に限定 |

### ULE 上位サマリ（active cohort）

1. `python3 <<'PY'` — 12 件
2. `python3 - <<'PY'` — 8 件
3. `sleep 1500 && gh run view ...` — 2 件
4. `cd ... && npm test` — 2〜4 件
5. `ctx search ... --refresh off --since 60d` — 1 件

## explain 再分類（belay 0.12.1 現行 + 本 PR 変更）

`explain --command --cwd` で決定的に再分類。repo root = `/Users/kaz/modis/freelance.base/repos/freelance.modis.co.jp`。

| コマンド | Phase0 permission | Phase0 reason | 本 PR 後 |
|---|---|---|---|
| `gh run view 35177312105 --repo agency-star/freelance.admin --log-failed` | allow | read_only | allow（変更なし） |
| `gh pr view 675 --repo agency-star/freelance.admin` | allow | read_only | allow（変更なし） |
| `sleep 1500 && gh run view 35051027563 --repo agency-star/copilot-usage-reporter --json status,conclusion` | **ask** | unknown_local_effect | **allow** / read_only |
| `git commit -m "$(cat <<'EOF'\nfix: example\nEOF\n)"` | allow | repo_local_mutation | allow（変更なし） |
| `ctx search "..." --refresh off --since 60d \| head -80` | **ask** | unknown_local_effect | ask（ops 対応） |
| `python3 <<'PY'\nprint(1)\nPY` | **ask** | unknown_local_effect | ask（must-ask 維持） |
| `cd /other && npm test` | **ask** | unknown_local_effect | ask（ops: working_directory） |

signals 詳細:

- `sleep && gh`（修正前）: `process.grammar_unknown`, `process.argv_delegate`, `egress.gh`
- `ctx search`（修正前）: `process.grammar_unknown`, `argv_delegate_wrapper_options`, `process.argv_delegate_opaque`
- commit heredoc: `git.commit`, `command_substitution`（`shell.heredoc_incomplete` なし）

## 凍結 fingerprint セット（before/after 用）

Phase 2 変更の回帰監視用。`allow → deny` が 1 件でもあればロールバック対象。

| fingerprint (prefix) | パターン | Phase0 | 本 PR 後 |
|---|---|---|---|
| `gh run view --repo` | gh read-only | allow | allow |
| `gh pr view --repo` | gh read-only | allow | allow |
| `sleep && gh run view` | compound CI poll | ask / ULE | allow / read_only |
| `git commit heredoc` | literal `-m "$(cat <<'EOF'..."` | allow | allow |
| `python3 <<'PY'` | executable heredoc | ask / ULE | ask（維持） |
| `ctx search --refresh` | opaque delegate | ask / ULE | ask（維持） |
| `cd && npm test` | cd chain | ask / ULE | ask（維持） |

## 本 PR（belay）のスコープ

### 実装

1. **sleep を no-effect builtin 化** — `sleep N` / `sleep N.N` / `sleep Ns` を effect なしとして lowering。`sleep && gh run view` 複合が read_only allow になる。
2. **gh read-only 回帰テスト** — `--repo`, `--log-failed`, `--json` 付きケースを corpus + authority test に追加。
3. **commit heredoc 回帰テスト** — literal heredoc substitution が `shell.heredoc_incomplete` にならないことを固定。expanding heredoc は ask 維持。

### スコープ外（別 PR / ops）

- freelance repo の `belay-shell-cwd.mdc` / AGENTS.md 強化
- `~/.cursor/skills/push` の heredoc デフォルト廃止
- ctx bounded argv delegate（generic delegate 不足が証明された場合のみ再検討）
- executable heredoc / bash -c / for ループの silent allow

## 期待効果

active cohort ULE 121 件に対し、sleep && gh（2 件）が削減。残り 119 件は ops（cd 分解、ctx skill 経由）と must-ask（python heredoc、bash -c）が主因。

cutoff 後の 50% 削減目標は **Phase 1 ops 変更 + 本 PR + 1-4b source-build upgrade** の組み合わせで達成する。

## sleep lowering の実行ファイル境界（PR #134 後続修正）

ADR-004 の不明な効果を承認対象に残す原則に従い、no-effect lowering はパス指定のない `sleep` に限定する。
`./sleep`、`/tmp/sleep` など、実行ファイル名だけが一致する任意のプログラムには通常の sleep の意味を適用しない。
パス付き呼び出しは `process.exec` と `indeterminate` を残して ask とし、標準コマンドへの絶対パス指定もこの限定 decoder の対象外とする。
`sleep N && gh run view ...` の read-only allow と、リダイレクト・コマンド置換で生じる効果の保持は継続する。

## 検証コマンド

```bash
# belay 本体（worktree）
pnpm build
pnpm corpus
make verify-parallel

# 代表 explain（修正確認）
node dist/cli.js explain \
  --target /Users/kaz/modis/freelance.base/repos/freelance.modis.co.jp \
  --command 'sleep 1500 && gh run view 35051027563 --repo agency-star/copilot-usage-reporter --json status,conclusion' \
  --cwd /Users/kaz/modis/freelance.base/repos/freelance.modis.co.jp \
  --json
```
