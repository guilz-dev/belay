# 0003 Contained Execution をmain統合可能な状態にする

## 種別

AFK

## 対象ユーザーストーリー

remote draft branchとして共有したContained Execution改良版を、最新mainとの互換性、全品質gate、
最終セキュリティレビューが確認されたmerge-readyな変更にする。

## 作るもの

最新の`origin/main`をfeature branchへ取り込み、競合や挙動差を解消する。その後、計画で定めた
全検証と実Docker integrationを実行し、
[`2026-08-18-contained-unknown-execution.md`](../superpowers/plans/2026-08-18-contained-unknown-execution.md)
のTask 1〜6を横断する最終レビューを行う。

このIssue開始時点の観測ではfeature branchは`origin/main`に対して26 commits ahead、
7 commits behindである。数値は作業開始時に再取得する。

既知のfull test failureであるignored設計fixture
`docs/.tmp/judge-provider-switching-ux.md`への依存は、main取り込みで解消するか確認する。
残る場合はfixtureを捏造せず、テストがtrackedな入力だけに依存するよう別修正として解消する。

## 受け入れ基準

- [ ] 最新`origin/main`を取り込み、競合解消後の差分に利用者の無関係な変更が混入していない。
- [ ] EffectPlanがshell authorityであり、実行ファイル名、prefix、fingerprint、corpus membership、Rails／RSpec固有規則がeligibilityを与えない。
- [ ] audit modeはcontained実行0、enforce modeはcontainer start最大1回かつhost再実行0である。
- [ ] network、host source、control plane、unrelated host pathへ到達できない実Docker E2Eが通る。
- [ ] workspace変更破棄、output redaction、16 KiB tail、cleanup確認、receipt／audit metadata制約が通る。
- [ ] substrate／daemon unavailable以外がapprovalへfallbackしない。
- [ ] full testがignored／ローカル専用fixtureに依存せず再現可能に通る。
- [ ] 最終のspec／standards／security reviewが`APPROVE`になる。
- [ ] commitまたはhandoff記録に最終検証結果を追記し、PR作成を依頼された場合にmerge-readyとして提示できる。

## 検証

```bash
node --version # v22.x
pnpm typecheck
pnpm lint
pnpm test
pnpm test:structural
pnpm corpus
pnpm probe:adversarial
pnpm exec vitest run src/__tests__/contained-execution-docker.integration.test.ts
```

Docker integrationは、明示的に設定されたlocal Docker executable／unix socketと、事前配置済みの
imageを使う。imageのpullや自動buildは行わない。

## 依存

- [0002: Contained Execution 改良版をremote draft branchとして公開する](./0002-publish-contained-execution-draft-branch.md)

## 関連資料

- [Contained Unknown Execution実装plan](../superpowers/plans/2026-08-18-contained-unknown-execution.md)
- [Execution boundary map](../execution-boundary-map.ja.md)
- [Guarantee table](../guarantee-table.md)
