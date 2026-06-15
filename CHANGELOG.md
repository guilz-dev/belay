# Changelog

Notable changes to `@guilz-dev/belay` are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

### Changed

- **`belay config`** — new primary UI for judge settings (`list`, `get`, `set`, `unset`, `credential`, `judge`) and interactive setup. Replaces `init-wizard`.
- **`init-wizard`** — removed; invoking it exits non-zero with a `belay config` hint.
- **Doctor / status / SKILL.md** — guide to `belay config` when hooks or config are missing (not `init-wizard`).
- **Dogfood self-command** — `belay config get|list|set judge.*|unset judge.*|credential` allowed without approval.

- **Judge providers** — catalog is `ollama`, `codex`, `claude`, `cursor` (removed `openrouter` / `custom`). Read-time aliases: `local` → `ollama`, `openai` → `codex`.
- **Fresh init defaults** — judge `providerId` follows host adapter (`cursor` / `claude` / `codex`), not local Ollama. Default models: `gemma4:e2b`, `gpt-5.3-codex-high`, `claude-sonnet-4-6`, `composer-2.5`.
- **Fresh init credential** — writes `judge.credential.mode: project` by default.
- **Native CLI judge transport** — `codex` / `cursor` / `claude` can run Tier1 via host CLI (`*-cli` transport) without API keys when the CLI is on PATH; outbound text is scrubbed before send.
- **`belay judge status` / `test` / doctor** — show transport, credential `sourceKind`, and live model check (`found` / `missing` / `unverified`).
- **`--migrate-judge-default`** — opt-in migration of implicit factory-default `ollama` to the host-matched provider on `belay init` / `belay upgrade` (audit: `judge_provider_changed`).

### Changed (earlier in unreleased)

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
