# Belay

[![npm version](https://img.shields.io/npm/v/@guilz-dev/belay)](https://www.npmjs.com/package/@guilz-dev/belay)
[![CI](https://github.com/guilz-dev/belay/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/guilz-dev/belay/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**LLM / AI SDK agent 向けの restorability floor（取り消せない×破滅的だけ止める）**

`@guilz-dev/belay` (`belay` CLI) is a practical Belay-style gate for agent runtimes.

> **0.0.x early release** — APIs and behavior may change. Cursor and Claude Code adapters
> are the primary path; **Codex is experimental**. Skill-only install is advisory; run
> `npx @guilz-dev/belay init` for the enforcement floor.

The current integration targets hook-capable agent environments.

<p align="center">
  <img src="./agent-belay-logo.png" alt="Belay logo" width="480">
</p>

## Motivation

Static denylists are broken — they can't read context, and the list never keeps up.

The same command can be harmless in one situation and high-risk in another.

A rule like "never run this command" is too coarse. But the growing list of
exceptions you bolt on to fix that quickly becomes fragile, hard to maintain,
and easy to work around.

`belay` exists to move the decision boundary away from command names
alone. Instead of treating every invocation of a tool as equally dangerous, it
makes its own runtime judgment based on:

- **reversibility** — can this be undone?
- **external effects** — does it reach outside the machine?
- **blast radius** — how much could it affect?
- **operator confidence** — how sure are we?

When that judgment gets uncertain, or an action looks like it crosses a real
safety boundary, it falls back to explicit approval and audit — instead of
pretending a static denylist solved the problem.

## How it works

`belay` hooks into specific agent runtime events and gates them before
they take effect. v0.4 ships two adapters:

- **Cursor** — `.cursor/hooks.json` + hook scripts
- **Claude Code** — `.claude/settings.json` hooks (`PreToolUse`, `UserPromptSubmit`)

Both gate shell execution, subagent launches, and file mutations through the
same core classifier and shared runtime.

When one of these events fires, Belay runs its own lightweight classifier on the
payload to estimate reversibility, external effects, blast radius, and
confidence. It does not rely on an agent-side `Assessment` being present in the
payload; it always forms its own judgment.

Based on that judgment, Belay assigns one of three verdicts:

- `allow` — Safe enough to execute without intervention (e.g., read-only
  commands)
- `allow_flagged` — Local mutation or unknown-but-local effect; allowed, but
  recorded for audit (fresh installs default to deny for unknown/unparseable shell;
  use `belay explain` and `overrides.allow` to tune)
- `deny_pending_approval` — High-risk or ambiguous (destructive external effects,
  irreversible-looking mutations, writes outside the repo); blocks execution and
  issues an approval ID

When an action is denied, the user can approve the next matching action once by
sending `/belay-approve <approval-id>`. Approvals are one-shot and expire after
15 minutes by default. Every decision is written to the adapter-specific audit log (for example
`.cursor/belay/audit.ndjson` or `.claude/belay/audit.ndjson`) for later review.

If `mode` is set to `"audit"` in `.cursor/belay.config.json`, would-be denies
are recorded (`wouldBlock: true` in the audit log) but execution is still
allowed to continue. Pending approvals are not created in audit mode.

This creates a dynamic, context-aware gate rather than a static command
denylist.

## Scope

`belay` is a **layered hook gate** for agent runtimes — not a static denylist.

| Layer | Role | Opt-in |
|-------|------|--------|
| **L1** Containment | Egress proxy, sandbox capability broker | `egress`, `sandbox` config |
| **L2** Observation | Transactional git-worktree diff | `policy.transactional` |
| **L3** Prediction | Policy rules + command-key heuristics (noise-reduction cache) | default |
| **L4** Approval | Human one-shot / scoped approvals | default |

- L3 command lists are **not security boundaries** by themselves — see
  [docs/semver-policy.md](./docs/semver-policy.md) and [docs/guarantee-table.md](./docs/guarantee-table.md).
- Adversarial resistance requires the **L1-full** stack; use
  `belay init --preset l1-full-recommended` and verify with `belay sandbox status`.
- Fresh installs default to **fail-closed** shell policy (L3+L4) with control plane enabled.

## Runtime Support

`belay` is intended as an agent-facing package, not a Cursor-only product.

- Cursor and Claude Code adapters are included in v0.4.
- Additional adapters can target other agent runtimes without changing the package
  name or core concepts.
- The optional Skill artifact is only a UX layer; it is not the core runtime.

## Roadmap

- `v0.1`: Cursor-style hook adapter with one-shot approval and audit
- `v0.2`: testable core, stronger classifier, tool gates, config v2, ops CLI — see [docs/v0.2-plan.md](./docs/v0.2-plan.md)
- `v0.3`: config v3, fail-closed shell mode, user control plane — see [docs/SPEC-v0.3.md](./docs/SPEC-v0.3.md), [docs/v0.3-remaining.md](./docs/v0.3-remaining.md), and [docs/ROADMAP.md](./docs/ROADMAP.md)
- `v0.4`: portable adapters (Cursor + Claude), gate contract, fail-closed defaults — see [docs/v0.4-plan.md](./docs/v0.4-plan.md)
- `v0.5`: policy-as-code judgment pipeline, corpus metrics, confidence thresholds — see [docs/v0.5-plan.md](./docs/v0.5-plan.md)
- `v0.6`: audit tooling, policy simulation, layered config, signed OOB approval — see [docs/v0.6-plan.md](./docs/v0.6-plan.md)
- `v0.7`–`v0.9`: layered enforcement (L1 egress, L2 transactional, L1-full broker) — see [docs/v0.7-v1.0-plan.md](./docs/v0.7-v1.0-plan.md)
- `v1.0`: stable guarantees, adapter SDK, semver policy — see [docs/SPEC-v1.0.md](./docs/SPEC-v1.0.md)

## Install

### Full setup (recommended)

```bash
npx @guilz-dev/belay init-wizard
npx @guilz-dev/belay init --with-skill
npx @guilz-dev/belay init --adapter claude
npx @guilz-dev/belay init --preset l1-full-recommended   # adversarial L1-full stack
```

`init-wizard` is the interactive path: it prompts for adapter, install scope, skill, and
dogfood mode, then runs the same install as `init`.

### Install scope (project vs global)

`--scope project|global` controls where hooks, runtime, and skill are installed.
Even with `--scope global`, `belay.config.json`, approvals, and audit remain repo-local.
This means the hook floor can be user-wide while policy and audit stay per-repository.

```bash
npx @guilz-dev/belay init --scope project    # default: artifacts under .cursor/ (or .claude/, .codex/)
npx @guilz-dev/belay init --scope global     # hooks/runtime/skill under ~/.cursor/ (etc.)
```

See [docs/design/global-scope.md](./docs/design/global-scope.md) for the full path matrix.

After install, check floor health with `belay doctor` and confirm install scope /
skill-only state with `belay status`.

This installs the runtime hooks and also writes helper artifacts for:

- `.cursor/skills/belay/SKILL.md`
- `.cursor/commands/belay-approve.md`
- `.cursor/commands/belay-why.md`
- `.cursor/commands/belay-explain.md`
- `.cursor/commands/belay-status.md`
- `.cursor/commands/belay-report.md`
- `.cursor/commands/belay-recover.md`

### Hook runtime only

```bash
npx @guilz-dev/belay init
```

### Upgrade from v0.1 / v0.2

```bash
npx @guilz-dev/belay upgrade
```

`upgrade` refreshes hook scripts and the bundled runtime while merging your
existing `.cursor/belay.config.json` settings (v1/v2 configs migrate to v3).
When you newly enable `controlPlane`, existing repo-local approval files are
copied into the control-plane directory if it is empty.

### Skill only (skills CLI)

```bash
npx skills add guilz-dev/belay --skill belay -a cursor -y
```

Re-running `init` merges config and re-writes managed hook files. Prefer
`upgrade` when you only need a runtime refresh. Keep local customizations
outside the generated Belay files.

Installing the skill alone does not enable gating. Runtime enforcement still
requires `npx @guilz-dev/belay init` in the target repository.

## What it installs

Current adapter artifacts:

- `.cursor/belay.config.json`
- `.cursor/hooks/belay-runner`
- `.cursor/hooks/belay-before-submit.mjs`
- `.cursor/hooks/belay-shell-gate.mjs`
- `.cursor/hooks/belay-tool-gate.mjs`
- `.cursor/hooks/belay-audit.mjs`
- `.cursor/belay/runtime/core.mjs`
- `.cursor/belay/pending-approvals.json` (or `~/.config/belay/` when `controlPlane.enabled`)
- `.cursor/belay/approved-approvals.json` (or control-plane directory)
- `.cursor/belay/audit.ndjson` (always repo-local via `audit.logPath`)

Optional skill and command artifacts (with `--with-skill`):

- `.cursor/skills/belay/SKILL.md`
- `.cursor/commands/belay-approve.md`
- `.cursor/commands/belay-why.md`
- `.cursor/commands/belay-explain.md`
- `.cursor/commands/belay-status.md`
- `.cursor/commands/belay-report.md`
- `.cursor/commands/belay-recover.md`

Packaged skill source for `npx skills add`:

- `skills/belay/SKILL.md`
- `skills/belay/belay-approve.md`
- `skills/belay/belay-why.md`
- `skills/belay/belay-explain.md`
- `skills/belay/belay-status.md`
- `skills/belay/belay-report.md`
- `skills/belay/belay-recover.md`

## Commands

```bash
npx @guilz-dev/belay init
npx @guilz-dev/belay init-wizard
npx @guilz-dev/belay init --with-skill
npx @guilz-dev/belay init --scope project
npx @guilz-dev/belay init --scope global
npx @guilz-dev/belay init --dogfood
npx @guilz-dev/belay upgrade
npx @guilz-dev/belay dogfood
npx @guilz-dev/belay dogfood --enforce
npx @guilz-dev/belay doctor
npx @guilz-dev/belay doctor --fix
npx @guilz-dev/belay metrics
npx @guilz-dev/belay report
npx @guilz-dev/belay status
npx @guilz-dev/belay recover
npx @guilz-dev/belay recover --command "rm important.ts"
npx @guilz-dev/belay explain -- <shell-command>
npx @guilz-dev/belay explain --kind subagent -- "deploy to production"
npx @guilz-dev/belay explain --kind tool --tool Write -- .env
npx @guilz-dev/belay egress start
npx @guilz-dev/belay egress status
npx @guilz-dev/belay egress env
npx @guilz-dev/belay approve <approval-id> --scope domain
npx @guilz-dev/belay revoke <approval-id>
```

`mode: "audit"` is supported in `.cursor/belay.config.json`. In audit mode,
Belay records would-be denies but allows execution to continue.

### Config v3 highlights

`belay.config.json` uses `version: 3`. v1/v2 configs migrate automatically on
load (`customAllowCommands` / `customExternalCommands` map to `overrides`).

```json
{
  "version": 3,
  "mode": "enforce",
  "gates": {
    "shell": true,
    "subagent": true,
    "fileMutation": true,
    "toolShell": true
  },
  "classifier": {
    "strictChains": true,
    "sensitivePaths": [".env", ".env.*", "**/credentials/**"]
  },
  "policy": {
    "unknownLocalEffect": "allow_flagged"
  },
  "overrides": {
    "allow": ["pnpm release:staging"],
    "external": ["./scripts/release.sh"]
  },
  "redaction": {
    "maskApprovalIds": true,
    "maskBearerTokens": true,
    "maskAuthHeaders": true,
    "maskKeyValueSecrets": true,
    "maskHighEntropyStrings": false
  },
  "controlPlane": {
    "enabled": false,
    "configDir": null
  },
  "audit": {
    "logPath": ".cursor/belay/audit.ndjson",
    "includeAssessment": true
  }
}
```

**OQ1 dogfood** — one command to start:

```bash
npx @guilz-dev/belay dogfood
# or on init:
npx @guilz-dev/belay init --dogfood
```

This sets `mode: "audit"` and `policy.unknownLocalEffect: "deny"`. Run
`npx @guilz-dev/belay metrics` after normal agent work, check `npx @guilz-dev/belay status` /
`doctor` for readiness, tune `overrides.allow` with `explain`, then:

```bash
npx @guilz-dev/belay dogfood --enforce
```

`policy.unknownLocalEffect: "deny"` enables fail-closed shell classification for
unrecognized local commands.

`controlPlane.enabled: true` stores approval state under
`~/.config/belay/` (or `XDG_CONFIG_HOME/belay`). The same path is
shared across repositories for the current OS user. Existing repo-local approval
files are copied or merged into the control plane on `upgrade`. Disabling control
plane merges approvals back to repo-local; run `npx @guilz-dev/belay doctor --fix` to
archive orphaned files.

For cloud Tier1 (`judge.provider: "openai-compatible"`), set `judge.endpoint` and
provide `BELAY_JUDGE_API_KEY` or `OPENAI_API_KEY`. Use
`npx @guilz-dev/belay init --judge-provider openai-compatible --judge-endpoint <url> --accept-cloud-judge`
to opt in explicitly. Fresh installs default to local Ollama (`local-ollama`).

File-mutation tools and shell redirects cannot write control-plane paths when
control plane is enabled.

`strictChains: true` (default) scans every `&&`, `|`, and `;` segment and keeps
the strictest verdict. Override lists use exact command or segment key matches only.

## Approval flow

High-risk actions are denied with an approval ID. Approve the next matching
action once by sending:

```text
/belay-approve <approval-id>
```

Approvals are one-shot and expire after 15 minutes by default.

## Existing Hooks

For the current Cursor-style adapter, `belay` is designed to coexist with
existing repo-local hooks.

- Gate hooks are inserted with prepend semantics so they run before existing
  hooks for the same event.
- Audit hooks are appended so they observe the final flow after other hooks.
- Existing non-Belay hook entries are preserved in order.

If another hook also denies the same event, the host runtime will still block
it; Belay does not try to suppress other repo policies.

## Git Hygiene

Belay state files are local runtime artifacts for the current adapter. They
should usually stay out of git.

Recommended ignore entries:

```gitignore
.cursor/belay/
.cursor/belay.config.json
.cursor/hooks/belay-*
.cursor/skills/belay/
.cursor/commands/belay-approve.md
```

## Library exports

The package exposes a testable core for classification and config migration:

```ts
import { classifyShell, DEFAULT_CONFIG_V3, mergeConfig } from 'belay'

const result = await classifyShell('git status', process.cwd(), process.cwd(), mergeConfig({}))
```

See also `belay/core` for lower-level exports.
