---
name: belay
description: >-
  Guides approval when agent-belay blocks a high-risk shell command, subagent launch,
  or tool action. Use when an action is denied, blocked, or needs belay-approve, or when
  installing or checking belay hook health in a repository.
disable-model-invocation: true
---

# Belay

Belay installs repo-local hooks that gate high-risk shell commands, tool actions, and
subagent launches. Enforcement lives in hooks; this skill only explains the flow and
routes you to the CLI. It does not classify commands itself.

## Prerequisites

Run `npx agent-belay init` in the project root before relying on enforcement.
If you only installed this skill via `npx skills add`, approval instructions are
available, but the runtime gate is not installed yet. Run `agent-belay doctor` to
check whether hooks are present.

## When belay blocks an action

1. Read the approval ID in the deny message.
2. Approve once with `/belay-approve <approval-id>` or `agent-belay approve <approval-id>`.
3. Retry the original action unchanged.

For why it was blocked, use `/belay why <command>` or `agent-belay explain --command "<command>"`.
For the latest pending ask, use `/belay explain` or `agent-belay explain`.
For install health and audit visibility, use `/belay status` or `agent-belay status`.
For audit-only summary, use `/belay report` or `agent-belay report`.
For recovery advice after a block, use `/belay recover` or `agent-belay recover`.

## Install or repair

- Full install: `npx agent-belay init --with-skill`
- Interactive wizard: `npx agent-belay init-wizard`
- Health check: `agent-belay doctor`

Do not run init or doctor implicitly from this skill — only when the user asks.

## CLI mapping

| User intent | Command |
| --- | --- |
| Why was this blocked? | `agent-belay explain --command "..."` |
| Explain latest pending ask | `agent-belay explain` |
| Status / dogfood / audit visibility | `agent-belay status` |
| Audit summary (read-only) | `agent-belay report` |
| Recovery advice (advisory only) | `agent-belay recover` |
| Approve once | `agent-belay approve <id>` |
