# Config schema v3 (stable in 1.x)

`belay.config.json` uses `"version": 3`. v1 and v2 configs migrate on load via
`migrateConfig` / `normalizeConfig` in `src/core/config.ts`.

Full v0.3 introduction: [SPEC-v0.3.md](./SPEC-v0.3.md). v1.0 adds layered fields
from v0.7–v0.9 (documented here).

## Top-level (stable)

| Field | Type | Default (fresh) | Notes |
|-------|------|-----------------|-------|
| `version` | `3` | `3` | Required |
| `mode` | `"enforce"` \| `"audit"` | `"enforce"` | Audit logs would-block without denying |
| `approvalTtlMinutes` | number | `15` | One-shot approval TTL |
| `tokenPrefix` | string | `"/belay-approve"` | |
| `gates` | object | all enabled | `shell`, `subagent`, `fileMutation`, `toolShell` |
| `classifier` | object | | `strictChains`, `sensitivePaths` |
| `policy` | object | fail-closed | See below |
| `overrides` | object | empty | `allow`, `external` command keys |
| `redaction` | object | masks on | Audit scrubbing |
| `controlPlane` | object | enabled | See below |
| `notifications` | object | | webhook / command hook |
| `approvalSigning` | object | `required: false` | Signed OOB approval tokens |
| `egress` | object | disabled | L1 partial — egress proxy |
| `sandbox` | object | disabled | L1-full — external sandbox broker |
| `audit` | object | | `logPath`, `includeAssessment` |

## `policy` (stable)

| Field | Values | Default |
|-------|--------|---------|
| `unknownLocalEffect` | `"deny"` \| `"allow_flagged"` | `"deny"` |
| `unparseableShell` | `"deny"` \| `"allow_flagged"` | `"deny"` |
| `confidenceThresholds` | `{ allow, flag }` | `0.88` / `0.72` |
| `modelAssist` | `{ enabled, timeoutMs }` | off |
| `transactional` | object | off — L2 observed diff |

## `controlPlane` (stable)

| Field | Notes |
|-------|-------|
| `enabled` | User-level state dir when true |
| `configDir` | Override path |
| `integrity` | `"none"` \| `"hash-pinned"` |
| `spikeOnPrompt` | OQ3 validation hook |
| `isolation.mode` | `"none"` \| `"read-only-mount"` \| `"separate-user"` |
| `isolation.verifyAgentWritable` | Doctor probe |
| `isolation.expectedOwnerUid` | Optional uid check |

## `egress` (v0.7+, stable)

| Field | Default |
|-------|---------|
| `enabled` | `false` |
| `listenHost` | `127.0.0.1` |
| `listenPort` | `17831` |
| `demoteL3External` | `true` when enabled |

## `sandbox` (v0.9+, stable)

| Field | Default |
|-------|---------|
| `enabled` | `false` |
| `runtime` | `"none"` \| `"cursor-sandbox"` \| `"container"` \| `"seatbelt"` \| `"landlock"` |
| `denyNetworkByDefault` | `true` |

## Presets

Use `agent-belay init --preset <name>` or team config `preset` field:

| Preset | Purpose |
|--------|---------|
| `standard` | Default enforce mode |
| `strict` | Higher confidence thresholds, fail-closed |
| `audit-first` | Audit mode + fail-closed policy |
| `l1-full-recommended` | Adversarial stack (see [SPEC-v1.0.md](./SPEC-v1.0.md)) |

## Migration

| From | Behavior |
|------|----------|
| v1 / v2 | Automatic merge to v3 on load |
| v0.x command lists | Use `overrides.allow` / `overrides.external` |

Breaking schema changes require agent-belay **2.0.0**.
