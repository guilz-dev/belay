# Roadmap

This roadmap describes where `agent-belay` is going and why. It expands on the
short roadmap in the [README](../README.md) and is meant to be read alongside the
v0.3 specification in [`SPEC-v0.3-requirements.md`](./SPEC-v0.3-requirements.md).

It is intentionally version-driven rather than date-driven: each milestone has a
theme, a small set of load-bearing changes, and explicit exit criteria.

## North Star

Static denylists cannot read context, and the exception list never keeps up. The
same command is harmless in one situation and dangerous in another.

`agent-belay` exists to move the decision boundary away from command names alone
and toward a runtime judgment about each gated action — its **reversibility**,
**external effects**, **blast radius**, and the gate's own **confidence** — and
to fall back to explicit human approval and audit when that judgment gets
uncertain or an action crosses a real safety boundary.

The end state is a small, reusable Belay **core** (classification, approval
state, fingerprinting, audit, policy) that is cleanly separated from
**host-specific adapters** (Cursor today, others later), with a documented threat
model and guarantees a user can actually rely on.

## The defining question: guardrail or boundary?

The single most important strategic decision for this product is what kind of
thing it claims to be:

- **Audit guardrail** — helps a *cooperative* agent avoid mistakes, and records
  what happened. Fails open when unsure. Useful, but not something you can lean
  your weight on.
- **Security boundary** — something a *fallible or mildly misaligned* agent
  cannot trivially walk through or quietly disable. Fails closed when unsure.

Today, through v0.2, the product is honestly the former. The internal security
internal security review (see [`SECURITY.md`](../SECURITY.md)) confirmed it: the
gate fails open on unknown commands, the control plane lives inside the
monitored repo where the agent can rewrite it, and secrets reach the audit log
in cleartext. v0.2 narrowed the parsing bypasses (chains, pipes,
`bash -c`/`node -e`) but did not change the gate's character.

**This roadmap commits to making `agent-belay` a credible boundary for the
cooperative-but-fallible threat model**, while staying honest in docs about the
adversarial cases that still require OS-level sandboxing. v0.3 is where that
commitment becomes real.

## Where we are — v0.2 (shipped)

Shipped via PR #3, scoped by [`v0.2-plan.md`](./v0.2-plan.md):

- **Core extraction.** Classification, approval, fingerprinting, and scrubbing
  now live in host-independent, unit-testable modules under
  [`src/core/`](../src/core/); the generated per-repo runtime is a
  deterministic bundle of that core (`scripts/build-runtime.mjs` →
  `dist/bundle/cursor-runtime.mjs`) behind a thin Cursor adapter
  ([`src/adapters/cursor/`](../src/adapters/cursor/)). An installer-level
  `BelayAdapter` interface ([`src/adapters/types.ts`](../src/adapters/types.ts))
  marks where a second adapter will plug in.
- **Classifier coverage.** Chained commands classified per segment with the
  strictest verdict winning; piping into a shell interpreter denied;
  `bash -c` / `node -e` scripts extracted and classified recursively;
  env-prefix handling in the tokenizer; expanded external/flagged command
  dictionaries; `sed -i` detection; subagent context scoring to cut false
  positives.
- **Tool gates.** `preToolUse` coverage beyond `Task`: a `toolShell` gate and a
  `fileMutation` gate (`Write`/`StrReplace`/`Delete`) with
  `classifier.sensitivePaths` globs.
- **Config v2** (`gates.*`, `classifier.*`, `audit.includeAssessment`) with
  v1 migration, and **merge** semantics: `init`/`upgrade` preserve operator
  edits instead of rewriting.
- **Ops CLI.** `status`, `explain` (shows the `signals` behind a verdict),
  `revoke`, `upgrade`; `doctor` checks config-version and build-stamp drift.
- **Structured `Assessment`** (`reversibility`, `external`, `blastRadius`,
  `confidence`, `signals`) on every classify result.

Known limits (the honest list): fails open on unknown commands
(`unknown_local_effect` → `allow_flagged`); command substitution, subshells,
and symlinked paths still evade; the control plane — approval state, config,
hooks, bundled runtime — is in-repo and writable by the monitored agent;
secret redaction only masks approval ids; only one runtime is supported.

> Note: an earlier draft spec ([`SPEC-v0.2-historical.md`](./archive/SPEC-v0.2-historical.md)) proposed the
> security hardening for v0.2. It was not implemented as written; its
> requirements move to v0.3. It is kept for traceability only.

## Themes that cut across every milestone

1. **Fail closed when unsure.** Ambiguity escalates to approval; it does not slip
   through.
2. **Protect the control plane.** The monitored side should not be able to
   silently disable or self-approve the gate.
3. **Honesty over theater.** Every claimed guarantee is documented with its
   threat model and its residual gaps. We never describe a guardrail as a
   boundary.
4. **Core/adapter separation.** New capability lands in reusable core logic, not
   bolted onto the Cursor integration.
5. **Low-friction by default.** A gate that is too noisy gets disabled. Good
   defaults, easy per-project overrides, and a fast approval loop matter as much
   as correctness.

---

## v0.3 — Trustworthy gate

**Theme:** make the gate worth trusting before making it portable. Close the
remaining bypasses, protect the control plane, stop leaking secrets, and give
operators real policy control.

Detailed requirements live in [`SPEC-v0.3-requirements.md`](./SPEC-v0.3-requirements.md). In brief:

- **Fail closed** — unknown commands and unparseable constructs (command
  substitution, subshells, brace groups, newline separators) escalate to
  approval by default; `policy.unknownCommand` / `policy.unparseableShell` let
  a project consciously opt back into fail-open.
- **Remaining shell hardening** — wrapper/path resolution (`/usr/bin/curl`,
  `sudo`, `env`, `xargs`, `git -C . push`), bare interpreters
  (`python script.py`) as arbitrary-code risk, `find -exec`, realpath/symlink
  resolution before containment checks.
- **Control-plane integrity** — relocate approval state to a user-config
  location outside the monitored repo; hash-pin the installed runtime and
  hooks (fail closed on mismatch); deny gated writes — shell *and* Write-tool —
  that target control-plane files. Config drift is advisory (doctor warning),
  since v0.2's merge semantics make operator config edits a feature.
- **Secret redaction** — scrub `Bearer` tokens, auth headers, key/value
  secrets, and high-entropy strings before they hit the audit log.
- **Policy & overrides (config v3)** — promote v0.2's
  `classifier.customAllowCommands`/`customExternalCommands` into
  `overrides.{allow,flag,deny}` with documented precedence that protections
  cannot be overridden through.
- **Docs** — `SECURITY.md` states the threat model (cooperative-but-fallible
  defended; same-OS-user adversary detectable, not containable) explicitly.

**Exit criteria:** every still-open clause of the security review has a passing
regression test; default installs fail closed; approval state lives out of
repo and tampering fails closed; no curated-corpus secret reaches the audit
log; a v0.2 install upgrades cleanly with `custom*` configs auto-migrated.

---

## v0.4 — Portable adapters

**Theme:** stop being Cursor-only. Earn the name "agent-belay" instead of
"cursor-belay." (v0.2 already extracted the core; what remains is the runtime
contract and a second host.)

- Formalize the **runtime-level adapter contract**: a normalized gated-action
  shape (kind, command/payload, cwd, repo root, contract version) in and a
  normalized verdict out, so the core never sees host payload quirks; adapters
  that cannot normalize a payload fail closed. Today
  `src/adapters/cursor/runtime-entry.ts` calls core functions directly — the
  contract makes that boundary explicit and versioned.
- Remove residual host assumptions from core defaults (e.g. the `.cursor/…`
  audit path default in `core/config.ts` moves to the adapter).
- Ship a **second adapter — Claude Code hooks** (`PreToolUse` for
  Bash/Task, `UserPromptSubmit` for approvals, audit events) — as the proof
  the contract generalizes, with install into `.claude/` symmetric to the
  Cursor layout and control-plane protection extended to those artifacts.
- **Adapter conformance suite**: one shared scenario set (verdict matrix,
  approval round trip, fail-closed plumbing, redaction, coexistence with
  existing hooks) every adapter must pass; a third adapter should be "write
  the harness, pass the suite."

**Exit criteria:** the core has no host-specific assumptions (enforced by
lint/test); two adapters pass the same conformance suite; adding an adapter
requires no changes to core classification logic.

---

## v0.5 — Smarter judgment

**Theme:** go beyond static command sets without losing determinism.

- **Optional model-assisted classification** for the ambiguous middle: when the
  heuristic is low-confidence, optionally consult an LLM to judge the action
  against the four dimensions — behind a config flag, with the heuristic verdict
  as a deterministic fallback when no model is configured. (When this lands,
  default to the latest Claude models.)
- **Policy as code** — a declarative policy layer (allow/flag/deny/escalate
  rules over structured action attributes), replacing ad-hoc command sets so
  rules are testable and reviewable.
- **Consume agent-supplied assessments** when present (the abstract Belay
  substrate idea), while still always forming an independent judgment — never
  trusting the monitored side's self-assessment outright.
- **Richer signals** — argument-level analysis, project-relative blast-radius
  estimation, and a calibrated confidence score that drives the
  allow/flag/escalate threshold. (v0.2's `Assessment.signals` is the seed.)

**Exit criteria:** model assist is fully optional and degrades to deterministic
heuristics; policy rules are unit-testable in isolation; precision/recall on a
curated command corpus beats v0.3 with no regressions on the v0.3 suite.

---

## v0.6 — Observable & manageable

**Theme:** make the audit trail and approvals usable by a team, not just a file.

- **Audit tooling** — `agent-belay audit` to query, filter, summarize, and replay
  decisions from `audit.ndjson`; surface bypass attempts and noisy rules.
- **Policy simulation** — dry-run a config change against recorded history to see
  what would have changed before rolling it out.
- **Shared / layered config** — team defaults + per-repo overrides, with clear
  precedence.
- **Out-of-band approval** — approve a pending action from outside the editor
  (e.g. a chat/mobile channel) for long-running or unattended agents, with
  signed approval tokens.
- **Metrics** — allow/flag/deny rates, approval latency, top escalations.

**Exit criteria:** an operator can answer "what did the agent do, and what did I
approve?" without reading raw NDJSON; a config change can be simulated before
rollout.

---

## v0.7–v0.9 — Layered enforcement

[`ADR-001`](./ADR-001-layered-enforcement.md) resolves the
guardrail-or-boundary question architecturally: the denylist critique applies
equally to whitelists, and no prediction-based classifier can be a boundary.
These milestones move the safety boundary from *predicting* effects (lists)
to *containing and observing* them, demoting the classifier to a
noise-reduction cache in front of human approval. Detailed scope:
[`v0.7-v1.0-plan.md`](./v0.7-v1.0-plan.md).

### v0.7 — Egress chokepoint

**Theme:** stop enumerating external-effect commands; observe connections
instead. A local egress proxy gates outbound traffic by *observed
destination*, with the existing one-shot approval loop (plus v0.6 signed
out-of-band approval) acting as the broker. Domain allowlists grow from human
approvals rather than being authored upfront. `EXTERNAL_COMMANDS` becomes a
fallback and early warning, not the boundary.

**Exit criteria:** with the proxy enabled, external sends via unknown commands
are caught at connection time; no external-effect verdict depends on a
command-name list.

### v0.8 — Observed effects

**Theme:** judge destructive local commands by what they *actually did*. Low
confidence local mutations run against a snapshot (git-worktree baseline;
overlayfs/APFS backends), the real diff is classified by effect category, and
the change is committed or discarded-and-escalated. Reversibility and blast
radius become measured values, not hardcoded labels.

**Exit criteria:** dangerous commands are observed with zero real-world harm
(e2e); false-deny rate improves over v0.5 on the corpus.

### v0.9 — Capability broker & control-plane isolation

**Theme:** integrate with sandbox runtimes (container/seatbelt/landlock) so
deny-all has teeth, with Belay as the approval broker for capability widening;
move the control plane into a separate trust domain (separate OS user /
read-only mount) so tampering becomes infeasible, not just detectable.
Adversarial resistance is claimed **only** for this configuration.

**Exit criteria:** under the sandboxed configuration, the agent cannot achieve
external sends, outside-repo writes, or control-plane tampering without a
Belay approval (e2e); per-configuration guarantees are documented.

---

## v1.0 — Stable Belay

**Theme:** commit to compatibility and state guarantees plainly — per layer.

- Stable, semver-guaranteed **adapter SDK** and config schema.
- Multiple maintained runtime adapters.
- A published, precise **threat model and per-layer guarantee table**: what
  Belay catches, which layer (containment / observation / prediction /
  approval) provides it, and what each guarantee assumes in each
  configuration (incl. when OS-level sandboxing is required for the
  adversarial case).
- Signed/verified control plane (v0.9's isolated configuration) as the
  recommended default.
- Mature policy language with a documented migration path from the v0.x command
  sets; classifier lists are documented as noise-reduction caches, not
  boundaries — list updates ship in minor releases.

**Exit criteria:** breaking changes follow semver; the guarantee table is
testable and tested per configuration; a new adapter can be written against
published docs alone; the README's denylist critique describes the
implementation without self-contradiction.

---

## Cross-cutting backlog

Items that are not tied to one milestone but should be tracked:

- **Performance budget.** Hooks sit in the hot path of every shell call; keep
  the gate's added latency negligible and measured.
- **Windows parity.** Keep the `.cmd` runner and path logic at parity as the
  classifier grows; the v0.3 control-plane relocation (`%APPDATA%` vs
  `XDG_CONFIG_HOME`) is the next test of this.
- **Supply-chain integrity** for the generated runtime (the installed bundle),
  so a tampered install is detectable — v0.3's hash pinning is the first step.
- **Telemetry ethics.** The audit log can contain sensitive content; redaction,
  retention, and local-only storage are first-class concerns, not afterthoughts.

## How milestones map to the codebase

- Classification / verdicts / scrubbing / approval logic → host-independent
  modules in [`src/core/`](../src/core/) (`classify-shell.ts`,
  `classify-subagent.ts`, `classify-tool.ts`, `shell-tokenizer.ts`,
  `path-utils.ts`, `scrub.ts`, `approval.ts`, `fingerprint.ts`, `config.ts`).
- Which events are gated, hook definitions → [`src/defaults.ts`](../src/defaults.ts)
  and the adapter's `hookEvents()`.
- Cursor-specific hook I/O and runtime entry →
  [`src/adapters/cursor/`](../src/adapters/cursor/); the per-repo runtime is the
  bundle produced by `scripts/build-runtime.mjs` and embedded via
  [`src/templates.ts`](../src/templates.ts).
- Install layout, `hooks.json` merge, control-plane placement (v0.3) →
  [`src/installer.ts`](../src/installer.ts).
- Verification, integrity checks (v0.3) → [`src/doctor.ts`](../src/doctor.ts).
- Ops CLI → [`src/status.ts`](../src/status.ts), [`src/explain.ts`](../src/explain.ts),
  [`src/revoke.ts`](../src/revoke.ts), [`src/cli.ts`](../src/cli.ts).
- Second adapter (v0.4) → a sibling under `src/adapters/` implementing
  `BelayAdapter` plus the runtime contract.
