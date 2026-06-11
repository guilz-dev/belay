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

## Threat model (v0.4)

### Assets

- Repository source and secrets (`.env`, credentials paths)
- Operator approval state (`pending-approvals.json`, `approved-approvals.json`)
- User-level control plane at `~/.config/agent-belay/` when enabled
- Audit logs under `.cursor/belay/` or `.claude/belay/`
- Repo-local belay artifacts (config, hooks, runtime bundles) for either adapter

### Trust boundaries

| Boundary | Trust assumption |
|----------|------------------|
| Hook runtime (Node) | Runs with the IDE user's OS permissions |
| Repo-local belay config (`.cursor/` or `.claude/`) | Writable by repo collaborators; protected from agent tool mutation by default |
| Control plane (`~/.config/agent-belay/` or `%APPDATA%/agent-belay`) | User-level; must not be writable via gated shell/file tools |
| Agent shell / tools | Untrusted; classified heuristically |

### Mitigations in v0.4

- **Fail-closed defaults (fresh install)** — `policy.unknownLocalEffect` and `policy.unparseableShell` default to `"deny"`; control plane defaults to enabled.
- **Overrides** — `overrides.allow` / `overrides.external` provide audited escape hatches; overrides cannot bypass repo-local belay artifacts or the control plane.
- **Chain hardening** — denies `eval`/`source`, unparseable shell constructs, newline-separated chains, `find -exec`/`-delete`, command substitution wrappers, pipe-to-shell, outside-repo redirects, and protected-path mutations via shell or file tools.
- **Tool gates** — Write/StrReplace/Delete blocked for sensitive paths, paths outside the repo, and protected belay artifacts.
- **Integrity manifest** — when `controlPlane.integrity` is `hash-pinned`, `agent-belay upgrade` records runtime hashes; `doctor` verifies them.
- **Audit redaction** — configurable scrubbing for bearer tokens, auth headers, key/value secrets, and approval IDs.

### Egress chokepoint (v0.7, opt-in) — partial L1

v0.7 egress is **not a complete L1 boundary**. It is a **proxy-respecting-client,
partial L1**: enforcement applies only when (1) the local egress proxy is running,
(2) agent/tool processes honor `HTTP_PROXY` / `HTTPS_PROXY`, and (3) traffic uses
HTTP(S) through that proxy. **Full egress containment (OS firewall / capability
broker) is v0.9+**, not v0.7.

When those conditions hold:

- **Observed chokepoint** — outbound HTTP(S) is evaluated at connect time; unknown
  hosts are blocked pending approval or domain allowlist entry.
- **L3 demotion (gated)** — shell `external_effect` / `custom_external` rules become
  early warnings (`l3_external_hint`) **only while the egress proxy is running for
  that repository**. If `egress.enabled` is true but the proxy is not running, L3
  external rules stay at `deny_pending_approval` (fail-closed).
- **Not covered** — tools that ignore proxy environment variables, raw sockets,
  custom DNS, and other covert channels (documented in the v0.7 plan; adversarial
  full L1 is v0.9+).
- **Single proxy per control plane** — one running egress daemon binds to one
  `repoRoot` and listen port (default `17831`). Starting egress for a second
  repository requires stopping the existing proxy first. `egress env` refuses
  to export proxy variables when the listen port is owned by another repository.
- **Loopback bind only** — non-loopback `egress.listenHost` values are coerced
  to `127.0.0.1` during config normalization.

### Known limitations

- Classification is heuristic, not proof of safety.
- Egress protection requires opt-in config, a running proxy, and agent/tooling that
  honors proxy environment variables.
- Audit mode records would-be denies without blocking.
- Control-plane protection depends on accurate path resolution (symlinks resolved via `realpath`).
- Command substitution parsing does not cover `${...}` parameter expansion; complex quoting edge cases may still evade detection.
- Hash-pinned integrity detects tampering only for files listed in the install manifest; manual edits require `agent-belay upgrade` to refresh hashes.
- Disabling `controlPlane` reverts to repo-local approval paths; files under `~/.config/agent-belay/` are not deleted automatically.
- Cursor sandbox behavior for hooks writing outside the workspace should be validated on target hosts (see `docs/spikes/oq3-control-plane.md`).

## Response Expectations

The project will aim to acknowledge reports promptly, reproduce the issue,
prepare a fix when confirmed, and publish a coordinated disclosure after a
patch is available.
