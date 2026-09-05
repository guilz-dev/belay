# ADR-010 — Repository config trust boundary

- Status: Accepted
- Date: 2026-09-05
- Related: [ADR-001](./ADR-001-layered-enforcement.md),
  [ADR-008](./ADR-008-cursor-hook-source-precedence.md)

## Context

Belay reads policy-relevant repository config from workspace-managed files such as
`.cursor/belay.config.json`, `.claude/belay.config.json`, and `.codex/belay.config.json`. Those
files can be manually edited after `belay init` or after trusted command-driven updates.

Without an explicit trust boundary, post-init edits can silently change policy authority before
operator review.

## Decision

1. **Explicit trust boundary** — Repository config has no policy authority until explicitly trusted
   by Belay CLI for the current repository identity and adapter.
2. **Cursor workspace trust is insufficient** — Host workspace trust is a separate control and does
   not replace Belay's explicit config trust.
3. **Out-of-scope same-user control-plane tampering** — Environments where the same OS user can
   arbitrarily rewrite Belay's default control-plane state are outside this boundary's guarantee.
   Separate-user isolation remains the strong boundary.
4. **Input class separation** — Team config is user-managed input; repository config is
   workspace-managed input. They are validated and trusted through different paths.
5. **Boundary scope** — Replacing project hooks/runtime artifacts inside a malicious trusted
   workspace is an integrity/isolation boundary concern and out of scope for this ADR, which
   governs config authority only.

## Trust record schema and derivation

```ts
interface RepoConfigTrustRecordV1 {
  schemaVersion: 1
  repoRoot: string
  adapter: 'cursor' | 'claude' | 'codex'
  repoConfigFingerprint: string
  trustedAt: string
}
```

Trust record path:

```text
<defaultControlPlaneDir>/config-trust/<sha256(canonicalRepoRoot + "\0" + adapter)>.json
```

Config fingerprint:

```text
sha256(canonicalStringify(parsed raw repo config))
```

## Lifecycle

- `init`, `upgrade`, `dogfood`, `config set`, `config unset`, `judge`, and `doctor --fix` update
  the trust record atomically immediately after successfully writing repository config.
- Manual repository config edits cause gate deny until `belay config trust` is run explicitly.
- Missing, malformed, identity-mismatched, adapter-mismatched, and fingerprint-mismatched trust
  records are all treated as untrusted.
- `belay doctor` reports untrusted config as an issue and exits non-zero.
- Trust record files are mode `0o600`, and parent directories are mode `0o700`.

## Consequences

- Gate evaluation fails closed before policy layering whenever repo config is untrusted.
- Normal Belay-managed config writes preserve usability by immediately re-trusting the resulting
  config snapshot.
- Operators recover from manual edits with an explicit trust action:
  `belay config trust`.
- Out-of-band deny notifications remain advisory only; signed approval tokens are not serialized to
  webhook payloads or command-hook environment variables. Tokens are issued on demand through the
  local `belay approval-token <approval-id>` control-plane path.
