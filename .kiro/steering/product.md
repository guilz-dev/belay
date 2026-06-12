# Product

`agent-belay` is a context-aware safety gate for AI agent runtimes. Instead of relying on
static command denylists, it makes its own runtime judgment about each gated action and
falls back to explicit human approval when an action looks risky.

## What it does

It hooks into agent runtime events and gates them before they take effect. The v0.1 adapter
targets Cursor-style hooks and gates two kinds of actions:

- Shell execution (`beforeShellExecution`)
- Subagent / Task launches (`preToolUse` for `Task`, `subagentStart`)

For each gated action it runs a lightweight classifier that estimates four dimensions:

- **reversibility** — can this be undone?
- **external effects** — does it reach outside the machine?
- **blast radius** — how much could it affect?
- **operator confidence** — how sure are we?

## Verdicts

The classifier assigns one of three verdicts:

- `allow` — safe to execute without intervention (e.g. read-only commands)
- `allow_flagged` — local mutation or unknown-but-local effect; allowed but recorded for audit
- `deny_pending_approval` — high-risk or ambiguous; blocks execution and issues an approval ID

## Approval flow

Denied actions emit an approval ID. The user approves the next matching action once by sending
`/belay-approve <approval-id>`. Approvals are one-shot and expire after 15 minutes by default.
Every decision is appended to `.cursor/belay/audit.ndjson`.

In `audit` mode (set in `.cursor/belay.config.json`), would-be denies are logged but execution
still proceeds.

## Scope and intent

This is a practical hook heuristic, not a formal proof of reversibility. It always forms its own
judgment and does not depend on an agent-supplied assessment in the payload. The CLI installs and
verifies the runtime; the optional Skill artifact is only a UX layer.
