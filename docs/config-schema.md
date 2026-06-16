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
| `approval` | object | `flow: one_step` | Approval UX — see below |
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

Terminology: **provider** = 社名・サービス名 (judge.providerId); **driver** = API
compatibility layer (`judge.provider`); **host** = install target (`config.adapter`).

| Field | Values | Default |
|-------|--------|---------|
| `provider` | `"ollama"` \| `"openai-compatible"` \| `"anthropic"` | catalog driver per `providerId` |
| `providerId` | `"ollama"` \| `"codex"` \| `"claude"` \| `"cursor"` | host-matched on fresh init |
| `model` | string | catalog default per `providerId` |
| `endpoint` | URL \| `null` | catalog default; optional for cloud providers in v1 |
| `timeoutMs` | number | `25000` (ollama) / `8000` (cloud) |
| `keepAlive` | string | `"30m"` (ollama only) |
| `cloudConsent` | object | unset until TTY or capability approval records egress opt-in |
| `credential` | `{ mode: "project" }` \| `{ mode: "apiKey", ref: "store:judge" \| "env:NAME" }` | `project` on fresh init; never `apiKey` in team config |

Legacy read aliases: `local` → `ollama`, `openai` → `codex` (normalized on load; not written on fresh init).

Fresh default follows **host** (`config.adapter`): `cursor` → `cursor`, `claude` → `claude`,
`codex` → `codex`. Prefer **`belay config`** (interactive) or `belay config set judge.providerId <id>`
for judge changes. `belay judge use` remains a secondary path. Cloud egress requires recorded
`cloudConsent` (during `belay config`, interactive TTY with `--accept-cloud`, or capability
approval); `--accept-cloud` is ignored in non-interactive mode. API keys: env vars, or
`belay config credential set --key-stdin`. Cloud providers may use native CLI transport
without `judge.endpoint` when the host CLI is available; HTTP transport requires endpoint
and recorded `cloudConsent`. Use `--migrate-judge-default` on `belay init` / `belay upgrade`
to opt in to migrating an implicit factory-default `ollama` judge to the host default provider.
Outbound text is scrubbed before any cloud judge call (HTTP and native CLI transports).
Non-TTY consent: `belay judge consent <provider-id>` → `belay approve <id>` →
`belay judge use … --cloud-consent-approval-id <id>`.

#### Notes

- **`model: auto`** — legacy values normalize to the catalog default on load (warning); new `auto` input is rejected.
- **Model discovery** — production uses `judge-model-discovery.ts`; unit tests mock probes. Optional live probe: `BELAY_LIVE_CLI_DISCOVERY=1`.
- **Interactive config** — installed repos default to judge-only setup; full `init` setup remains available when hooks are missing or when declined.
- **Transport vs consent** — HTTP requires endpoint + `cloudConsent`; native CLI transport does not.

### CLI examples (`belay config`)

```bash
belay config                              # interactive setup (primary)
belay config list
belay config get judge.model
belay config set judge.providerId codex
belay config unset judge.endpoint
belay config credential mode project
belay config credential set --key-stdin
belay config judge                        # same summary as belay judge status
```

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

When `enabled: true` and `runtime` is not `none`, `gate-engine` applies an fs-scope
boundary: shell redirects and mutations targeting paths outside the repository deny unless
the path is on the fs-scope allowlist (`belay approve <id> --scope path`). This is separate
from the L3 restorability floor (repo-outside local-recoverable mutations are allowed at
default L3 after Tier1 — see ADR-002).

## `approval`

Controls post-approval UX. Existing configs migrate to `one_step` on load.

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `flow` | `"one_step"` \| `"two_step"` | `"one_step"` | `two_step` = approve then manually retry (legacy) |
| `autoReplayScopes.shell` | boolean | `true` | Shell replay hints + `belay approve --replay` |
| `autoReplayScopes.tool` | boolean | `false` | Tool actions fall back to manual retry |
| `autoReplayScopes.subagent` | boolean | `false` | Subagent actions fall back to manual retry |
| `executionLeaseMs` | number | `60000` | Duplicate hook invocations share one approval |

`one_step` returns structured replay hints from editor approval hooks when shell auto-replay
is enabled. Tool and subagent paths always fall back to `two_step` instructions until their
scopes are explicitly enabled. `belay approve <id> --replay` runs shell commands only when
`--replay` is passed explicitly; a successful CLI replay consumes the grant (do not also retry
via hooks).

Set `"approval": { "flow": "two_step" }` in `belay.config.json` to restore the previous UX.

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
