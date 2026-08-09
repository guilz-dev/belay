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

`credential.mode` controls how Tier1 cloud Judge obtains API keys:

| Mode | Runtime source | Notes |
|------|----------------|-------|
| `project` | Shell `process.env`, then host CLI session when available | Checks `BELAY_JUDGE_API_KEY` first, then provider vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CURSOR_API_KEY`). **Does not read `.env` files** — export vars in your shell/IDE or use direnv. |
| `apiKey` | `credentials.json` (`store:judge`) or `env:NAME` | `store:judge` writes to Belay state (`~/.config/belay/` when control plane is enabled, otherwise repo-local). File mode `0600`. Team config cannot set `apiKey`. |

Interactive `belay config` asks for **Judge API key source** with these two choices instead of a yes/no confirm.
For cloud providers it then asks **how Belay should reach the judge**: host CLI (recommended, no URL) or a custom HTTP API endpoint (requires `judge.endpoint` and cloud egress consent).
| `runtime` | object | optional session/shadow transport tuning; Cursor session mode uses persistent ACP (see [judge session rollout](./judge-session-rollout.md)) |

`belay judge bench` reports in-process Tier0/Tier1 latency percentiles and SLO status.

Legacy read aliases: `local` → `ollama`, `openai` → `codex` (normalized on load; not written on fresh init).

Fresh default follows **host** (`config.adapter`): `cursor` → `cursor`, `claude` → `claude`,
`codex` → `codex`. Prefer **`belay config`** (interactive) or `belay config set judge.providerId <id>`
for judge changes. `belay judge use` remains a secondary path. Cloud egress requires recorded
`cloudConsent` (during `belay config`, interactive TTY with `--accept-cloud`, or capability
approval); `--accept-cloud` is ignored in non-interactive mode. API keys: `project` mode
reads shell env vars (see table above; no `.env` auto-load), or `belay config credential set --key-stdin`
for `apiKey` mode. Cloud providers may use native CLI transport
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
belay config set judge.runtime.session.enabled true
belay config set judge.runtime.shadow.enabled false
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

### `policy.transactional.checkpoint` (Recovery v1)

Checkpointing is separately opt-in. It applies only to observed-safe repository-local
filesystem changes produced by the git-worktree transactional runner.

| Field | Default | Notes |
|-------|---------|-------|
| `enabled` | `false` | Persist pre-images before applying an observed-safe diff |
| `appliedRetentionHours` | `168` | Retention for applied, not-yet-restored checkpoints |
| `restoredRetentionHours` | `24` | Retention after restore |
| `maxCheckpoints` | `20` | Per-repository limit; fails closed when safe GC cannot reserve a slot |
| `maxBytes` | `1073741824` | 1 GiB per-repository hard quota; fails closed before repo mutation |

Restore uses `belay recover apply <checkpoint-id>`. The first invocation creates an
exact, expiring one-shot approval bound to the repository, manifest hash, post-state
hash, and path set. Recovery approval always requires the signed token delivered through
a configured out-of-band notification channel, even when general approval signing is
optional. After `belay approve <approval-id> --token <signed-token>`, invoke the same restore
command again. There is no standing allow, auto-replay, `--yes`, or force-restore path.

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

`one_step` immediately replays the stored exact shell command from editor approval hooks when shell
auto-replay is enabled; no follow-up prompt is required. The one-shot grant is atomically claimed
before replay, and the command runs through the configured `BoundaryDriver`. A failed, timed-out,
or ambiguous replay is not re-armed and requires a fresh approval. A prompt may include follow-up
instructions after the approval line; they continue only after replay succeeds. Tool and subagent
paths fall back to `two_step` instructions. CLI approval remains non-executing by default:
`belay approve <id> --replay` runs a shell command only when `--replay` is passed explicitly.

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
