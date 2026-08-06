# Capability-based 判定基盤 — 実装チェックリスト

元計画: capability migration PLAN（sync PolicyEngine + async shadow）

## Public interfaces and domain model

- [x] `CapabilityRequestV1`（principal / action / resource / context / evidence）
- [x] 同期 `PolicyEngine` + `PolicyDecision`（allow | require_approval | deny）
- [x] `CapabilityGrantV1` 型（principal・action・resource・fingerprint・TTL・uses）
- [x] `BoundaryAttestation` 型（driver・probe・expires・materializesGrants）
- [x] `GateVerdict` 拡張（`capabilityRequests` / `authorizationDecision`）
- [x] `boundaryProfile` フィールド
- [x] `docs/CONTEXT.md` 用語・不変条件
- [x] ADR-003 resource-scoped capability authorization
- [x] ADR-001 Accepted 化の明示（既存 Accepted、CONTEXT からリンク済み）

## 1. 決定的な判定核

- [x] shell / tool / subagent を PolicyEngine 経由（`capability/resolver.ts`）
- [x] Tier1 同期 judge を gate から除去
- [x] file mutation の LLM 判定廃止
- [x] prescan / path / launcher 解析の再利用
- [x] 入力上限（shell 64 KiB / tool 1 MiB）→ `input_too_large`
- [x] `boundaryProfile` 伝播（adapter / gate-contract / classify-*）
- [x] `agentAssessment` は mismatch 検知のみ（grant / attestation 未使用）

## 2. TypeScript policy kernel

- [x] precedence: forbid → grant → boundary → builtin → default
- [x] repo 内 routine read/write allow
- [x] sensitive / control-plane / git.ref.write 承認対象
- [x] network（GET 含む）承認対象
- [x] broad grant / forgery は deny
- [x] stale attestation は fail-closed（テスト）
- [x] opaque / unparseable の全面 policy 統一（一部 tier0 残存）

## 3. Approval と grant の統合

- [x] Approval state v3 + v1/v2 移行
- [x] 承認の `CapabilityGrantV1` 正規化
- [x] atomic lease + reference monitor 消費
- [x] replay に capability request hash
- [x] `deny_pending_approval` 自動承認なし

## 4. 実境界と reference monitor

- [x] `BoundaryDriver`（probe / prepare / run / materializeGrant）— host-integration スタブ
- [x] Docker container driver
- [x] egress proxy chokepoint
- [x] transactional runner の host spawn 廃止（BoundaryDriver 経由）
- [x] `belay session start`
- [x] attestation なし editor は L3/L4 のみ表示

## 5. LLM shadow と rollout

- [x] `judge.mode: shadow | off`（config 正規化）
- [x] `Tier1Judge` を `VerdictContext` / `ClassifierOptions` から除去
- [x] gate 監査への decision trace 完全記録（capability / policy フィールド）
- [x] doctor を shadow advisory に格下げ
- [x] shadow mismatch / approval 率 ratchet

## Test and acceptance plan

- [x] gate 経路で `createJudgeFromConfig` 非呼び出し（shell / tool / subagent）
- [x] classification 層の judge 静的 import 禁止
- [x] shell / tool / subagent の capability conformance（単体）
- [x] adapter capability conformance（cursor / claude）
- [x] adversarial corpus 拡充（xargs / find -exec / opaque / secret curl）
- [x] attestation 期限切れ fail-closed テスト
- [x] gate 同期分類 p95 予算テスト
- [x] hook / approval v1/v2 fixture 回帰（既存）
- [x] container integration test
- [x] guarantee table「設定済み vs 実測 attested」分離
