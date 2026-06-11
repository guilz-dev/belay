# Changelog

## 0.7.0

### Added

- **Egress chokepoint (L1, opt-in)** — `egress.enabled` runs a local HTTP(S) proxy that observes outbound connections and blocks unknown destinations pending approval
- `agent-belay egress start|stop|status|env` — manage the egress proxy process and print recommended `HTTP_PROXY` / `HTTPS_PROXY` variables
- Egress approvals reuse the existing one-shot approval loop (`kind: egress`); `agent-belay approve --scope domain` persists host allowlist entries
- **L3 demotion** — when egress is enabled with `demoteL3External`, external-command shell rules become `allow_flagged` hints (`l3_external_hint`) instead of `deny_pending_approval`; L1 proxy is the real external boundary
- `explain` and `doctor` report egress layer status; doctor warns when egress is enabled but the proxy is not running

### Changed

- Config v3 adds `egress` section (`enabled`, `listenHost`, `listenPort`, `demoteL3External`)

## 0.6.0

### Added

- `agent-belay audit query|summarize|replay` — filter and replay audit NDJSON
- `agent-belay simulate --config <path>` — dry-run config against recent audit history
- Layered config resolution (builtin → team → repo → protected)
- Signed out-of-band approval tokens (`approvalSigning.required`) with notification hooks
- Metrics v2 fields in audit summarize

## 0.3.3

### Fixed

- `dogfood --enforce` requires a passing OQ3 spike when `spikeOnPrompt` is enabled (`--force` to override)
- `metrics` requires at least 20 gate events before recommending enforce with zero would-block rate

## 0.3.2

### Added

- `agent-belay dogfood` enables OQ1 audit + fail-closed policy (optional `--enforce`, `--force`, `--no-spike`)
- `agent-belay init --dogfood` initializes with dogfood config
- `status` and `doctor` show dogfood readiness and OQ3 spike results (`oq3-spike-last.json`)
- `docs/v0.3-remaining.md` — v0.3 line closure checklist (ship + operational validation)

## 0.3.1

### Added

- `agent-belay metrics` — audit log analysis for OQ1 dogfood (`wouldBlock` rate, top reasons, enforce readiness)
- Gate audit records include `mode`, `wouldBlock`, and `permission` for dogfood measurement
- `controlPlane.spikeOnPrompt` and `BELAY_OQ3_SPIKE=1` run OQ3 filesystem validation from `beforeSubmitPrompt`
- `agent-belay doctor --fix` / `--dry-run` migrate or archive orphaned approval state files
- Reverse control-plane → repo-local approval migration when control plane is disabled
- Nested and multiple `$(...)` / backtick substitution detection with escaped `\$(...)` support

### Changed

- Audit mode records would-block events without creating pending approvals

### Fixed

- Shell classifier merges substitution analysis with outer command segments (no bypass via benign `$(...)`)
- Command substitution ignored inside single/double quotes
- Reverse control-plane migration on upgrade only when repo-local approvals are empty
- Dogfood metrics notes updated for audit mode without pending approvals

## 0.3.0

### Added

- Config v3 schema with `policy`, `overrides`, `redaction`, and `controlPlane` sections
- Automatic v1/v2 → v3 migration with `custom*` → `overrides` mapping (M1)
- Fail-closed shell policy via `policy.unknownLocalEffect: "deny"` with override escape hatches
- Shell hardening: `eval`/`source` deny, command substitution handling, override precedence (T4)
- User-level control plane for approval state (`controlPlane.enabled`)
- Approval file migration from repo-local to control plane on first enable
- Write-tool and shell deny for control-plane path mutations (R8)
- Config-driven audit redaction for bearer tokens, auth headers, key/value secrets
- Symlink-aware path resolution via `realpath` (R5)
- OQ3 control-plane filesystem spike and `docs/SPEC-v0.3.md` / `docs/ROADMAP.md`

### Changed

- `explain` and `status` output include policy, overrides, and approval state directory
- Approval state paths resolve to control plane or repo-local based on config

### Fixed

- Merge repo-local approvals into existing control-plane files by `approvalId` (target wins)
- Classifier fingerprints and summaries honor config `redaction` settings
- Remove redundant pre-scrub in postToolUse audit hook (`appendAudit` scrubs once)
- Doctor warns on orphaned control-plane or stale repo-local approval files
- Gate audit events use config-driven redaction
- Version-less configs with v3 sections migrate correctly; doctor warns when `version` is missing
- Fail-closed mode denies all command substitution, not only risky inner commands

## 0.2.0

### Added
- Testable core modules under `src/core/`
- Config v2 with gate toggles and classifier overrides
- Tool gates for Shell, Write, StrReplace, Delete
- Additional subagent matchers (`computerUse`, `debug`, `explore`, `videoReview`, `bugbot`)
- CLI commands: `upgrade`, `status`, `explain`, `revoke`
- `agent-belay/core` package export

### Changed
- Runtime is esbuild-bundled instead of embedded template strings
- `init` merges existing config; `upgrade` refreshes runtime/hooks only
- Shell tool approvals now share fingerprints with shell hook denials
- `explain` supports `--kind shell|tool|subagent`
- `RUNTIME_BUILD_STAMP` records package version and install timestamp

### Security
- Deny `bash -c` / `sh -c` wrappers around high-risk inner commands
- Reclassify `node -e` / `node --eval` via inner script analysis
- Flag `sed -i` and bare `node`/`sed` invocations
- Require exact matches for custom allow/external command rules

## 0.1.0

Initial release.
