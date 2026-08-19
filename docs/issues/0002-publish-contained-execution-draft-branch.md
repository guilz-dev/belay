# 0002 Contained Execution 改良版をremote draft branchとして公開する

## 種別

AFK

## 対象ユーザーストーリー

長時間のContained Execution実装を失わず共有できるよう、未完成点を記録したremote branchを
作成する。

## 作るもの

Issue 0001の保証契約修正と、この残件を記録した3つの`docs/issues/*.md`をcommitし、
`feat/contained-unknown-execution`を新規remote branchとしてpushする。

push対象は隔離worktreeのfeature branchだけとし、元checkoutに存在する利用者の未commit変更には
触れない。force pushや履歴書換えは行わない。PR作成はこのIssueの対象外とし、別途明示的に
依頼された場合だけ行う。

## 受け入れ基準

- [ ] Issue 0001の修正とテストが1つ以上の意図的なcommitに記録されている。
- [ ] `0001`〜`0003`のMarkdown issueがすべてcommitされ、push後のbranchに存在する。
- [ ] `git status --short`がcleanで、ignored SDD reportや一時ファイルがcommitに含まれない。
- [ ] `origin/feat/contained-unknown-execution`が作成され、local HEADとremote HEADが一致する。
- [ ] upstream trackingが設定されている。
- [ ] commitまたはhandoff記録に、opt-in、Docker-only、network none、変更破棄、allowlist不使用が記載されている。
- [ ] 最新main統合、full verification、最終レビューが残件として記録されている。
- [ ] 実行済みのfocused test、typecheck、structural、Docker integration結果が記録されている。
- [ ] 元checkoutの既存dirty filesを変更していない。

## 検証

```bash
git status --short
git log --oneline --decorate -5
git ls-remote --heads origin feat/contained-unknown-execution
git rev-parse HEAD
git rev-parse origin/feat/contained-unknown-execution
```

## 依存

- [0001: Contained Execution の保証契約を確定する](./0001-contained-execution-guarantee-closeout.md)

## 関連資料

- [Contained Unknown Execution実装plan](../superpowers/plans/2026-08-18-contained-unknown-execution.md)
