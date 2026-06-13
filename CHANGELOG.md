# Changelog

## Unreleased

### Added

- **SPEC v2.3** — `agent-belay report` (R-V1/R-V2 audit visibility + fence drift warnings)
- **SPEC v2.3** — `agent-belay recover` (R-R1/R-R2 advisory recovery guidance, show-don't-run)
- Skill front-door routes: `/belay report`, `/belay recover` (+ bundled command templates)
- **SPEC v2.3** — review fixes: audit-based recover integration tests (T-R1/T-R2), fence drift deferred notes (not warnings), `--command` Tier1 notice, SECURITY/guarantee-table updates
- T23: `SKILL.md` snapshot regression test in `skill-quality.test.ts`

### Changed

- README: `init-wizard`, `--scope project|global`, install-scope caveats, and Cursor slash command artifacts
- SPEC-v2.2 / ROADMAP: WS-Skill marked implemented; G-B1 decision recorded (verification pending)
- G-B1 gate doc: decision fixed, execution/result template for Cursor smoke
- SPEC-v2.2 §6: skill quality checklist reflects shipped WS-Skill items

### Fixed

- **SPEC v2.1.2** — Tier0 now catches docker registry publish via `--push` and `--output=type=registry` (R31/R32); fixes FN on `docker buildx build --push`

### Added (v2.1.1)
- `init --judge-endpoint` for explicit cloud endpoint configuration
- Tier1 accuracy measurement harness (`src/__tests__/v2/llm/judge-accuracy.test.ts`, non-gate)
- `pnpm test:stable` — runs vitest three times for flake detection (T18)
- Test isolation via per-test `HOME` / `XDG_CONFIG_HOME` (`src/__tests__/setup.ts`)

### Changed

- Cloud judge provider renamed from `cursor` to `openai-compatible`; `cursor` is a deprecated read alias (M4)
- Fresh `init` default remains `local-ollama` only; `cursor-composer` profile removed (R27)
- `doctor` reports `BELAY_JUDGE_API_KEY` / `OPENAI_API_KEY` for cloud judge diagnostics

### Removed

- OQ3 `spikeOnPrompt` / control-plane spike wiring (R28)
- `control-plane-spike.ts`, `scripts/oq3-control-plane-spike.mjs`, and `--no-spike` CLI flag
- Default `https://api.cursor.com` cloud base URL (R25)

### Fixed

- CI runs `pnpm test:stable` (vitest x3) per SPEC T18
- Build cleans `dist/` before compile to drop removed modules
- Runtime fail-closed judge when `openai-compatible` endpoint is missing (no generic hook deny)
- README dogfood section updated for v2.1.1

### Added (v2.1)
- Judge profiles `cursor-composer` (requires `--accept-cloud-judge`) and `local-ollama` (fresh init default)
- `init` flags: `--judge-profile`, `--judge-provider`, `--judge-model`, `--accept-cloud-judge` (R19)
- Provider-aware `doctor` diagnostics and audit fields (`judgeProvider`, `judgeModelResolved`, `judgeLatencyMs`, `judgeOutboundRedacted`)
- Outbound redaction (R23) for cloud judge calls via `scrubOutboundForJudge`
- **v2 verdict engine** — shell classification uses `location × opacity × effect × confidence` axes (`src/core/v2/`)
- Structural test suite with catastrophic bypass equivalence hard gate (`src/__tests__/v2/structural-suite.test.ts`)
- Audit CLI filters for v2 axes: `--location`, `--opacity`, `--effect`, `--confidence`

### Changed

- **BREAKING:** `classifyShell` is now async and requires config v4 (`BelayConfigV4`) as the fourth argument. The v1 synchronous classifier (`classify-shell.ts`) has been removed.
- Tier1 judge selection uses `judge.provider`; `policy.modelAssist` is ignored for v2 Tier1 (doctor warns if enabled)
- v3 configs migrate to v4 with principle-default `ollama` + `gemma4:e2b` (no silent switch to cloud)
- `explain`, `doctor`, metrics, and audit aggregation report v2 semantics
- Launcher resolution appends `npm`/`pnpm` forwarded args (`--`) and evaluates multi-line `make` recipes line-by-line

### Removed

- v1 `classify-shell` policy stack (`policy/*`, `shell-analysis.ts`)
- Layer-profile conformance matrix tests (`layer-matrix.test.ts`); guarantee table doc tests remain

### Fixed

- R23 outbound scrub no longer blocks cloud judge after `Bearer <redacted>` masking
- Tier1 judge trace (`judgeProvider`, `judgeFallbackReason`, etc.) recorded on all Tier1 paths, not only catastrophic
- Ollama parse failures report `judgeProvider: fallback` in audit trace
- `npm run … -- …` forwarded args no longer dropped before classification
- Multi-line `make` targets no longer flatten into a single benign-leading command
- `xargs` is peeled as a transparent wrapper so piped stdin execution escalates correctly

## 1.0.0

### Added

- **[SPEC-v1.0.md](docs/SPEC-v1.0.md)** — stable 1.x commitments: layer guarantees, adapter SDK, semver policy
- **`l1-full-recommended` preset** — signed + isolated control plane, sandbox, egress (`init --preset`)
- **Guarantee table conformance** — scenario IDs in `src/conformance/guarantee-table.ts` + profile-specific tests
- **Docs:** [adapter-sdk.md](docs/adapter-sdk.md), [semver-policy.md](docs/semver-policy.md), [config-schema-v3.md](docs/config-schema-v3.md)

### Changed

- Package version **1.0.0** — stable documented exports (`GATE_CONTRACT_VERSION`, presets, gate types)
- [guarantee-table.md](docs/guarantee-table.md) promoted to v1.0 with tested-scenario column
- Layer matrix scenarios expanded (`external_effect` reason on external deny cases)

## 0.9.0

### Fixed

- `l1FullActive` now requires `sandbox.runtime` ≠ `none`, not only `sandbox.enabled`
- FS-scope allowlist no longer treats a child path entry as approval for its parent directory
- One-shot shell approvals no longer bypass outside-repo rules while the sandbox broker is active

### Added

- **Sandbox capability broker (L1-full path, opt-in)** — `sandbox.enabled` integrates with external sandbox runtimes; belay brokers fs-outside capability via `fs-scope-allowlist.json`
- `agent-belay sandbox status` — reports sandbox broker, control-plane isolation, and L1-full prerequisites
- `agent-belay approve --scope path --path <abs-path>` — persist outside-repo path allowances (parallel to egress `--scope domain`)
- **Control-plane trust domain** — `controlPlane.isolation` (`none` | `read-only-mount` | `separate-user`) with doctor/sandbox verification
- **Layer conformance matrix** — `src/conformance/layer-profiles.ts` + tests for L3+L4 / partial L1 / L2 / L1-full profiles
- [`docs/guarantee-table.md`](docs/guarantee-table.md) — per-configuration guarantee documentation

### Changed

- Config v3 adds `sandbox` section and `controlPlane.isolation`
- Outside-repo shell rules demote to `capability_fs_hint` when sandbox broker is active and paths are allowlisted

## 0.8.0

### Fixed

- Transactional observed-safe path returns `permission: deny` with `transactional_already_applied` so agents do not execute the same shell command twice after effects are committed
- One-shot approvals no longer bypass `transactional_observed_risk`
- Non-zero exit codes and timeouts in the worktree skip apply and fall back to L3 prediction

### Added

- **Transactional execution (L2, opt-in)** — `policy.transactional.enabled` runs low-confidence local shell mutations in an isolated git worktree, evaluates the observed file diff, commits safe changes, and escalates dangerous effects to L4
- Diff categories: repo-outside paths, sensitive paths, control-plane artifacts, and large deletions (`maxDeletionCount`)
- Audit records include `predictedAssessment` vs `observedAssessment` when the transactional path runs
- `explain` reports transactional eligibility and confidence band; corpus helper `assessmentsDiverge` for prediction vs observation metrics

### Changed

- Config v3 `policy` adds `transactional` section (`enabled`, `minConfidence`, `maxConfidence`, `timeoutMs`, `maxDeletionCount`, `gates.shell`)

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
