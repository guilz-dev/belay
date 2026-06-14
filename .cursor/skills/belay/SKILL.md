---
name: belay
description: >-
  Guides approval when belay blocks a high-risk shell command, subagent launch,
  or tool action. Use when an action is denied, blocked, or needs belay-approve, or when
  installing or checking belay hook health in a repository.
disable-model-invocation: true
---

# Belay

Belay installs repo-local hooks that gate high-risk shell commands, tool actions, and
subagent launches. Enforcement lives in hooks; this skill only explains the flow and
routes you to the CLI. It does not classify commands itself.

## Prerequisites

Run `npx @guilz-dev/belay init` in the project root before relying on enforcement.
If you only installed this skill via `npx skills add`, approval instructions are
available, but the runtime gate is not installed yet. Run `belay doctor` to
check whether hooks are present.

## When belay blocks an action

1. Read the approval ID in the deny message.
2. Approve once with `/belay-approve <approval-id>` or `belay approve <approval-id>`.
3. Retry the original action unchanged.

For why it was blocked, use `/belay why <command>` or `belay explain --command "<command>"`.
For the latest pending ask, use `/belay explain` or `belay explain`.
For install health, use `/belay status` or `belay status`.

## Install or repair

- Full install: `npx @guilz-dev/belay init --with-skill`
- Interactive wizard: `npx @guilz-dev/belay init-wizard`
- Health check: `belay doctor`

Do not run init or doctor implicitly from this skill — only when the user asks.

## CLI mapping

| User intent | Command |
| --- | --- |
| Why was this blocked? | `belay explain --command "..."` |
| Explain latest pending ask | `belay explain` |
| Status / dogfood | `belay status` |
| Approve once | `belay approve <id>` |
