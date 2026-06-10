# Changelog

## Unreleased

### Added

- Config v3 schema with `policy`, `overrides`, `redaction`, and `controlPlane` sections
- Automatic v1/v2 → v3 migration with `custom*` → `overrides` mapping (M1)
- Fail-closed shell policy via `policy.unknownLocalEffect: "deny"` with override escape hatches
- Shell hardening: `eval`/`source` deny, command substitution wrapping, override precedence (T4)
- User-level control plane for approval state (`controlPlane.enabled`)
- Write-tool deny for control-plane path mutations (R8)
- Audit redaction for bearer tokens, auth headers, key/value secrets, optional high-entropy strings
- Symlink-aware path resolution via `realpath` (R5)
- OQ3 control-plane filesystem spike (`runControlPlaneSpike`, `docs/spikes/oq3-control-plane.md`)
- `docs/SPEC-v0.3.md`, `docs/ROADMAP.md`, and SECURITY.md threat model update

### Changed

- `explain` output includes active policy and override lists
- Approval state paths resolve to control plane or repo-local based on config

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

### Removed
- Deprecated `--nightly` CLI flag (use `--with-skill`)
