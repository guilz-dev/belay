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

`belay` is a runtime safety helper. Incorrect classification, approval
matching mistakes, or bypasses in hook integration should be treated as
security-relevant reports.

## L3 shell authority

Normalized shell actions are authorized only by their canonical `EffectPlan` and
PolicyEngine projection. Command-name allow/deny lists, legacy overrides, corpus entries,
and legacy standing-allow records (shell, tool, subagent) are forbidden as runtime
authority. Payload-free network
reads allow; external mutation, explicit payload/file/secret sends, high-stakes effects,
and partial/indeterminate plans require approval. See
[ADR-004](docs/adr/ADR-004-effectplan-shell-authority.md) and
[ADR-005](docs/adr/ADR-005-command-allowlist-prohibition.md).

## Recommended adversarial configuration (v1.0)

For operators targeting same-OS-user adversarial resistance:

```bash
belay init --preset l1-full-recommended
belay sandbox status
```

Requires external OS sandbox runtime + running egress proxy. See
[docs/guarantee-table.md](docs/guarantee-table.md).

## Threat model (v0.4)

### Assets

- Repository source and secrets (`.env`, credentials paths)
- Operator approval state (`pending-approvals.json`, `approved-approvals.json`)
- User-level control plane at `~/.config/belay/` when enabled
- Audit logs under `.cursor/belay/` or `.claude/belay/`
- Repo-local belay artifacts (config, hooks, runtime bundles) for either adapter

### Trust boundaries

| Boundary | Trust assumption |
|----------|------------------|
| Hook runtime (Node) | Runs with the IDE user's OS permissions |
| Repo-local belay config (`.cursor/` or `.claude/`) | Writable by repo collaborators; protected from agent tool mutation by default |
| Control plane (`~/.config/belay/` or `%APPDATA%/belay`) | User-level; must not be writable via gated shell/file tools |
| Agent shell / tools | Untrusted; classified heuristically |

### Audit advice and Recovery v1

- **`belay report`** — read-only aggregation of hook audit logs (ask/flag/allow counts,
  silent-pass rate). Does not introduce new stops or allows.
- **`belay recover` / `belay recover advice`** — advisory recovery hints only; **never
  auto-executes** undo commands and does not prove that an audit candidate executed.
  Input is primarily stored audit axes (`effect`, `location`, `assessment`). `--command` may
  re-invoke Tier1 classification (not recovery execution).
- Advice is limited to redacted hook observations; manual operator actions outside the hook
  path are not visible to recover.
- **`belay recover status/list/show`** inspect durable Recovery v1 checkpoints. They do
  not mutate repository files, but may reconcile checkpoint metadata after a crash.
- **`belay recover apply <checkpoint-id>`** restores only after an exact, expiring,
  signed out-of-band one-shot human approval. Approval binds repository root, checkpoint
  and manifest hashes, current post-state hash, and the exact path set. Standing allows,
  auto replay, unsigned CLI approval, and force restore cannot authorize this operation.

### Mitigations in v0.4

- **Fresh-install defaults** — `mode: enforce`; `policy.unknownLocalEffect` defaults to `"allow_flagged"` only as a compatibility fallback for non-EffectPlan paths, while normalized partial/indeterminate shell plans still ask. `policy.unparseableShell` defaults to `"deny"` (ask). Run `belay dogfood` for audit mode and the stricter fallback `unknownLocalEffect: deny`. Control plane defaults to enabled.
- **Exact authorization** — one-shot approvals and resource-scoped capability grants authorize the exact EffectPlan request. Legacy `overrides.allow` / `overrides.external` lists are parsed for compatibility but forbidden for use and ignored by shell authorization; `belay doctor` fails when either list is non-empty.
- **Chain hardening** — denies `eval`/`source`, unparseable shell constructs, newline-separated chains, `find -exec`/`-delete`, unresolved/dynamic substitutions, pipe-to-shell, outside-repo redirects, and protected-path mutations via shell or file tools. Statically recoverable nested effects are retained before the partial plan asks.
- **Tool gates** — Write/StrReplace/Delete blocked for sensitive paths, paths outside the repo, and protected belay artifacts.
- **Integrity manifest** — when `controlPlane.integrity` is `hash-pinned`, `belay upgrade` records runtime hashes; `doctor` verifies them.
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

### Transactional execution (v0.8, opt-in) — partial L2

v0.8 transactional mode is **not a complete L2 boundary**. It is a **git-worktree,
partial L2**: enforcement applies only when (1) `policy.transactional.enabled` is
true, (2) the repository is a git repo with `git worktree` available, (3) the
predicted verdict is `allow_flagged` with confidence in the configured band, and
(4) the command is a local shell mutation (not external, dynamic, or unparseable).

When those conditions hold:

- **Observed effects** — the command runs in a detached worktree; file changes are
  categorized from the real diff; safe changes are applied to the working tree,
  dangerous changes are discarded and escalated to human approval.
- **Durable checkpoint (separate opt-in)** — when
  `policy.transactional.checkpoint.enabled` is true, content-addressed pre-images and an
  immutable manifest are fsynced before the real working tree changes. Apply/restore state
  transitions are durable; incomplete mixed states are retained as
  `needs_manual_repair` rather than guessed.
- **Restore conflicts** — every target must still match the recorded post-state before any
  restore write occurs. A mismatch leaves all targets untouched and records `conflict`.
- **No double execution** — when observed-safe effects are applied, the shell hook
  returns `permission: deny` with reason `transactional_already_applied` so the
  agent runtime does not run the same command a second time.
- **Approval bypass guard** — one-shot approvals do not override
  `transactional_observed_risk`; human approval cannot bypass an observed-dangerous diff.
- **Command failure** — non-zero exit codes or timeouts in the worktree skip apply and
  fall back to the L3 prediction.
- **L3 passthrough** — high-confidence `allow` and predicted `deny_pending_approval`
  bypass transactional execution (L3 remains the fast path / L4 escalation).
- **Not covered** — effects outside the observed repository-local filesystem diff
  (network, remote Git, databases, processes, IPC, environment, services), and external
  network I/O (L1 egress remains separate). CoW snapshot backends remain future work.
- **Delivered opt-in backends** — clean Git (`git_worktree`), dirty Git (`file_checkpoint`
  with `policy.transactional.fileCheckpoint.enabled`), and non-Git directories
  (`file_checkpoint` with `allowNonGit: true`) when durable checkpointing and an attested
  workspace-isolating boundary are configured. Defaults keep both file-checkpoint flags
  disabled.

### Sandbox capability broker & control-plane isolation (v0.9, opt-in) — L1-full path

v0.9 adds the **configuration path** toward full L1, but belay does **not** implement OS
sandboxes itself. A real sandbox runtime (container / seatbelt / landlock / Cursor
sandbox) must enforce deny-all; belay brokers capability widening:

- **FS outside repo** — `sandbox.enabled` with `runtime` ≠ `none` can enforce an approved
  path scope for brokered file-mutation tools. This persisted boundary resource scope is
  not a shell command allowlist and does not override an outside-repo shell EffectPlan ask.
- **Egress** — continues to use the v0.7 egress proxy + domain allowlist
- **Control-plane isolation** — `controlPlane.isolation` verifies that the agent process
  should not write approval state / signing keys; paired with `approvalSigning.required`
  for L1-full claims
- **Adversarial claims** — only when `belay sandbox status` reports
  `l1FullActive: true` **and** the external sandbox is actually engaged. See
  [`docs/guarantee-table.md`](docs/guarantee-table.md).

### Known limitations

- Classification is heuristic, not proof of safety.
- Egress protection requires opt-in config, a running proxy, and agent/tooling that
  honors proxy environment variables.
- Audit mode records would-be denies without blocking.
- Control-plane protection depends on accurate path resolution (symlinks resolved via `realpath`).
- Command substitution parsing does not cover `${...}` parameter expansion; complex quoting edge cases may still evade detection.
- Hash-pinned integrity detects tampering only for files listed in the install manifest; manual edits require `belay upgrade` to refresh hashes.
- Disabling `controlPlane` reverts to repo-local approval paths; files under `~/.config/belay/` are not deleted automatically.
- Cursor sandbox behavior for hooks writing outside the workspace should be validated on target hosts (see `docs/spikes/oq3-control-plane.md`).

## Response Expectations

The project will aim to acknowledge reports promptly, reproduce the issue,
prepare a fix when confirmed, and publish a coordinated disclosure after a
patch is available.
