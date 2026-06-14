# Belay

[![npm version](https://img.shields.io/npm/v/@guilz-dev/belay)](https://www.npmjs.com/package/@guilz-dev/belay)
[![skills.sh](https://skills.sh/b/guilz-dev/belay)](https://skills.sh/guilz-dev/belay)
[![CI](https://github.com/guilz-dev/belay/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/guilz-dev/belay/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**A safety gate for coding agents that stops only the actions you can't undo.**

[Documentation (日本語)](./docs/README.ja.md)

`@guilz-dev/belay` hooks into agent runtimes (Cursor, Claude Code, Codex) and
inspects each shell command, subagent launch, and file mutation *before* it runs.
Most actions pass through untouched. Only the irreversible-and-catastrophic ones
are held back for one-shot human approval — and every decision is written to an
audit log.

<p align="center">
  <img src="./agent-belay-logo.png" alt="Belay logo" width="480">
</p>

> **0.0.x early release** — APIs and behavior may change. Cursor and Claude Code
> are the supported adapters; Codex is experimental.

## Supported agents

Belay works across three coding agents. Each one runs the **same classifier**,
wired in through that agent's native **hook** mechanism — no agent-specific
policy to maintain.

| Agent | Status | Hook config | belay config |
|-------|--------|-------------|--------------|
| **Cursor** | Supported | `.cursor/hooks.json` | `.cursor/belay.config.json` |
| **Claude Code** | Supported | `.claude/settings.json` | `.claude/belay.config.json` |
| **Codex** | Experimental | `.codex/config.toml` | `.codex/belay.config.json` |

Pick the adapter at install time with `--adapter cursor|claude|codex` (or let
`init-wizard` prompt). Hosts use different hook event names, but Belay registers
the same runners (`belay-tool-gate`, `belay-before-submit`, `belay-audit`) at
equivalent lifecycle points:

| Role | belay hook | Cursor | Claude Code | Codex |
|------|-----------|--------|-------------|-------|
| Gate shell / tools / file mutations | `belay-tool-gate` | `beforeShellExecution`, `preToolUse` | `PreToolUse` | `PreToolUse` |
| Gate subagent launches | `belay-tool-gate` | `subagentStart` | (via `PreToolUse`) | `SubagentStart` |
| One-shot approvals | `belay-before-submit` | `beforeSubmitPrompt` | `UserPromptSubmit` | `UserPromptSubmit` |
| Audit log | `belay-audit` | `postToolUse`, `stop`, `sessionEnd` | `PostToolUse` | `PostToolUse` |

## Why

Static denylists don't work for agents. The same command (`rm`, `curl`, a
deploy script) can be harmless in one context and catastrophic in another, and a
hand-maintained "never run this" list is always out of date and easy to work
around.

Belay moves the decision away from command names. For every gated action it
forms its own judgment based on:

- **reversibility** — can this be undone?
- **external effects** — does it reach outside the machine?
- **blast radius** — how much could it affect?
- **confidence** — how sure are we?

When the action looks safe and local, it runs. When it looks irreversible,
externally destructive, or ambiguous, Belay falls back to explicit approval and
audit instead of guessing.

## Quick start

```bash
# Interactive setup (prompts for adapter, scope, skill, mode)
npx @guilz-dev/belay init-wizard

# Or non-interactive
npx @guilz-dev/belay init --adapter claude   # Claude Code
npx @guilz-dev/belay init --adapter codex    # Codex (experimental)
npx @guilz-dev/belay init                     # Cursor (default)
```

After install, verify the floor is healthy:

```bash
npx @guilz-dev/belay doctor
npx @guilz-dev/belay status
```

Fresh installs default to **fail-closed** shell policy: unknown or unparseable
shell commands are denied until approved. Use `belay explain` to inspect a
verdict and `overrides.allow` to whitelist commands you trust.

## How it works

Belay registers hooks on the host runtime (`.cursor/hooks.json`,
`.claude/settings.json`, or `.codex/config.toml`) and gates shell execution,
subagent launches, and file mutations through one shared classifier. It always
forms its own judgment — it does not trust an assessment supplied by the agent.

Every gated action gets one of three verdicts:

| Verdict | Meaning |
|---------|---------|
| `allow` | Safe and read-only — runs without intervention |
| `allow_flagged` | Local mutation or unknown-but-local effect — runs, but recorded for audit |
| `deny_pending_approval` | Irreversible, externally destructive, or ambiguous — blocked, issues an approval ID |

When an action is denied, approve the **next matching action once** by sending:

```text
/belay-approve <approval-id>
```

Approvals are one-shot and expire after 15 minutes by default. Every decision is
written to `.cursor/belay/audit.ndjson`, `.claude/belay/audit.ndjson`, or
`.codex/belay/audit.ndjson` (depending on the adapter).

In **audit mode** (`mode: "audit"`), would-be denials are recorded
(`wouldBlock: true`) but execution still continues, and no approval IDs are
created. This is the recommended way to dogfood before enforcing.

## Layers

Belay is a layered hook gate, not a static denylist. Higher layers are opt-in.

| Layer | Role | Enabled by |
|-------|------|------------|
| **L1** Containment | Egress proxy, sandbox capability broker | `egress` / `sandbox` config |
| **L2** Observation | Transactional git-worktree diff | `policy.transactional` |
| **L3** Prediction | Policy rules + command heuristics | default |
| **L4** Approval | Human one-shot / scoped approvals | default |

- L3 command lists are **not security boundaries** by themselves — see
  [docs/ops/semver-policy.md](./docs/ops/semver-policy.md) and
  [docs/guarantee-table.md](./docs/guarantee-table.md).
- Adversarial resistance requires the full L1 stack:
  `belay init --preset l1-full-recommended`, verified with `belay sandbox status`.

## Install options

```bash
npx @guilz-dev/belay init --with-skill      # also install skill + slash commands
npx @guilz-dev/belay init --scope global    # hooks/runtime under ~/.cursor/ etc.
npx @guilz-dev/belay init --dogfood         # audit mode, fail-closed classification
npx @guilz-dev/belay upgrade                # refresh hooks/runtime, migrate config
```

**Install scope.** `--scope project` (default) writes artifacts under
`.cursor/` (or `.claude/`, `.codex/`). `--scope global` installs hooks, runtime,
and skill under `~/.cursor/`, so the gate is user-wide while `belay.config.json`,
approvals, and audit stay repo-local.

**Skill-only.** The skill is just a UX layer (slash commands + guidance) and does
**not** enable gating on its own. Install from [skills.sh](https://skills.sh/guilz-dev/belay)
or GitHub:

```bash
# Cursor
npx skills add guilz-dev/belay --skill belay -a cursor -y

# Claude Code
npx skills add guilz-dev/belay --skill belay -a claude-code -y

# Codex
npx skills add guilz-dev/belay --skill belay -a codex -y
```

Running `npx skills add` also registers anonymous install telemetry on skills.sh,
which is how the skill appears in the directory leaderboard.

Runtime enforcement still requires `belay init` in the target repository.

## Dogfood → enforce

```bash
npx @guilz-dev/belay dogfood            # mode: audit, unknownLocalEffect: deny
# ...run normal agent work...
npx @guilz-dev/belay metrics           # review what would have been blocked
npx @guilz-dev/belay status            # check readiness
# tune overrides.allow with `belay explain`, then:
npx @guilz-dev/belay dogfood --enforce
```

## Configuration

`belay.config.json` uses `version: 3`. v1/v2 configs migrate automatically on
load.

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

Notable settings:

- **`policy.unknownLocalEffect: "allow_flagged"`** (fresh default) — after Tier1
  says recoverable, structurally unknown local commands run with an audit flag. Use
  `"deny"` (via `belay dogfood`) to ask on those commands instead.
- **`classifier.strictChains: true`** (default) — scans every `&&`, `|`, and `;`
  segment and keeps the strictest verdict. Override lists match exact command or
  segment keys only.
- **`controlPlane.enabled: true`** — stores approval state under
  `~/.config/belay/` (or `XDG_CONFIG_HOME/belay`), shared across repos for the
  current OS user. `upgrade` migrates repo-local approvals in; disabling merges
  them back. File-mutation tools and shell redirects cannot write control-plane
  paths while it is enabled.
- **Cloud judge** — switch with `belay judge use openai` (or `cursor`, `openrouter`,
  `custom`). Set `judge.endpoint` where required, provide API keys via env or
  `belay judge use --credential apiKey --key-stdin`. Record egress consent via
  interactive `belay judge use … --accept-cloud` or `belay judge consent` → `belay approve`
  → `belay judge use … --cloud-consent-approval-id` (`--accept-cloud` has no effect in non-interactive mode).
  Fresh installs default to local Ollama (`belay judge use local`).

## Command reference

```bash
belay init [--adapter cursor|claude|codex] [--scope project|global]
           [--preset strict|standard|audit-first|l1-full-recommended]
           [--with-skill] [--dogfood]
belay init-wizard                # interactive install
belay upgrade                    # refresh hooks + runtime, migrate config
belay dogfood [--enforce]        # toggle audit / enforce mode
belay doctor [--fix]             # check (and repair) floor health
belay status                     # show install scope / skill-only state
belay metrics                    # would-block / verdict summary
belay report                     # audit log report
belay recover [--command "rm important.ts"]   # find recovery candidates
belay explain -- <shell-command>              # inspect a verdict
belay explain --kind subagent -- "deploy to production"
belay explain --kind tool --tool Write -- .env
belay egress <start|stop|status|env>
belay sandbox status
belay approve <approval-id> [--scope once|domain|path]
belay revoke <approval-id>
belay judge status
belay judge list
belay judge use <local|openai|cursor|openrouter|custom> [--model <id>] [--endpoint <url>]
           [--accept-cloud] [--cloud-consent-approval-id <id>]
           [--credential project|apiKey] [--key-stdin] [--key-env <NAME>]
belay judge test
belay judge consent <provider-id> [--endpoint <url>]
```

## Coexisting with existing hooks

Belay is designed to run alongside your other repo-local hooks:

- Gate hooks are **prepended** so they run before existing hooks for the same event.
- Audit hooks are **appended** so they observe the final flow.
- Existing non-Belay hook entries are preserved in order.

If another hook also denies an event, the host runtime still blocks it — Belay
does not suppress other repo policies.

## Git hygiene

Belay state files are local runtime artifacts and should usually stay out of git:

```gitignore
.cursor/belay/
.cursor/belay.config.json
.cursor/hooks/belay-*
.cursor/skills/belay/
.cursor/commands/belay-approve.md

.claude/belay/
.claude/belay.config.json
.claude/hooks/belay-*

.codex/belay/
.codex/belay.config.json
.codex/hooks/belay-*
```

## Library exports

The package exposes a testable core for classification and config migration:

```ts
import { classifyShell, DEFAULT_CONFIG_V3, mergeConfig } from 'belay'

const result = await classifyShell('git status', process.cwd(), process.cwd(), mergeConfig({}))
```

See `belay/core` for lower-level exports.

## Roadmap & history

Release notes and the version-by-version roadmap live in
[CHANGELOG.md](./CHANGELOG.md) and [docs/ROADMAP.md](./docs/ROADMAP.md).
Japanese documentation index: [docs/README.ja.md](./docs/README.ja.md).
