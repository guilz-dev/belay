# Capability-based 判定基盤 — 実装チェックリスト

元計画: capability migration PLAN（sync PolicyEngine + async shadow）

## 完了済み（コア移行）

### Public interfaces and domain model

- [x] `CapabilityRequestV1`（principal / action / resource / context / evidence）
- [x] 同期 `PolicyEngine` + `PolicyDecision`（allow | require_approval | deny）
- [x] `CapabilityGrantV1` 型（principal・action・resource・fingerprint・TTL・uses）
- [x] `BoundaryAttestation` 型（driver・probe・expires・materializesGrants）
- [x] `GateVerdict` 拡張（`capabilityRequests` / `authorizationDecision`）
- [x] `boundaryProfile` フィールド
- [x] `docs/CONTEXT.md` 用語・不変条件
- [x] ADR-003 resource-scoped capability authorization
- [x] ADR-004 EffectPlan authority（ADR-003 の network-read 一律 ask を supersede）
- [x] ADR-001 Accepted 化の明示（既存 Accepted、CONTEXT からリンク済み）

### 1. 決定的な判定核

- [x] shell / tool / subagent を PolicyEngine 経由（`capability/resolver.ts`）
- [x] Tier1 同期 judge を gate から除去
- [x] file mutation の LLM 判定廃止
- [x] prescan / path / launcher 解析の再利用
- [x] 入力上限（shell 64 KiB / tool 1 MiB）→ `input_too_large`
- [x] `boundaryProfile` 伝播（adapter / gate-contract / classify-*）
- [x] `agentAssessment` は mismatch 検知のみ（grant / attestation 未使用）

### 2. TypeScript policy kernel

- [x] precedence: forbid → grant → boundary → builtin → default
- [x] repo 内 routine read/write allow
- [x] sensitive / control-plane / git.ref.write 承認対象
- [x] network は payloadなしreadを allow、mutation / payload / secret / 不定を承認対象
- [x] broad grant / forgery は deny
- [x] stale attestation は fail-closed（テスト）
- [x] opaque / unparseable の policy 統一（内部シグナル `tier0_external` は監査互換のため残存）

### 3. Approval と grant の統合

- [x] Approval state v3 + v1/v2 移行
- [x] 承認の `CapabilityGrantV1` 正規化
- [x] atomic lease + reference monitor 消費
- [x] replay に capability request hash
- [x] `deny_pending_approval` 自動承認なし

### 4. 実境界と reference monitor

- [x] `BoundaryDriver`（probe / prepare / run / materializeGrant）— host-integration スタブ
- [x] `BoundaryDriver.prepare()`（optional + run 内 fallback）
- [x] Docker container driver
- [x] egress proxy chokepoint
- [x] transactional runner の BoundaryDriver 経由実行（host-integration は L3 向けに host spawn 残存）
- [x] `belay session start`
- [x] attestation なし editor は L3/L4 のみ表示

### 5. LLM shadow と rollout

- [x] `judge.mode: shadow | off`（config 正規化）
- [x] `Tier1Judge` を `VerdictContext` / `ClassifierOptions` から除去
- [x] gate 監査への decision trace 完全記録（capability / policy フィールド）
- [x] doctor を shadow advisory に格下げ
- [x] shadow mismatch / approval 率 ratchet

### Test and acceptance plan（達成済み）

- [x] gate 経路で `createJudgeFromConfig` 非呼び出し（shell / tool / subagent）
- [x] classification 層の judge 静的 import 禁止
- [x] shell / tool / subagent の capability conformance（単体）
- [x] adapter capability conformance（cursor / claude）
- [x] attestation 期限切れ fail-closed テスト
- [x] gate 同期分類 p95 予算テスト（shell + tool + subagent、Step 1 床値は PLAN より緩い）
- [x] hook / approval v1/v2 fixture 回帰（既存）
- [x] container integration test（基本のみ — mount RO/RW、echo、materializeGrant）
- [x] guarantee table「設定済み vs 実測 attested」分離

---

## 残作業プラン（レビュー反映版）

レビュー日: 2026-08-06。デグレ・リファクタ観点でスコープを調整済み。

### スコープ外（意図的延期）

| 項目 | 理由 |
|------|------|
| Cedar WASM policy backend | 初期リリースでは追加しない（PLAN 前提） |
| Seatbelt / Landlock driver 実装 | 型定義のみ。後続フェーズ |
| legacy sync transport / judge 設定削除 | shadow 1 リリース観測後 |
| `tier0_external` シグナル一括 rename | `adapter.mapLegacyReason` で hook 出力は既に `external_effect`。rename はコスト > 利益 |
| `git-worktree.runShellCommand` 削除 | host-integration driver が依存（L3 廃止まで不可） |
| effect-typed capability proposal | 別提案（`docs/effect-typed-capability-proposal.ja.md`） |

### 実装順序

```text
Phase 7 (docs) → Phase 1 (prepare) → Phase 2a/2b (tests) → Phase 5 → Phase 3 → Phase 6
```

### Phase 7: ドキュメント整合（PR-A、リスク: 低）

**目的:** 実装済み内容とドキュメントの乖離を解消。他フェーズと並行可能。

| ファイル | 修正 |
|----------|------|
| `docs/CONTEXT.md` | 「Out of scope」に記載の v3 / Docker / p95 を完了済みに更新 |
| `docs/guarantee-table.md` | repo-outside の Tier1 記述を ADR-003 / PolicyEngine 前提に更新 |
| `docs/effect-typed-capability-proposal.ja.md` | transactional runner は BoundaryDriver 経由。host spawn は L3 host-integration に限定と注記 |

- [x] CONTEXT.md 更新
- [x] guarantee-table.md 更新
- [x] effect-typed proposal 注記

### Phase 1: `BoundaryDriver.prepare()`（PR-B、リスク: 中）

**目的:** PLAN の `probe / prepare / run / materializeGrant` を揃える。network 準備を `run()` から分離。

**段階導入（デグレ防止）:**

1. `prepare?(context)` を **optional** で追加（`BoundaryPrepareContext`: `repoRoot`, `egressProxyActive`, `proxyEnv`）
2. container driver: `prepare` で `ensureBelayContainerNetwork` を実行
3. host-integration: no-op `prepare`
4. `run()` 内に **fallback** を残す（`prepare` 未呼び出しでも network 作成）
5. `resolveBoundaryDriver()` ヘルパーで driver 構築を集約（`boundary-session.ts` の重複排除）
6. `runWithBoundaryDriver()` ヘルパー（`boundary-run.ts`）: `prepare` → `run` を一括実行
7. 呼び出し元更新: `startBoundarySession`, `runBoundaryAgentCommand`, `transactional/runner.ts`
8. fallback 削除は 1 リリース後（別 PR）

**失敗時:** `probe` 後に `prepare` 失敗 → attestation を書き込まずエラー（`startBoundarySession`）。

- [x] optional `prepare` + fallback 実装
- [x] `resolveBoundaryDriver` / `runWithBoundaryDriver` ヘルパー
- [x] 呼び出し元更新 + テスト
- [x] `prepare` 後の network 存在確認テスト

### Phase 2a: Container isolation tests（PR-C、リスク: 低）

**目的:** driver 層の FS / network 隔離を PLAN 受入に合わせて検証。

**新規:** `src/__tests__/capability/boundary-container-isolation.test.ts`

| シナリオ | 期待 | 注意 |
|----------|------|------|
| repo 外 write | exitCode ≠ 0 | RO mount 内 write 拒否で検証（container は bind mount のみ。真の host FS 外は別レイヤー） |
| control-plane write（RO mount） | exitCode ≠ 0 | RW mount 時は成功が仕様通り — テストは RO 前提 |
| ambient credential | 未設定 | 回帰ガード（既存動作の確認） |
| proxy 迂回 network（`network none`） | 接続失敗 | proxy 無効時 |

**CI:** `isDockerAvailable()` で skip（`it.skipIf`）。`verify-docker` CI job で実行。

- [x] isolation テスト追加

### Phase 2b: Grant lease gate tests（PR-C または PR-D、リスク: 低）

**目的:** one-shot grant の「1 回成功・2 回目拒否」を **正しいレイヤー** で検証。

**重要:** container `run()` は grant を検証しない（mount / network 隔離のみ）。テスト対象は gate 層。

**拡張先:** 既存 `grant-lease.test.ts`（gate-runtime 統合は `approved_once` リース経路と分離 — grant 消費は `consumeGrantLease` 単体で検証）

- [x] `consumeGrantLease` で 2 回目消費失敗

### Phase 5: L1-full fail-closed tests（PR-D、リスク: 低）

**目的:** PLAN テスト計画の未カバー: broker 停止 / guarantee posture。

**スコープ限定（新規コード追加なし、テスト追加のみ）:**

| ケース | 検証対象 |
|--------|----------|
| L1-full 設定 + proxy 停止 | `evaluateL1FullStatus` → `l1FullActive: false`；configured は `l1-partial-egress` にダウングレード（`postureMismatch` は false） |
| payloadなし network read | L3 EffectPlan は proxy 無関係で `allow`。remote mutation / payload send は引き続き `require_approval` |
| approval state 破損 JSON | 読み取り fail-closed |

**やらない:** PolicyEngine の grant forgery テスト（`policy-engine.test.ts` で既存）。

- [x] `guarantee-posture` + L1-full + proxy 停止、payload-free read / remote mutation 回帰テスト
- [x] approval state 破損 fail-closed テスト

### Phase 3: p95 遅延（PR-E、リスク: 中 — CI flake 注意）

**目的:** PLAN 基準（p95 ≤ 100ms、max ≤ 500ms）に向けた計測と ratchet。

**段階適用（一気に閾値上げない）:**

| Step | 内容 |
|------|------|
| Step 1 | shell + tool + subagent を計測対象に拡大。閾値は現行維持（p95 < 200ms、max < 1000ms） |
| Step 2 | 実測ベースラインを `src/corpus/gate-latency-budget.ts`（新規）に記録 |
| Step 3 | 閾値 = 実測 p95 × 1.2 で設定 |
| Step 4 | quality-loop ratchet で段階的に PLAN 値へ |

**計測安定化:** warm-up 1 回 + percentile 計算。tool/subagent は shell と別閾値を検討。

- [x] 計測対象拡大（Step 1）
- [x] ベースライン定数ファイル（Step 2）
- [x] 閾値 = max(実測 p95 × 1.2, Step 1 床値)（Step 3）
- [x] quality-loop ratchet advisory（`gate-latency-ratchet.ts` → sandbox `advisories`、exit code 非影響）（Step 4）

### Phase 6: Adversarial corpus（PR-F、リスク: 中）

**目的:** find -exec / secret GET / outside-repo mutation を corpus に明示登録。

**手順（デグレ防止）:**

1. 追加前に `evaluateCorpus` で期待 verdict を確認
2. corpus 追加と mutator 追加は別コミット可
3. must-ask / benign ゲートへの影響を確認

**追加候補（`corpus/shell-commands.json`）:**

- `find . -exec rm {} \;`
- `curl 'https://api.example.com?token=SECRET'`
- outside-repo mutation（symlink escape は固定パス harness では再現困難のため `touch /tmp/...` で代替）

**mutator（`src/corpus/mutators.ts`）:** `find_exec` を STRUCTURAL_PROBES に追加（probe-only）

- [x] corpus ケース追加 + eval 確認
- [x] find_exec mutator

**CI:** `.github/workflows/ci.yml` の `verify-docker` job で隔離テストを実行（Docker 未環境では `it.skipIf` で skip 可視化）

### Phase 4: Tier0 整理（縮小版、延期可）

**やることのみ:**

- [x] `egress-classify.ts` コメント更新（Tier1 → PolicyEngine / require_approval）

**やらないこと:**

- `tier0_external` reason / signal の一括 rename（`standing-allow.ts` 等 40+ 参照、デグレリスク高）
- hook 出力は `adapter.mapLegacyReason` で既に `external_effect` にマップ済み

---

## PR 分割案

| PR | 内容 | リスク |
|----|------|--------|
| PR-A | Phase 7 docs | 低 |
| PR-B | Phase 1 prepare（optional + fallback） | 中 |
| PR-C | Phase 2a isolation + 2b grant-lease | 低 |
| PR-D | Phase 5 fail-closed | 低 |
| PR-E | Phase 3 p95 Step 1–2 | 低 |
| PR-F | Phase 6 corpus | 中 |

## 各フェーズ後の回帰ガード

```bash
make verify-parallel
```

特に重要:

- `src/__tests__/capability/gate-no-judge.test.ts`
- `src/__tests__/capability/classification-no-judge-import.test.ts`
- `src/__tests__/capability/capability-conformance.test.ts`
- `src/__tests__/conformance/guarantee-posture.test.ts`
- corpus gates（must-ask / benign）

Docker 環境:

```bash
npm test -- src/__tests__/capability/boundary-container-isolation.test.ts
```

CI: `.github/workflows/ci.yml` の `verify-docker` job が同等テストを実行。

## 完了条件（Definition of Done）

- [x] `BoundaryDriver.prepare()` が optional + fallback で存在し、container / host テスト済み
- [x] container isolation テストが PLAN の FS/network シナリオをカバー
- [x] one-shot grant は gate / grant-lease 層でテスト済み（container 層ではない）
- [x] L1-full + proxy 停止時の guarantee-posture がテスト済み
- [x] p95 計測が shell + tool + subagent を含み、ベースラインが文書化されている
- [x] find -exec / secret GET が corpus に登録済み
- [x] CONTEXT / guarantee-table / 本ファイルが実装状態と一致
