# agent-belay

<p align="center">
  <img src="./agent-belay-logo.png" alt="agent-belay logo" width="480">
</p>

`agent-belay` installs repo-local Cursor hooks that apply Belay-style gating to
shell commands and subagent launches.

Belay can be used on Stable Cursor via hooks. Optional Skill integration is
available on Nightly Cursor.

## Scope

`agent-belay` is an **agent-skill-oriented hook heuristic for Belay-style gating**, not the
full abstract Belay substrate model.

- It is optimized for Cursor hook payloads, which do not include an agent-side
  `Assessment`.
- In v0.1, it primarily denies **external or irreversible-looking effects**.
- Local mutations are usually allowed as `allow_flagged`, not blocked.
- Command-name and payload heuristics are part of the current implementation.

This means `agent-belay` is best understood as a practical hook gate for
agent runtimes that currently integrate through Cursor-style hooks, not as a proof that a command is truly reversible.

## Install

```bash
npx agent-belay init
```

Add `--nightly` to also generate the optional Skill and command artifacts:

```bash
npx agent-belay init --nightly
```

Re-running `init` is supported, but it **re-writes managed config and hook
files**. Keep local customizations outside the generated Belay files.

## What it installs

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

Nightly-only extras:

- `.cursor/skills/belay/SKILL.md`
- `.cursor/commands/belay-approve.md`

## Commands

```bash
npx agent-belay init
npx agent-belay doctor
```

`mode: "audit"` is supported in `.cursor/belay.config.json`. In audit mode,
Belay records would-be denies but allows execution to continue.

## Approval flow

High-risk actions are denied with an approval ID. Approve the next matching
action once by sending:

```text
/belay-approve <approval-id>
```

Approvals are one-shot and expire after 15 minutes by default.

## Existing Hooks

`agent-belay` is designed to coexist with existing repo-local Cursor hooks.

- Gate hooks are inserted with prepend semantics so they run before existing
  hooks for the same event.
- Audit hooks are appended so they observe the final flow after other hooks.
- Existing non-Belay hook entries are preserved in order.

If another hook also denies the same event, Cursor will still block it; Belay
does not try to suppress other repo policies.

## Git Hygiene

Belay state files are local runtime artifacts. They should usually stay out of
git.

Recommended ignore entries:

```gitignore
.cursor/belay/
.cursor/belay.config.json
.cursor/hooks/belay-*
.cursor/skills/belay/
.cursor/commands/belay-approve.md
```
