# Cursor audit non-blocking lifecycle design

## Problem

Cursor evaluates a hook entry's `failClosed` value before Belay starts. Every
managed Cursor entry currently sets it to `true`. If the runner, shim, or
`dispatcher.mjs` is missing or cannot be loaded, Cursor therefore blocks the
host action even when Belay is configured for audit mode. Belay cannot catch
this failure because no Belay JavaScript has run yet.

The 2026-09-25 incident also exposed a lifecycle race. Several Cursor sessions
ran global uninstall and upgrade against the same `~/.cursor` owner. The
installer has atomic writes for individual runtime files, but it has no lock,
durable uninstall intent, whole-install invariant, or writer log. An upgrade
can publish hooks while an uninstall deletes the artifacts those hooks need.

## Evidence and causal boundary

- The failing process reported `ERR_MODULE_NOT_FOUND` for
  `~/.cursor/belay/runtime/dispatcher.mjs` while a managed global hook still
  referenced it.
- On 2026-09-25, Cursor transcripts show two uninstall sessions and a repair
  session using an older built CLI. Cursor's hook log records the managed hook
  count alternating from 23 to 10 to 23 to 10 to 23.
- On 2026-09-22, a transcript records a pre-fix HOME-target upgrade removing
  the global artifacts and then restoring only `hooks.json`. That operation
  deterministically produced the same hook-present/artifact-missing signature.
- The exact process that removed the dispatcher before the first 09:01 failure
  is not logged, so it must not be presented as proven. The later 09:17 and
  09:19 recurrences are explained by the recorded concurrent writers.

## Safety contract

1. Every Belay-managed Cursor hook entry sets `failClosed: false`.
2. Once Belay starts successfully, its own enforce-mode verdict may still deny
   an action. Host startup failure can never deny an action.
3. Cursor lifecycle commands that can touch the same owner are serialized by
   scope-directory locks acquired in canonical path order.
4. Uninstall records a durable tombstone before it removes ownership. Ordinary
   upgrade refuses to reactivate a tombstoned scope. Explicit `init`, or
   `upgrade --reactivate`, may reactivate it.
5. Install/upgrade publish hooks only after required artifacts exist. Before
   success they verify every required artifact is a regular file and every
   managed hook is present with `failClosed: false`. If validation fails, they
   remove managed hook publication before returning an error.
6. Uninstall verifies that managed hooks and managed runtime artifacts are
   absent and that its tombstone remains.
7. Lifecycle actions append start/result records outside the removable runtime
   directory, including operation ID, PID, scope, target, timestamps, and
   outcome. The log survives uninstall.
8. `hooks.json`, tombstones, and lifecycle records use same-directory atomic
   publication where a replaceable file is involved. Existing unrelated hooks
   are preserved.

## Files and state

For a scope whose `hooks.json` is `<agent-dir>/hooks.json`:

- lock: `<agent-dir>/.belay-lifecycle.lock/owner.json`
- tombstone: `<agent-dir>/belay.disabled.json`
- log: `<agent-dir>/belay-lifecycle.ndjson`

The lock owner contains a random token and PID. A lock is recoverable only
when its recorded PID is no longer alive. Release removes the directory only
when the token still matches. Acquisition has a bounded timeout and always
releases in `finally`.

The tombstone contains schema version, operation ID, scope, target repository,
PID, and timestamp. It is created before hook removal and cleared only after a
complete explicit reactivation passes its end-state invariant.

## Scope interactions

- Project init/upgrade locks the global owner too when a managed installation
  or tombstone there may require refresh or cleanup.
- Global init/upgrade locks the project owner too when a managed installation
  or tombstone there may require stale-owner cleanup.
- Uninstall locks the selected owner. HOME overlap deduplicates identical lock
  paths.
- A project upgrade skips a tombstoned global owner and does not resurrect it.

## Compatibility

No external dependency is added. Node.js 22 filesystem primitives provide
exclusive directory creation, atomic rename, and PID liveness checks. Existing
managed entries with `failClosed: true` are migrated on init/upgrade because
managed-entry identity excludes the `failClosed` field.

An older checkout-local CLI cannot be forced to honor a protocol added after it
was built. Deployment must remove or stop invoking stale `dist/cli.js` builds;
otherwise they can republish `failClosed: true` and bypass the new lock and
tombstone. Settings-only restoration is unsupported because it does not restore
the matching runtime artifact generation.

## Verification

- Managed-entry serialization and doctor expectations cover host fail-open.
- Existing runtime tests continue to prove that a running enforce-mode hook can
  return an explicit denial.
- Lifecycle unit/integration tests cover live-lock timeout, dead-lock recovery,
  uninstall tombstones, ordinary-upgrade refusal, explicit reactivation,
  global refresh suppression, invariant rollback, log persistence, and HOME
  path deduplication.
- Full build, typecheck, lint, and test suites must pass.
