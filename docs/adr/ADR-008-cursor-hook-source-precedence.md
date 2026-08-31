# ADR-008 — Cursor hook source precedence

- Status: Accepted
- Date: 2026-08-31
- Related: [ADR-007](./ADR-007-global-hook-workspace-resolution.md)

## Context

Cursor can spawn matching hooks from its User/global configuration and from more than one Project
configuration for the same host event. Without a Belay ownership boundary, each installed source
can evaluate the same action, load the full policy runtime, consume approval state, and append a
separate audit record.

The hook process working directory does not identify the action repository. In a multi-root
workspace it can identify a different project or the global Cursor directory. Symlink spellings can
also make one repository look like two sources.

## Decision

1. **One effective source per canonical event** — Every generated Cursor hook first enters the
   lightweight dispatcher. The dispatcher selects an owner before importing the policy runtime.
   Cursor may still spawn every matching source, but only the effective owner evaluates policy or
   touches approval, control-plane, or audit state.

2. **Project precedence** — For an action repository whose config declares
   `installScope: "project"`, the matching Project installation owns the event and User/global and
   nonmatching Project sources are neutral. For a config declaring `installScope: "global"`, the
   User/global installation owns the event and Project sources are neutral.

3. **Action-repository selection** — Ownership uses ADR-007's payload-first action directory:
   `tool_input.working_directory` for `preToolUse: Shell`, otherwise top-level `cwd`, then the first
   non-empty `workspace_roots[]` entry. Belay finds the nearest initialized repository from that
   directory. Existing paths and project origins are canonicalized, so symlink-equivalent paths do
   not create another owner.

4. **Neutral and fail-closed routes** — A non-owner returns the host-appropriate neutral response
   without importing `core.mjs`: `{ "permission": "allow" }` for gates,
   `{ "continue": true }` before prompt submission, and `{}` for audit hooks. A User/global hook is
   also neutral when the selected repository has no Belay config. If the selected config requires a
   Project owner but its router-visible current-event installation is incomplete, gates and prompts
   deny with repair guidance; audit hooks emit a diagnostic and return `{}`. Missing or malformed
   action context fails closed for gates/prompts and remains audit-safe.

5. **Migration and diagnosis** — Current Project upgrades refresh an existing, exactly recognized
   managed global Cursor installation to the router-aware generation. Operators with a pre-router
   global bundle must run `belay upgrade --scope global` (or upgrade a managed Project installation
   that can prove the global entry belongs to Belay). `belay doctor` reports pre-router global
   bundles, origin/generation mismatches, and incomplete intended owners as issues. A healthy
   router-aware global source shadowed by a Project owner is an informational note.

## Consequences

- One Cursor action delivered as one canonical event has one effective Belay policy evaluation and
  one gate audit append even when Cursor launches User/global and multiple Project hook processes.
- Non-owner processes pay only dispatcher/routing cost and do not load the heavy core.
- No config, policy, EffectPlan, approval, or audit schema changes are introduced.
- Hook settings retain exact managed-entry migration rules; unrelated hooks and sibling projects
  are not rewritten or removed.

## Limits

This is source precedence, not a general cross-process event-id deduplicator. Different canonical
events remain different processes and evaluations: for example `beforeShellExecution` and
`preToolUse: Shell` are not collapsed into one event. If Cursor delivers the same canonical event
to the effective owner more than once, this ownership rule alone does not merge those repeated
deliveries. If an entrypoint needed to reach the dispatcher itself is absent, the host process can
only surface its launch failure; `belay doctor` is the preflight detection and repair path.

## Verification

The process integration creates an isolated temporary Cursor home and two initialized Project
repositories, invokes all three generated commands with one action-repository payload, and asserts
one core import and one audit record. It also covers Project-only, global-only, uninitialized,
incomplete-Project, canonical symlink, and distinct-event cases.
