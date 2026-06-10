# Security Policy

## Reporting a Vulnerability

Please do not open a public GitHub issue for suspected security problems.

Instead, report vulnerabilities privately to the maintainers through GitHub
Security Advisories or the repository owner's published contact channel.

Include:

- A short description of the issue
- Steps to reproduce it
- The affected version or commit
- Any suggested mitigation, if known

## Scope

`agent-belay` is a runtime safety helper. Incorrect classification, approval
matching mistakes, or bypasses in hook integration should be treated as
security-relevant reports.

## Threat model (v0.3)

### Assets

- Repository source and secrets (`.env`, credentials paths)
- Operator approval state (`pending-approvals.json`, `approved-approvals.json`)
- User-level control plane at `~/.config/agent-belay/` when enabled
- Audit logs under `.cursor/belay/`

### Trust boundaries

| Boundary | Trust assumption |
|----------|------------------|
| Hook runtime (Node) | Runs with the IDE user's OS permissions |
| Repo-local `.cursor/belay.config.json` | Writable by repo collaborators; not a secret store |
| Control plane (`~/.config/agent-belay/`) | User-level; must not be writable via gated file tools when control plane is enabled |
| Agent shell / tools | Untrusted; classified heuristically |

### Mitigations in v0.3

- **Fail-closed shell mode** — `policy.unknownLocalEffect: "deny"` blocks unrecognized local commands (default remains `allow_flagged` until dogfood).
- **Overrides** — `overrides.allow` / `overrides.external` provide audited escape hatches; `allow` wins over `external`.
- **Chain hardening** — denies `eval`/`source`, command substitution wrappers (including nested/multi `$(...)`), pipe-to-shell, outside-repo redirects, and control-plane path mutations via shell or file tools.
- **Tool gates** — Write/StrReplace/Delete blocked for sensitive paths, paths outside the repo, and control-plane files.
- **Audit redaction** — configurable scrubbing for bearer tokens, auth headers, key/value secrets, and approval IDs.

### Known limitations

- Classification is heuristic, not proof of safety.
- Audit mode records would-be denies without blocking.
- Control-plane protection depends on accurate path resolution (symlinks resolved via `realpath`).
- Command substitution parsing does not cover `${...}` brace expansion; complex quoting edge cases may still evade detection.
- Disabling `controlPlane` reverts to repo-local approval paths; files under `~/.config/agent-belay/` are not deleted automatically.
- Cursor sandbox behavior for hooks writing outside the workspace should be validated on target hosts (see `docs/spikes/oq3-control-plane.md`).

## Response Expectations

The project will aim to acknowledge reports promptly, reproduce the issue,
prepare a fix when confirmed, and publish a coordinated disclosure after a
patch is available.
