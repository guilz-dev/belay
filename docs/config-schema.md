# Config schema (v4)

`belay.config.json` uses `"version": 4`. v1/v2/v3 configs migrate on load via
`migrateConfig` / `normalizeConfig` in `src/core/config.ts` (the authoritative source for
exhaustive field defaults).

## Top-level

| Field | Type | Default (fresh) | Notes |
|-------|------|-----------------|-------|
| `version` | `4` | `4` | Required |
| `adapter` | `"cursor"` \| `"claude"` \| `"codex"` | detected | Host adapter |
| `installScope` | `"project"` \| `"global"` | `"project"` | Where hooks/runtime/skill are installed (see below) |
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
| `judge` | object | local-ollama | Tier1 judge provider (see below) |

## `installScope`

Determines where `init` writes hooks, runtime, and skill artifacts. Wider scope requires
explicit opt-in (`--scope`).

| Value | Cursor / Claude / Codex | Blast radius |
|-------|-------------------------|--------------|
| `project` (default) | `.cursor/` · `.claude/` · `.codex/` | this repository |
| `global` | `~/.cursor/` · `~/.claude/` · `~/.codex/` | the user's sessions |

`managed` (Codex, pre-trusted, `/etc/codex/…`, sudo) is a deployment mode, not yet implemented.

## `judge` (Tier1 provider)

| Field | Values | Default |
|-------|--------|---------|
| `provider` | `"ollama"` \| `"openai-compatible"` | `"ollama"` |
| `model` | string \| `"auto"` | `"gemma4:e2b"` (ollama) |
| `endpoint` | URL | `http://localhost:11434` (ollama); **required** for `openai-compatible` |
| `timeoutMs` | number | `25000` (ollama) |
| `keepAlive` | string | `"30m"` (ollama) |

Fresh default is **local-ollama** (no egress). `openai-compatible` (cloud) requires explicit
consent via `init --accept-cloud-judge`; API key is read from env, never stored in config.
Outbound text is scrubbed before any cloud judge call.

## `policy`

| Field | Values | Default |
|-------|--------|---------|
| `unknownLocalEffect` | `"deny"` \| `"allow_flagged"` | `"allow_flagged"` |
| `unparseableShell` | `"deny"` \| `"allow_flagged"` | `"deny"` |
| `codexUnmappedTool` | `"deny"` \| `"allow"` | `"deny"` (ask on unmapped Codex tools; `allow` records to audit) |
| `fenceWarnThreshold` | number | `0.5` (silent-pass rate below which `report`/`doctor` warn of over-blocking) |
| `confidenceThresholds` | `{ allow, flag }` | `0.88` / `0.72` |
| `modelAssist` | `{ enabled, timeoutMs }` | off |
| `transactional` | object | off — L2 observed diff |

## `controlPlane`

| Field | Notes |
|-------|-------|
| `enabled` | User-level state dir when true |
| `configDir` | Override path |
| `integrity` | `"none"` \| `"hash-pinned"` |

## `egress` (L1 partial)

| Field | Default |
|-------|---------|
| `enabled` | `false` |
| `listenHost` | `127.0.0.1` |
| `listenPort` | `17831` |
| `demoteL3External` | legacy — **not applied** to the shell classifier (proxy enforces read/mutate/exfil itself; `git push` etc. stay `ask`) |

## `sandbox` (L1-full)

| Field | Default |
|-------|---------|
| `enabled` | `false` |
| `runtime` | `"none"` \| `"cursor-sandbox"` \| `"container"` \| `"seatbelt"` \| `"landlock"` |
| `denyNetworkByDefault` | `true` |

## Presets

Use `belay init --preset <name>` or the team config `preset` field:

| Preset | Purpose |
|--------|---------|
| `standard` | Default enforce mode |
| `strict` | Higher confidence thresholds, fail-closed |
| `audit-first` | Audit mode + fail-closed policy |
| `l1-full-recommended` | Adversarial L1-full stack |

## Migration

| From | Behavior |
|------|----------|
| v1 / v2 / v3 | Automatic merge to v4 on load (`migrateConfig`) |
| v0.x command lists | Use `overrides.allow` / `overrides.external` |

Versioning follows [semver-policy.md](./ops/semver-policy.md). The restorability floor and its
rules are described in [CONCEPT.md](./CONCEPT.md) / [adr/ADR-002-concept-conformance.md](./adr/ADR-002-concept-conformance.md).
