# 0001 Contained Execution の保証契約を確定する

## 種別

AFK

## 対象ユーザーストーリー

allowlistやコマンド固有ルールを追加せず、`unknown_local_effect` を検証済みの
Contained Execution境界で安全に実行できる改良版を、誤った保証表現を残さず
remote保存可能な状態にする。

## 作るもの

実装planのTask 6と、レビュー記録
`.superpowers/sdd/2026-08-18-contained-unknown-execution/task-6-review.md`で残った
machine-readable保証契約を、実際のgate挙動と一致させる。

- audit modeはBelay自身がattestation読取り、mirror準備、container起動を行わない。
- audit modeのgateは`permission: allow`を返し、host実行をhostへ委譲する。
- approval fallbackは、実行前のDocker substrate／daemon unavailableの2理由だけとする。
- それ以外のcapability、image、mirror、lease、create、inspect、start、cleanup失敗は、
  approvalを作成・消費せずhost実行をdenyする。
- container開始後のtimeout／nonzero exitは`contained_execution_failed`、exit 0は
  `contained_execution_complete`として終端する。
- 内部reason codeの不完全な列挙ではなく、安定したfailure categoryとoutcomeで契約する。

既存のproduction Docker E2E、EffectPlan-only authority、command allowlist禁止、
copy-only mirrorの判断は変更しない。

## 受け入れ基準

- [ ] `audit.executesHostCommand: false`のような実挙動と矛盾する保証が残っていない。
- [ ] audit modeで`wouldMediate: true`、`permission: allow`、attestation／mirror／Docker呼出し0を同じテストが検証する。
- [ ] approval fallbackの理由集合がsubstrate unavailableとdaemon unavailableの2件だけである。
- [ ] その他のsetup／boundary failureが`permission: deny`、approval IDなし、approval state mutation 0になる。
- [ ] exit 0、nonzero、timeoutの結果とhost二重実行防止がmachine-readable契約から検証される。
- [ ] README、CONTEXT、ADR-006、execution boundary map、guarantee tableが同じaudit／failure契約を説明する。
- [ ] Task 6の独立再レビューが`APPROVE`になる。
- [ ] tracked worktreeに意図しないファイルやignored SDD reportが含まれない。

## 検証

```bash
pnpm vitest run \
  src/__tests__/conformance/contained-execution-guarantee.test.ts \
  src/__tests__/contained-execution-gate.test.ts
pnpm typecheck
pnpm test:structural
pnpm exec biome check \
  src/conformance/contained-execution-guarantee.ts \
  src/adapters/shared/gate-runtime.ts \
  src/__tests__/conformance/contained-execution-guarantee.test.ts \
  src/__tests__/contained-execution-gate.test.ts
git diff --check
```

## 依存

なし。

## 関連資料

- [Contained Unknown Execution実装plan](../superpowers/plans/2026-08-18-contained-unknown-execution.md)
- [ADR-006: Contained Unknown Execution](../adr/ADR-006-contained-unknown-execution.md)
- [Guarantee table](../guarantee-table.md)
