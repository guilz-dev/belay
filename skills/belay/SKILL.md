---
name: belay
description: >-
  Guides approval when belay blocks a high-risk shell command, subagent launch,
  or tool action across Cursor, Claude Code, and Codex. Use when an action is
  denied, blocked, or needs belay-approve, or when installing or checking belay
  hook health in a repository.
disable-model-invocation: true
---

# Belay

Belay is a safety gate for coding agents: it inspects each shell command,
subagent launch, and file mutation *before* it runs, lets safe-and-local actions
through, and holds back only the irreversible-and-catastrophic ones for one-shot
human approval. Every decision is written to an audit log.

It runs on **Cursor**, **Claude Code**, and **Codex (experimental)**, wiring the
same classifier into each agent through its native hooks:

| Agent | Hook config |
| --- | --- |
| Cursor | `.cursor/hooks.json` |
| Claude Code | `.claude/settings.json` |
| Codex | `.codex/config.toml` |

Enforcement lives in those hooks; this skill only explains the flow and routes
you to the CLI. It does not classify commands itself.

## Prerequisites

`npx skills add` installs this skill only — the runtime gate is **not installed**
until hooks are configured. Run `belay config` in the project root for interactive
setup (or `npx @guilz-dev/belay init` for non-interactive install). Run
`belay doctor` to check whether hooks are present.

## When belay blocks an action

1. Read the approval ID in the deny message.
2. Approve once with `/belay-approve <approval-id>` or `belay approve <approval-id>`.
3. Retry the original action unchanged.

For why it was blocked, use `/belay why <command>` or `belay explain --command "<command>"`.
For the latest pending ask, use `/belay explain` or `belay explain`.
For install health and audit visibility, use `/belay status` or `belay status`.
For audit-only summary, use `/belay report` or `belay report`.
For recovery advice after a block, use `/belay recover` or `belay recover`.

## Install or repair

- Interactive setup: `belay config`
- Non-interactive install: `npx @guilz-dev/belay init --with-skill`
- Health check: `belay doctor`

Do not run init, config, or doctor implicitly from this skill — only when the user asks.

## CLI mapping

| User intent | Command |
| --- | --- |
| Set up or change judge settings | `belay config` |
| Why was this blocked? | `belay explain --command "..."` |
| Explain latest pending ask | `belay explain` |
| Status / dogfood / audit visibility | `belay status` |
| Audit summary (read-only) | `belay report` |
| Recovery advice (advisory only) | `belay recover` |
| Approve once | `belay approve <id>` |
