# Agent Belay

`agent-belay` is a practical Belay-style gate for agent runtimes.

The current integration targets hook-capable agent environments, with the first
adapter implemented for Cursor-style hooks.

<p align="center">
  <img src="./agent-belay-logo.png" alt="agent-belay logo" width="480">
</p>

## Motivation

Static denylists are broken — they can't read context, and the list never keeps up.

The same command can be harmless in one situation and high-risk in another.

A rule like "never run this command" is too coarse. But the growing list of
exceptions you bolt on to fix that quickly becomes fragile, hard to maintain,
and easy to work around.

`agent-belay` exists to move the decision boundary away from command names
alone. Instead of treating every invocation of a tool as equally dangerous, it
makes its own runtime judgment based on:

- **reversibility** — can this be undone?
- **external effects** — does it reach outside the machine?
- **blast radius** — how much could it affect?
- **operator confidence** — how sure are we?

When that judgment gets uncertain, or an action looks like it crosses a real
safety boundary, it falls back to explicit approval and audit — instead of
pretending a static denylist solved the problem.

## Scope

`agent-belay` is an **agent-skill-oriented hook heuristic for Belay-style gating**, not the
full abstract Belay substrate model.

- It is currently optimized for hook payloads that do not include an agent-side
  `Assessment`.
- It primarily denies **external or irreversible-looking effects**.
- Local mutations are usually allowed as `allow_flagged`, not blocked.
- Command-name and payload heuristics are part of the current implementation.

This means `agent-belay` is best understood as a practical hook gate for
agent runtimes, not as a proof that a command is truly reversible.

## Runtime Support

`agent-belay` is intended as an agent-facing package, not a Cursor-only product.

- The current adapter is implemented for Cursor-style hooks.
- Future adapters can target other agent runtimes without changing the package
  name or core concepts.
- The optional Skill artifact is only a UX layer; it is not the core runtime.

## Roadmap

- `v0.1`: Cursor-style hook adapter with one-shot approval and audit
- `v0.2`: testable core, stronger classifier, tool gates, config v2, ops CLI — see [docs/v0.2-plan.md](./docs/v0.2-plan.md)
- `v0.3`: config v3, fail-closed shell mode, user control plane — see [docs/SPEC-v0.3.md](./docs/SPEC-v0.3.md) and [docs/ROADMAP.md](./docs/ROADMAP.md)

## Install

### Full setup (recommended)

```bash
npx agent-belay init --with-skill
```

This installs the runtime hooks and also writes helper artifacts for:

- `.cursor/skills/belay/SKILL.md`
- `.cursor/commands/belay-approve.md`

### Hook runtime only

```bash
npx agent-belay init
```

### Upgrade from v0.1

```bash
npx agent-belay upgrade
```

`upgrade` refreshes hook scripts and the bundled runtime while merging your
existing `.cursor/belay.config.json` settings.

### Skill only (skills CLI)

```bash
npx skills add guilz-dev/agent-belay --skill belay -a cursor -y
```

Re-running `init` merges config and re-writes managed hook files. Prefer
`upgrade` when you only need a runtime refresh. Keep local customizations
outside the generated Belay files.

Installing the skill alone does not enable gating. Runtime enforcement still
requires `npx agent-belay init` in the target repository.

## What it installs

Current adapter artifacts:

- `.cursor/belay.config.json`
- `.cursor/hooks/belay-runner`
- `.cursor/hooks/belay-before-submit.mjs`
- `.cursor/hooks/belay-shell-gate.mjs`
- `.cursor/hooks/belay-tool-gate.mjs`
- `.cursor/hooks/belay-audit.mjs`
- `.cursor/belay/runtime/core.mjs`
- `.cursor/belay/pending-approvals.json`
- `.cursor/belay/approved-approvals.json`
- `.cursor/belay/audit.ndjson`

Optional skill and command artifacts (with `--with-skill`):

- `.cursor/skills/belay/SKILL.md`
- `.cursor/commands/belay-approve.md`

Packaged skill source for `npx skills add`:

- `skills/belay/SKILL.md`
- `skills/belay/belay-approve.md`

## Commands

```bash
npx agent-belay init
npx agent-belay init --with-skill
npx agent-belay upgrade
npx agent-belay doctor
npx agent-belay status
npx agent-belay explain -- <shell-command>
npx agent-belay explain --kind subagent -- "deploy to production"
npx agent-belay explain --kind tool --tool Write -- .env
npx agent-belay revoke <approval-id>
```

`mode: "audit"` is supported in `.cursor/belay.config.json`. In audit mode,
Belay records would-be denies but allows execution to continue.

### Config v2 highlights

`belay.config.json` uses `version: 2` with per-gate toggles and classifier
overrides:

```json
{
  "version": 2,
  "gates": {
    "shell": true,
    "subagent": true,
    "fileMutation": true,
    "toolShell": true
  },
  "classifier": {
    "strictChains": true,
    "customExternalCommands": [],
    "customAllowCommands": [],
    "sensitivePaths": [".env", ".env.*", "**/credentials/**"]
  },
  "audit": {
    "logPath": ".cursor/belay/audit.ndjson",
    "includeAssessment": true
  }
}
```

`strictChains: true` (default) scans every `&&`, `|`, and `;` segment and keeps
the strictest verdict. Set it to `false` to stop at the first deny segment.

`customAllowCommands` and `customExternalCommands` use exact command or segment
key matches only (no substring wildcards).

v0.1 configs are migrated automatically on load.

## Approval flow

High-risk actions are denied with an approval ID. Approve the next matching
action once by sending:

```text
/belay-approve <approval-id>
```

Approvals are one-shot and expire after 15 minutes by default.

## Existing Hooks

For the current Cursor-style adapter, `agent-belay` is designed to coexist with
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
import { classifyShell, mergeConfig } from 'agent-belay'
```

See also `agent-belay/core` for lower-level exports.
