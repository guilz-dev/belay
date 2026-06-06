---
name: belay
description: >-
  Belay approval helper for Cursor. Use when a shell command or subagent launch
  is denied as high-risk and needs a one-shot approval.
---

# Belay

Belay installs repo-local hooks that gate high-risk shell commands and subagent
launches. Enforcement lives in hooks; this Skill only explains the flow.

## Prerequisites

Run `npx agent-belay init` in the project root before relying on this skill.
If you only installed this skill via `npx skills add`, the approval instructions
are available, but the runtime gate is not installed yet.

## Approval flow

If Belay blocks an action, it returns an approval ID. Approve the next matching
action once by sending:

```text
/belay-approve <approval-id>
```

Then retry the original action unchanged. Approvals are one-shot.
