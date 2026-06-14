# Changelog

Notable changes to `@guilz-dev/belay` are listed here.

The format follows [Keep a Changelog](https://keepachangelog.com/).

## Unreleased

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
