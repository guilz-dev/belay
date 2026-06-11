# Agent Belay

`agent-belay` is a practical Belay-style gate for agent runtimes.

The current integration targets hook-capable agent environments. v0.4+ ships
adapters for Cursor and Claude Code hooks.

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

## How it works

`agent-belay` hooks into specific agent runtime events and gates them before
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
  use `agent-belay explain` and `overrides.allow` to tune)
- `deny_pending_approval` — High-risk or ambiguous (external effects,
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

`agent-belay` is an **agent-skill-oriented hook heuristic for Belay-style gating**, not the
full abstract Belay substrate model.

- It forms an independent judgment on every gated action. Optional agent-side
  `Assessment` fields in the payload can reinforce confidence or surface mismatch
  signals, but never replace Belay's own verdict.
- It primarily denies **external or irreversible-looking effects**.
- Local mutations are usually allowed as `allow_flagged`, not blocked.
- Command-name and payload heuristics are part of the current implementation.

This means `agent-belay` is best understood as a practical hook gate for
agent runtimes, not as a proof that a command is truly reversible.

## Runtime Support

`agent-belay` is intended as an agent-facing package, not a Cursor-only product.

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

## Install

### Full setup (recommended)

```bash
npx agent-belay init --with-skill
npx agent-belay init --adapter claude
```

This installs the runtime hooks and also writes helper artifacts for:

- `.cursor/skills/belay/SKILL.md`
- `.cursor/commands/belay-approve.md`

### Hook runtime only

```bash
npx agent-belay init
```

### Upgrade from v0.1 / v0.2

```bash
npx agent-belay upgrade
```

`upgrade` refreshes hook scripts and the bundled runtime while merging your
existing `.cursor/belay.config.json` settings (v1/v2 configs migrate to v3).
When you newly enable `controlPlane`, existing repo-local approval files are
copied into the control-plane directory if it is empty.

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
- `.cursor/belay/pending-approvals.json` (or `~/.config/agent-belay/` when `controlPlane.enabled`)
- `.cursor/belay/approved-approvals.json` (or control-plane directory)
- `.cursor/belay/audit.ndjson` (always repo-local via `audit.logPath`)

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
npx agent-belay init --dogfood
npx agent-belay upgrade
npx agent-belay dogfood
npx agent-belay dogfood --enforce
npx agent-belay doctor
npx agent-belay doctor --fix
npx agent-belay metrics
npx agent-belay status
npx agent-belay explain -- <shell-command>
npx agent-belay explain --kind subagent -- "deploy to production"
npx agent-belay explain --kind tool --tool Write -- .env
npx agent-belay revoke <approval-id>
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
npx agent-belay dogfood
# or on init:
npx agent-belay init --dogfood
```

This sets `mode: "audit"` and `policy.unknownLocalEffect: "deny"`, and enables
`controlPlane.spikeOnPrompt` for OQ3 validation. Run `npx agent-belay metrics`
after normal agent work, check `npx agent-belay status` / `doctor` for OQ3 spike
results, tune `overrides.allow` with `explain`, then:

```bash
npx agent-belay dogfood --enforce
```

`policy.unknownLocalEffect: "deny"` enables fail-closed shell classification for
unrecognized local commands.

`controlPlane.enabled: true` stores approval state under
`~/.config/agent-belay/` (or `XDG_CONFIG_HOME/agent-belay`). The same path is
shared across repositories for the current OS user. Existing repo-local approval
files are copied or merged into the control plane on `upgrade`. Disabling control
plane merges approvals back to repo-local; run `npx agent-belay doctor --fix` to
archive orphaned files. Set `controlPlane.spikeOnPrompt: true` to validate hook
filesystem access (OQ3) — results land in `oq3-spike-last.json`.

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
