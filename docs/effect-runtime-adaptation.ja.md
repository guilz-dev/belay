# Effect runtime adaptation (Jacquard-inspired)

Status: **Active**  
Related: [effect-typed-capability-proposal.ja.md](./effect-typed-capability-proposal.ja.md), [execution-boundary-map.ja.md](./execution-boundary-map.ja.md)

## What we adopt (design patterns)

| Jacquard concept | Belay adaptation |
|------------------|------------------|
| Effect row on every function | `EffectPlan` — normalized `EffectRequirement[]` per gated action |
| Checker rejects incomplete rows | Policy conjunction: all flattened capability requests must allow |
| `--allow` grants authority | Resource-scoped grant bundle bound to input fingerprint |
| Handler swaps worlds | Boundary driver test harness: real container, record/replay, fake deny |
| Kernel IR (27 forms) | `effect-ir` tree: launcher phases + exec leaves |

## 一般 shell の判定 authority

正規化できた一般 shell は
`shell-lower.ts` → canonical `EffectPlan` → `policy.ts` の projection を唯一の判定根拠とする。
旧 `VerdictEffect`、command head の集合、`overrides.allow` / `overrides.external`、
corpus catalog、legacy standing-allow（shell / tool / subagent）は permission を変更しない。

- payloadなしの外部readは `allow`
- repo/workspace-localな可逆 mutation は `allow_flagged`
- 外部 mutation、明示 payload/file/secret 送信、high-stakes、destructive Git、
  partial/indeterminate は ask
- `git fetch` / `git pull` は network read + local reversible update なので
  `allow_flagged`
- linked worktree は canonical Git common-dir が一致するときだけ同一repositoryとして扱う

one-shot approval と resource-scoped grant は command allowlist ではない。exact
fingerprint/resource/request と、存在する場合は EffectPlan/request hash、TTL、use count
に束縛された承認artifactとして維持する。

## What we do not adopt

- OCaml checker / evaluator as a runtime dependency
- Static effect typing of agent shell strings (runtime text until execution)
- Package-name allowlists (`PNPM_EXEC_LIKE_HEADS` style shortcuts)
- Claiming OS sandbox when `host-integration` attestation is `deniesUngrantedEffects: false`

## Module layout

- `src/core/effect-ir/types.ts` — `EffectPlan`, `EffectRequirement`, `EffectNode`
- `src/core/effect-ir/package-exec.ts` — `npx` / `npm exec` / `pnpm dlx` lowering
- `src/core/effect-ir/shell-lower.ts` — shell grammar / launcher / egress / Git を effect へ lower
- `src/core/effect-ir/shell-build.ts` — shell segment から canonical plan を構築
- `src/core/effect-ir/build.ts` — requirement 収集と `CapabilityRequestV1[]` への flatten
- `src/core/effect-ir/policy.ts` — 全 requirement の policy conjunction と最悪値 projection
- `src/core/effect-ir/audit.ts` — canonical hash for audit correlation

## Grant bundle migration (Gate B / E)

**Decision:** use `approval.grants[]` as the canonical bundle; keep `approval.grant` as the first grant for dual-read.

| Field | Role |
|-------|------|
| `capabilityRequests[]` | Flattened requests at ask time (sorted hash via `capability-requests:v1`) |
| `capabilityRequestHash` | Replay binding for request set equality |
| `effectPlanHash` | Optional replay binding for composite EffectPlan (`effect-plan:v1`) |
| `grants[]` | One scoped grant per request after approval |
| `grant` | Legacy dual-read alias of `grants[0]` |

**Dual-read/write:** `normalizeApprovalGrants()` exposes legacy single-grant records as a one-element bundle. `mintGrantForApprovedRecord()` writes both `grants[]` and `grant`. Rollback = ignore `grants[]` and read `grant` only.

**Hash versioning:** existing approvals without `effectPlanHash` remain valid; mismatch checks apply only when the field is present on the approved record.

## PackageExec composite effects

`npx vitest run` decomposes to:

1. `invoke` — launcher surface
2. `resolve` / `delegate` — inner command when argv is peeled
3. `acquire` — `network.connect` when local bin cannot be proven (`-y`, registry spec, missing bin)
4. `exec` — inner segment semantics via recursive verdict (unchanged policy)

No special case for `@guilz-dev/belay` or other package names.
