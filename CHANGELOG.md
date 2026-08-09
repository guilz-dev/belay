# Changelog

Notable changes to `@guilz-dev/belay` are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Fixed

- **One-step editor approval** — `/belay-approve <id>` now atomically claims and replays the exact denied shell action through the configured boundary driver on Cursor, Claude Code, and Codex without requiring a follow-up prompt. Instructions on following lines continue after successful replay; failed or timed-out replay requires fresh approval.

## 0.6.0 — 2026-08-08

### Added

- **Shell command semantics layer** — `git-classifier.ts` and `shell-semantics.ts` produce unified `ShellCommandSemantics` consumed by `verdict.ts`.
- Expanded shell corpus to 53 labeled cases, including `git fetch` / `git pull` must-ask entries.
- `docs/grant-consumption-paths.md` — design note for grant consumption paths (`approved_once` vs `capability_grant`).
- Recovery execution fail-closed helpers (`recoveryFailClosedResult`, `recoveryFailReasonFromSkip`) and `RecoveryProofV1` type scaffolding (phase 1; proof mint/verify not yet wired).
- `AGENTS.md` guidance: English-only text for Git commits, PRs, and GitHub comments.

### Changed

- Git classification handles global `-C` / `--work-tree`, separates ref operands from path targets, and splits branch read vs mutation flags.
- `git fetch` and `git pull` now require approval (remote mutation + policy ask).
- `rsync` is classified as local, remote, or destructive instead of blanket tier0 external.
- `pnpm exec` launcher recipes expand before recursive verdict evaluation; npm script recipes split on top-level `&&` chains.
- **Transactional recovery (opt-in):** substrate skip or observation failure maps to `recovery_substrate_unavailable`, `recovery_dirty_worktree`, or `recovery_execution_failed` and **denies** instead of falling back to unproven host execution.
- `TransactionalRunnerParams` accepts `boundaryContext` (removed `boundaryDriverId` / `egressProxyEnv`); transactional runner uses the same proxy resolution as gate-runtime.
- Transactional diff evaluator denies observed `repo_outside`, `sensitive_path`, and `control_plane` mutations.
- Transactional git worktrees are created under the system temp directory; apply verifies repo file hashes before copying (TOCTOU guard).
- `isGitRefWrite` policy detection uses the `git.push` signal instead of matching `push` in the command string.

### Fixed

- Shell verdict false positives: git branch/ref names containing `/` or `credentials`, commit messages, `git -C` status, `tsc --noEmit`, routine launcher paths, and `...cache` repo-boundary checks.
- `git reset -h` no longer treated as `--hard`; `rsync --delay-updates` no longer treated as destructive.
- `git stash push` no longer emits `git.push`; checkout ref names no longer trigger secret-path asks.
- Delete tool targeting `.git` paths now requires approval (`protected_artifact`), matching shell parity.
- Transactional recovery no longer treats Belay init state (`.cursor/belay/`, config, hooks) as a dirty worktree when untracked.
- Docker integration tests use 60s timeouts to avoid flaky 5s vitest limits.

## 0.5.0 — 2026-08-07

### Added

- **Capability-based policy engine** — synchronous `PolicyEngine` with `CapabilityRequestV1`, `PolicyDecision` (allow / require_approval / deny), and resource-scoped grants (`CapabilityGrantV1`).
- **Boundary drivers** — `BoundaryDriver` interface with host-integration stub, Docker container isolation, and egress-proxy chokepoint; transactional runner executes via drivers.
- **`belay session start`** — attested editor sessions with boundary profile propagation through adapters and gate contract.
- **Approval state v3** — capability-grant normalization, atomic lease consumption, replay envelope with capability request hash; v1/v2 migration preserved.
- **Judge shadow mode** — Tier1 judge removed from synchronous gate path; `judge.mode: shadow | off` with decision trace in gate audit.
- **Cursor ACP judge session transport** — optional unix-socket broker reuse with fail-closed spawn fallback and fallback hints.
- **Corpus latency budget** — p95 classification budget tests for shell, tool, and subagent gate paths.
- **Container integration tests** — basic mount RO/RW, echo, and `materializeGrant` coverage.

### Changed

- Shell / tool / subagent classification routes through `PolicyEngine` (deterministic core); file-mutation LLM verdict removed from gate.
- Policy precedence: forbid → grant → boundary → builtin → default; stale attestation fails closed.
- `GateVerdict` extended with `capabilityRequests`, `authorizationDecision`, and `boundaryProfile`.
- Judge doctor downgraded to shadow advisory; config wizard clarifies credential source.
- Post-release verify runs `npx` check outside package root.

### Fixed

- Capability boundary enforcement hardened after policy-engine review.
- Judge-doctor smoke probe tests independent of host CLI availability.

## 0.4.0 — 2026-08-02

### Added

- **`approval.flow`** — `one_step` (default) and `two_step` modes for post-approval UX.
- **Replay envelope** — pending approvals store `cwd`, `toolName`, and payload hash for strict replay validation.
- **`belay approve --replay`** — explicit shell subprocess replay after approval; successful replay consumes the one-shot grant.
- **Adapter replay hints** — optional `replay` field on approval hook responses (Cursor, Claude, Codex).
- **Trusted workspace roots** — sandbox approvals and runtime containment for safe non-git local roots without weakening high-risk path protections.
- **Judge session transport** — opt-in unix-socket broker to reuse Tier1 judge sessions and reduce spawn latency (fail-closed spawn fallback, shadow comparison, kill switch).
- **Corpus labels** — `must-ask`, `provably-benign`, and `accepted-benign` fixture labels with stable runtime fingerprints.
- **Hard corpus gates** — zero-tolerance CI gates for must-ask FN and provably-benign FP (replaces miss-tolerance baseline).
- **Standing-allow** — silence repeat asks for provably-benign corpus and MUST-ALLOW catalog matches without conflating with one-shot `approved_once` grants.
- **Audit metrics** — repeat asks and availability-caused asks surfaced separately in `belay metrics`.
- **Recursive quality loop** — shell audit harvest, `replayContext` for faithful simulate triage, and `belay quality` with corpus gates and harvest queues.
- **Autonomous quality loop** — adversarial probe, nightly strict CI, corpus ratchet with provenance, action snapshots for simulate replay, and operator playbook/skill.
- **Config wizard TUI** — arrow-key select/confirm prompts with readline fallback for non-TTY.
- **Dogfood helpers** — `pnpm` aliases that always use the repo-built CLI.
- **Quality-loop runner** — `scripts/quality-loop-runner.sh` for isolated worktree fix loops with enforce config and optional workflow validation.
- **Agent guidelines** — `AGENTS.md` documenting Belay project boundaries for repository agents.

### Changed

- Default approval UX is **`one_step`**: shell actions get replay hints; tool/subagent fall back to manual retry unless `approval.autoReplayScopes` enables them.
- `approval.executionLeaseMs` replaces the hard-coded 60s execution lease default.
- Replay scrub/fingerprint inputs are unified via `replay-scrub.ts` (tool `tool_input`, subagent description/prompt subset).
- **Judge diagnostics** — Tier1 CLI transport failures show improved fallback visibility; live probing is opt-in.

### Fixed

- **Shell tokenizer** — FD input redirects (`3<file`, `3<&1`, plain `<`) and arbitrary FD redirects (`3>&1`, `12>>log`) participate in path analysis consistently.
- **One-step replay** — approval prompt replay no longer fails closed when replay execution or approval consumption raises an exception.
- **Harvest apply** — reject treated as successful review; standing-allow catalog regen blocked when corpus hard gates fail.
- **Typecheck** — standing-allow test state annotated; harvest and replay-context formatting restored for CI.

## 0.3.0 — 2026-06-15

### Changed

- **`belay config`** — new primary UI for judge settings (`list`, `get`, `set`, `unset`, `credential`, `judge`) and interactive setup. Replaces `init-wizard`.
- **`init-wizard`** — removed; invoking it exits non-zero with a `belay config` hint.
- **Doctor / status / SKILL.md** — guide to `belay config` when hooks or config are missing (not `init-wizard`).
- **Dogfood self-command** — `belay config get|list|set judge.*|unset judge.*|credential` allowed without approval.

- **Judge providers** — catalog is `ollama`, `codex`, `claude`, `cursor` (removed `openrouter` / `custom`). Read-time aliases: `local` → `ollama`, `openai` → `codex`.
- **Fresh init defaults** — judge `providerId` follows host adapter (`cursor` / `claude` / `codex`), not local Ollama. Default models: `gemma4:e2b`, `gpt-5.3-codex-high`, `claude-sonnet-4-6`, `composer-2.5`.
- **Fresh init credential** — writes `judge.credential.mode: project` by default.
- **Native CLI judge transport** — `codex` / `cursor` / `claude` can run Tier1 via host CLI (`*-cli` transport) without API keys when the CLI is on PATH; outbound text is scrubbed before send. Provider-specific read-only / ask-mode flags hardened for native invocations.
- **`belay judge status` / `test` / doctor** — show transport, credential `sourceKind`, and live model check (`found` / `missing` / `unverified`).
- **`--migrate-judge-default`** — opt-in migration of implicit factory-default `ollama` to the host-matched provider on `belay init` / `belay upgrade` (audit: `judge_provider_changed`).
- **`judge.model: auto`** — rejected on new input (`--judge-model`, `belay config set`, `belay judge use`). Legacy config values are normalized to the catalog default on load with a warning (lazy migration until next persist).
- **Interactive `belay config`** — on installed repos (`floorInstalled`), defaults to judge-only setup without re-running `init`; full setup reuses one readline session.
- **Model discovery tests** — unit tests mock CLI/API probes; optional live probe via `BELAY_LIVE_CLI_DISCOVERY=1` (not run in CI).
- **`BELAY_JUDGE_MODEL_RESOLVED`** — honored only under Vitest for test overrides; ignored in normal CLI runs.
- **`claude` driver** — config uses `anthropic`; Tier1 uses `claude-cli` when the Claude CLI is available, otherwise fail-closed.

### Fixed

- **Re-init** — preserving an existing `cursor` judge with `endpoint: null` no longer throws on second `belay init`.
- **Doctor** — Ollama probe runs only when `providerId` is `ollama`.
- **Legacy configs** — removed `openrouter` / `custom` `providerId` values emit a warning on load and are preserved until `belay config set judge.providerId` migrates; Tier1 fails closed until then.

## 0.2.0 — 2026-06-15

### Changed

- **Verdict engine layout** — moved implementation from `src/core/v2/` to `src/core/verdict/` (no engine generation label)
- **Classification trace** — `ClassifyResult.v2` renamed to `axes` (`VerdictAxes`); audit `by` label is `verdict` (schemaVersion 1|2 unchanged)
- **Audit compatibility** — legacy NDJSON records with `by: v2` normalize to `verdict` when parsed

> **Note:** npm `0.1.2` was never published. Upgrading from `0.1.1` also includes the fixes listed under `0.1.2` below.

## 0.1.2 — 2026-06-14

### Fixed

- **approval loop** — keep approved entries on a short execution lease so duplicate Cursor `beforeShellExecution` invocations for one retry do not burn one-shot approval early
- **init-wizard** — treat empty Enter answers as bracket defaults for adapter, scope, and yes/no prompts
- **approval loop** — allow `belay approve <id>` / `belay revoke <id>` commands under fail-closed shell policy to avoid self-deadlock during one-shot approval handling
- **test/build classification** — resolve `pnpm` shorthand (`pnpm build`, `pnpm test`) and exec-like test invocations (`pnpm vitest ...`) so routine verification commands are not blocked as unknown launcher calls
- **wizard UX** — default judge profile now tracks adapter (`cursor`/`claude`/`codex`), expose all judge profiles in `init-wizard`, and move dogfood behind a developer-options question
- **Fresh-install defaults** — `mode: enforce` with `policy.unknownLocalEffect: allow_flagged` (Tier1-recoverable unknowns run flagged); `policy.unparseableShell: deny` stays fail-closed (ask). Use `belay dogfood` for audit mode and stricter `unknownLocalEffect: deny`
- **MUST-ALLOW hard gate** — structural suite now explicitly gates `pnpm test`, `pnpm build`, `pnpm vitest ...`, and `belay approve ...` in CI

## 0.1.1 — 2026-06-14

### Added

- **Release tooling** — tracked `scripts/pre-release-check.sh` and `scripts/post-release-verify.sh`
- **CI** — `pnpm check:version` after build; `prepublishOnly` guard before `npm publish`
- **Tests** — CLI `--version` must match `package.json`

### Fixed

- **CLI** — add `--version` / `-V` and top-level `--help` for post-release `npx` verification
- **Build** — sync `PACKAGE_VERSION` from `package.json` during `pnpm build`

## 0.1.0 — 2026-06-14

### Added

- **Docs** — [CONCEPT.md](docs/CONCEPT.md) as the English concept source; [CONCEPT.ja.md](docs/CONCEPT.ja.md) translation; [docs/README.ja.md](docs/README.ja.md) index
- **Docs** — [docs/ops/releasing.md](docs/ops/releasing.md) release procedure; ADR English/Japanese split under `docs/adr/`
- **GitHub** — issue templates (bug, feature, task)

### Changed

- **Docs** — restructured around CONCEPT; retired legacy `SPEC-*` and version plan documents; streamlined [ROADMAP.md](docs/ROADMAP.md) and [README.md](README.md)
- **Corpus** — align `curl` / `wget` read-only egress expectations with `egress_read` allow verdict

### Fixed

- Corpus CI regression after egress read classification (ADR-002 conformance)

## 0.0.1 — 2026-06-14

First public release on npm as **`@guilz-dev/belay`**. CLI command: **`belay`**.  
Repository: [guilz-dev/belay](https://github.com/guilz-dev/belay).

### Added

- **Restorability floor** — Tier0 deterministic rules plus Tier1 local LLM judge (`src/core/v2/`)
- **Cursor and Claude Code adapters** — hook install, runtime bundles, one-shot approval loop
- **Codex adapter** (experimental)
- **CLI** — `init`, `init-wizard`, `upgrade`, `doctor`, `status`, `explain`, `approve`, `revoke`, `report`, `recover`, `metrics`, `audit`, `dogfood`, `simulate`
- **Config v4** — layered config, judge profiles (`local-ollama` default), `init --judge-*` flags
- **Skill distribution** — bundled `belay` skill and slash-command templates (`/belay report`, `/belay recover`, …)
- **Audit tooling** — NDJSON trace, v2 axis filters, `report` visibility and conservative fence-drift warnings
- **Recover guidance** — advisory `recover` command (show-don't-run)
- **Structural test suite** — catastrophic bypass equivalence hard gate in CI
- **Docs** — [CONCEPT.md](docs/CONCEPT.md), [guarantee-table.md](docs/guarantee-table.md), [adapter-sdk.md](docs/adapter-sdk.md), [config-schema.md](docs/config-schema.md)

### Changed

- Package name **`@guilz-dev/belay`** (bin `belay`); install via `npx @guilz-dev/belay`
- Shell classification is async via the v2 engine; config v4 is required
- Cloud judge provider is **`openai-compatible`** (`cursor` kept as a deprecated read alias)

### Fixed

- Tier0 catches Docker registry publish via `--push` and `--output=type=registry` (including `docker buildx build --push`)
