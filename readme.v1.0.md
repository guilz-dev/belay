# Agent Belay

`agent-belay` is a layered enforcement gate and **approval broker** for agent
runtimes. It contains external effects at a network chokepoint, observes local
effects before they are committed, and escalates everything it cannot vouch for
to a human — with one-shot approvals, signed tokens, and a full audit trail.

The current integration targets hook-capable agent environments. Adapters for
Cursor and Claude Code hooks are included.

<p align="center">
  <img src="./agent-belay-logo.png" alt="agent-belay logo" width="480">
</p>

## Motivation

Static denylists are broken — they can't read context, and the list never
keeps up. The same command can be harmless in one situation and high-risk in
another.

But the honest version of that critique cuts deeper: **any** system that tries
to predict what a command will do from its text — denylist, allowlist, smart
classifier, or LLM — has the same structural limit. Arbitrary code cannot be
fully judged before it runs. As long as prediction is the safety boundary,
every gap in the list is a gap in your safety.

So `agent-belay` does not use prediction as its safety boundary. Instead it
layers enforcement:

- **External effects** (the irreversible kind) are handled by *containment*:
  an egress chokepoint that sees actual connection attempts, regardless of
  which command or binary made them.
- **Local destructive effects** are handled by *observation*: low-confidence
  mutations run against an isolated snapshot first, and the **real diff** —
  not a guess — is what gets judged.
- Prediction still exists, but demoted to what it is good at: waving through
  the obviously safe, and warning early. It is a noise-reduction cache, never
  the boundary.
- Whatever remains uncertain goes to a human, through an approval loop built
  to be fast enough that you keep it switched on.

The consequence that makes the denylist critique self-consistent: with a
deny-all chokepoint in place, **a missing list entry means friction (a human
gets asked), not a breach.** List quality affects your day; it no longer
affects your safety.

## The four layers

```
L1  Containment   — egress proxy, sandbox runtimes, capability broker. Deny-all is the boundary.
L2  Observation   — run on a snapshot, judge the observed diff, then commit or discard.
L3  Prediction    — the classifier. A noise-reduction cache in front of L4. Never the boundary.
L4  Human approval — one-shot approvals with TTL, signed tokens, audit. The final backstop.
```

- **L1 — egress chokepoint** (opt-in): a local HTTP(S) proxy observes outbound
  connections from the agent process. Unknown destinations are blocked pending
  approval; approved domains accumulate into an allowlist that grows from
  human decisions, not from design-time guessing. With the proxy active, L3's
  external-command rules demote to hints (`demoteL3External`).
- **L1 — capability broker** (opt-in): run the agent under an external sandbox
  runtime (`cursor-sandbox`, `container`, `seatbelt`, `landlock`) with network
  and filesystem deny-all, and Belay brokers capability requests — egress
  grants and outside-repo path access — through the same approval loop.
- **L2 — transactional execution** (opt-in): shell mutations in the
  low-confidence band run in an isolated git worktree first. The observed file
  diff is categorized (outside-repo paths, sensitive paths, control-plane
  artifacts, deletion volume); safe changes are committed, dangerous ones are
  discarded and escalated. Audit records keep both the predicted and the
  observed assessment.
- **L3 — prediction**: the shell/tool/subagent classifier estimates
  reversibility, external effects, blast radius, and confidence. It fast-paths
  the obviously safe and pre-warns before a chokepoint is reached. Its lists
  are maintained for UX, not for safety.
- **L4 — approval loop**: denied actions produce an approval ID; a human
  approves the next matching action once (`/belay-approve <id>`, 15-minute TTL
  by default). Out-of-band approvals can require signed tokens. Every decision
  is written to an NDJSON audit log with secret redaction.

## What is guaranteed, per configuration

Belay states its guarantees per configuration and per layer — and states what
is **not** guaranteed with the same precision. The full table lives in
[docs/guarantee-table.md](./docs/guarantee-table.md); the short version:

| Configuration | Cooperative agent | Adversarial same-OS-user |
|---|---|---|
| Default (L3+L4) | Heuristic gates + human approval for high-risk actions | **Not protected** — hooks and control plane are detect-only |
| + Egress (L1 partial) | HTTP(S) observed at the proxy, regardless of command | **Not protected** — proxy bypass / raw sockets remain |
| + Transactional (L2) | Low-confidence local mutations observed before commit | **Not protected** — snapshot-external effects remain |
| L1-full (sandbox + egress + isolation + signing) | External sends and outside-repo writes require approval | **Protected only** when the OS sandbox enforces deny-all and the control plane sits in a separate trust domain |

Never guaranteed, in any configuration:

- Covert channels (DNS tricks, raw sockets, IPC) without OS sandbox enforcement
- Agent compliance when hooks are disabled or bypassed outside the IDE
- Anything a configuration *promises* but its runtime does not actually
  enforce — `agent-belay sandbox status` reports whether the L1-full
  prerequisites are really met (`l1FullActive`)

If a row above sounds weaker than you expected from a safety tool: that is the
point. Belay does not call a guardrail a boundary.

## How a gate decision works

Belay hooks into runtime events (shell execution, subagent launches, file
mutations) and gates them before they take effect. It always forms its own
judgment; agent-side assessments can reinforce confidence but never replace
the verdict.

Each gated action receives one of three verdicts:

- `allow` — safe enough to execute without intervention (e.g., read-only
  commands)
- `allow_flagged` — local mutation or hint-level concern; allowed but recorded
  for audit
- `deny_pending_approval` — high-risk or ambiguous; blocks execution and
  issues an approval ID

Fresh installs are **fail-closed**: unknown or unparseable shell commands are
denied (`policy.unknownLocalEffect: "deny"`, `policy.unparseableShell:
"deny"`). Use `agent-belay explain` to see why a command was classified the
way it was, and `overrides.allow` to tune. In `mode: "audit"`, would-be denies
are recorded (`wouldBlock: true`) but execution continues — measure first,
enforce when the numbers justify it (`agent-belay metrics`).

## Install

### Full setup (recommended)

```bash
npx agent-belay init --with-skill          # Cursor
npx agent-belay init --adapter claude      # Claude Code
```

### Hook runtime only

```bash
npx agent-belay init
```

### Upgrade from earlier versions

```bash
npx agent-belay upgrade
```

`upgrade` refreshes hook scripts and the bundled runtime while merging your
existing config (v1/v2 configs migrate to v3 automatically).

### Skill only (skills CLI)

```bash
npx skills add guilz-dev/agent-belay --skill belay -a cursor -y
```

Installing the skill alone does not enable gating; runtime enforcement still
requires `npx agent-belay init` in the target repository.

## Enabling the layers

Each layer ships opt-in and is independently useful. Start with the default,
add layers as your risk tolerance demands.

### L1 — egress chokepoint

```bash
# in belay.config.json: "egress": { "enabled": true }
npx agent-belay egress start
npx agent-belay egress env      # prints HTTP_PROXY / HTTPS_PROXY to inject
npx agent-belay egress status
```

Blocked destinations enter the normal approval flow. Approving with a scope
persists the decision:

```bash
npx agent-belay approve <approval-id> --scope domain   # allow this domain from now on
npx agent-belay approve <approval-id> --scope once     # this one time only
```

`doctor` warns when egress is enabled but the proxy is not running.

### L2 — transactional execution

```json
{ "policy": { "transactional": { "enabled": true } } }
```

Shell mutations whose classifier confidence falls inside the configured band
(default 0.72–0.88) run in a git worktree first. The observed diff is judged;
safe effects are committed, dangerous ones discarded and escalated.
`explain` reports transactional eligibility; audit records carry
`predictedAssessment` vs `observedAssessment`.

### L1-full — sandbox + capability broker + isolated control plane

```json
{
  "sandbox": { "enabled": true, "runtime": "container" },
  "egress": { "enabled": true },
  "approvalSigning": { "required": true },
  "controlPlane": { "isolation": { "mode": "read-only-mount" } }
}
```

Belay does not implement the sandbox itself — it rides existing runtimes
(`cursor-sandbox`, `container`, `seatbelt`, `landlock`) and brokers capability
extensions: egress grants and outside-repo filesystem access
(`approve --scope path --path <abs-path>`). Control-plane isolation
(`read-only-mount` or `separate-user`) moves approval state and signing keys
out of the agent's trust domain, upgrading tamper *detection* to tamper
*resistance*.

```bash
npx agent-belay sandbox status   # reports broker state, isolation, and l1FullActive
```

Adversarial resistance is claimed **only** when `sandbox status` confirms all
L1-full prerequisites; otherwise guarantees are cooperative-but-fallible.

## Commands

```bash
npx agent-belay init [--adapter cursor|claude] [--with-skill] [--dogfood]
npx agent-belay upgrade
npx agent-belay dogfood [--enforce] [--force] [--no-spike]
npx agent-belay doctor [--fix] [--dry-run] [--json]
npx agent-belay metrics [--json]
npx agent-belay status [--json]
npx agent-belay explain [--kind shell|tool|subagent] [--tool <name>] -- <command>
npx agent-belay audit query|summarize|replay [--since <iso>] [--verdict <v>] [--reason <r>]
npx agent-belay simulate --config <path>
npx agent-belay egress start|stop|status|env
npx agent-belay sandbox status
npx agent-belay approve <approval-id> [--scope once|domain|path] [--path <path>] [--token <signed-token>]
npx agent-belay revoke <approval-id>
```

## Config v3 reference

`belay.config.json` uses `version: 3`. Defaults for a fresh install:

```json
{
  "version": 3,
  "mode": "enforce",
  "approvalTtlMinutes": 15,
  "tokenPrefix": "/belay-approve",
  "gates": { "shell": true, "subagent": true, "fileMutation": true, "toolShell": true },
  "classifier": {
    "strictChains": true,
    "sensitivePaths": [".env", ".env.*", "**/credentials/**"]
  },
  "policy": {
    "unknownLocalEffect": "deny",
    "unparseableShell": "deny",
    "confidenceThresholds": { "allow": 0.88, "flag": 0.72 },
    "transactional": {
      "enabled": false,
      "minConfidence": 0.72,
      "maxConfidence": 0.88,
      "timeoutMs": 30000,
      "maxDeletionCount": 10,
      "gates": { "shell": true }
    }
  },
  "overrides": { "allow": [], "external": [] },
  "redaction": {
    "maskApprovalIds": true,
    "maskBearerTokens": true,
    "maskAuthHeaders": true,
    "maskKeyValueSecrets": true,
    "maskHighEntropyStrings": false
  },
  "controlPlane": {
    "enabled": true,
    "configDir": null,
    "integrity": "hash-pinned",
    "isolation": { "mode": "none", "verifyAgentWritable": true }
  },
  "approvalSigning": { "required": false },
  "egress": {
    "enabled": false,
    "listenHost": "127.0.0.1",
    "listenPort": 17831,
    "demoteL3External": true
  },
  "sandbox": { "enabled": false, "runtime": "none", "denyNetworkByDefault": true },
  "audit": { "logPath": "belay/audit.ndjson", "includeAssessment": true }
}
```

Notes:

- `controlPlane.enabled: true` (default) stores approval state under
  `~/.config/agent-belay/` (or `XDG_CONFIG_HOME/agent-belay`), shared across
  repositories for the current OS user, with hash-pinned integrity.
  File-mutation tools and shell redirects cannot write control-plane paths.
- `strictChains: true` scans every `&&`, `|`, and `;` segment and keeps the
  strictest verdict. Override lists use exact command or segment key matches.
- Config resolves in layers (builtin → team → repo → protected); use
  `agent-belay simulate --config <path>` to dry-run a change against recent
  audit history before adopting it.
- v1/v2 configs migrate automatically (`customAllowCommands` /
  `customExternalCommands` map to `overrides`).

## Approval flow

High-risk actions are denied with an approval ID. Approve the next matching
action once:

```text
/belay-approve <approval-id>
```

Approvals are one-shot and expire after 15 minutes by default. Out-of-band
approvals (via the CLI) can require signed tokens
(`approvalSigning.required: true`); notification hooks
(`notifications.webhookUrl` / `commandHook`) can route pending approvals to
wherever you are. Every decision lands in the adapter-local audit log (e.g.
`.cursor/belay/audit.ndjson`), query-able with `agent-belay audit`.

## Dogfood mode

Measure before you enforce:

```bash
npx agent-belay dogfood     # audit mode + fail-closed policy + OQ3 spike
# ...do normal agent work...
npx agent-belay metrics     # would-block rate, top reasons, enforce readiness
npx agent-belay dogfood --enforce
```

`dogfood --enforce` refuses to promote until enough gate events are recorded
and the control-plane spike passes (override with `--force`).

## What it installs

Adapter artifacts (Cursor layout shown; the Claude Code adapter mirrors it
under `.claude/`):

- `.cursor/belay.config.json`
- `.cursor/hooks/belay-runner`, `belay-shell-gate.mjs`, `belay-tool-gate.mjs`,
  `belay-before-submit.mjs`, `belay-audit.mjs`
- `.cursor/belay/runtime/core.mjs`
- `.cursor/belay/audit.ndjson` (always repo-local)
- approval state under `~/.config/agent-belay/` (control plane, default) or
  `.cursor/belay/` when the control plane is disabled

Optional skill artifacts (`--with-skill`): `.cursor/skills/belay/SKILL.md`,
`.cursor/commands/belay-approve.md`.

Recommended `.gitignore` entries:

```gitignore
.cursor/belay/
.cursor/belay.config.json
.cursor/hooks/belay-*
.cursor/skills/belay/
.cursor/commands/belay-approve.md
```

## Coexistence with existing hooks

Belay is designed to coexist with existing repo-local hooks: gate hooks are
prepended (they run first), audit hooks are appended (they observe the final
flow), and non-Belay hook entries are preserved in order. If another hook also
denies an event, the host runtime still blocks it; Belay does not suppress
other repo policies.

## Scope, honestly

- Belay is an approval broker over layered enforcement, not a proof system.
  L3 verdicts are estimates; only L1/L2 produce observed facts.
- Adversarial guarantees exist **only** in the L1-full configuration, and only
  when the external sandbox runtime actually enforces deny-all.
- The L3 command lists are maintained as a latency/noise optimization. A
  missing entry is a UX bug, not a security hole — by construction, when a
  chokepoint is active.
- Threat model details: [SECURITY.md](./SECURITY.md). Architecture rationale:
  [docs/ADR-001-layered-enforcement.md](./docs/ADR-001-layered-enforcement.md).

## Library exports

```ts
import { classifyShell, mergeConfig } from 'agent-belay'
```

See `agent-belay/core` for lower-level exports (gate engine, policy evaluator,
audit query helpers).

## Documentation

- [docs/guarantee-table.md](./docs/guarantee-table.md) — per-configuration guarantees
- [docs/ADR-001-layered-enforcement.md](./docs/ADR-001-layered-enforcement.md) — why prediction is not the boundary
- [docs/ROADMAP.md](./docs/ROADMAP.md) — release history and plans
- [docs/SPEC-v1.0.md](./docs/SPEC-v1.0.md) — the v1.0 stabilization plan
- [SECURITY.md](./SECURITY.md) — threat model and reporting
