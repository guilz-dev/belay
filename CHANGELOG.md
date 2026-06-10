# Changelog

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
