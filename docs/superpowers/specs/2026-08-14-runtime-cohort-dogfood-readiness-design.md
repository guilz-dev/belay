# Runtime-Cohort Dogfood Readiness Design

## Problem

Belay 0.8.0 records `runtimeVersion`, `runtimeBuildStamp`, and
`configFingerprint` on gate audit events, but `belay metrics`, `belay doctor`,
and `belay dogfood --enforce` still calculate readiness from the entire audit
log. An upgrade can therefore reuse evidence produced by an older policy
runtime or configuration.

This produces two incorrect outcomes:

- old noisy events can prevent a clean current runtime from ever becoming
  ready; and
- old clean events can make a newly installed runtime appear ready before it
  has produced any evidence.

The scheduling-editor log demonstrates the first case: all 1,130 existing gate
events predate its installed `0.8.0@2026-08-14T04:23:49.942Z` runtime.

## Considered Approaches

### 1. Rotate logs operationally only

Archive the old audit log whenever Belay is upgraded. This is immediately
usable, but relies on every operator remembering an undocumented safety step
and does not protect other repositories.

### 2. Select the active runtime/config cohort automatically

Keep the full audit log for historical reporting, while calculating dogfood
readiness only from gate evidence whose `runtimeBuildStamp` and
`configFingerprint` match the active installation and configuration. This is
the recommended approach because the safe behavior is automatic and
fail-closed.

### 3. Require an explicit metrics filter

Add flags such as `--runtime` or `--since` and require operators to use them.
This is useful for exploration, but it leaves `dogfood --enforce` vulnerable
to omitted or incorrect filters and expands the CLI surface unnecessarily.

## Design

### Active cohort identity

Introduce a focused runtime-provenance helper that reads the active adapter's
installed `core.mjs` and returns its package version and build stamp. Reuse the
same canonical configuration hashing used by the gate runtime to derive the
active `configFingerprint`.

The readiness cohort is the set of audit records for which both fields match:

```text
record.runtimeBuildStamp === installedRuntimeBuildStamp
record.configFingerprint === activeConfigFingerprint
```

Version-only or unrecorded legacy events never qualify. If the installed
runtime identity cannot be read, readiness remains false rather than falling
back to all-time data.

### Metrics model

`AuditMetricsReport` will retain its existing all-time aggregates for audit
history and compatibility. It will add an explicit current-cohort section
containing:

- cohort identity;
- matching and excluded gate-event counts;
- cohort would-block and classifier-quality rates; and
- cohort availability-ask information needed by the readiness decision.

Dogfood notes and `readyForEnforce` will use only this cohort. Human-readable
output will label all-time totals and current-cohort totals so they cannot be
confused. JSON output will expose both structures.

### Consumers

- `belay metrics` displays historical totals and the active cohort.
- `belay doctor` keeps installation health separate from dogfood readiness and
  reports cohort counts/rates in its dogfood section.
- `belay dogfood --enforce` uses current-cohort readiness and refuses promotion
  when the cohort is missing, empty, undersampled, noisy, or has availability
  failures.
- Existing general `belay report` history remains all-time. Its fence-drift
  warning is not an enforce authorization signal and is outside this focused
  fix.

### Failure behavior

All missing or inconsistent provenance states fail closed for readiness:

- installed runtime stamp unavailable;
- current config fingerprint unavailable;
- no matching events;
- legacy events only; or
- records matching only one identity field.

The output explains how many events were excluded and asks the operator to run
normal agent work under the active cohort. `--force` remains an explicit
operator override and is not changed.

## Test Strategy

Add regression coverage for these cases:

1. Twenty old clean events and zero current events do not become ready.
2. Old noisy events plus twenty current clean events become ready.
3. Same runtime stamp with a different config fingerprint is excluded.
4. Current-cohort availability failures withhold readiness.
5. Missing runtime provenance fails closed with an explanatory note.
6. Metrics output shows both all-time and current-cohort counts.
7. `dogfood --enforce` consumes cohort readiness rather than all-time metrics.
8. Doctor exposes current-cohort dogfood counts without treating old events as
   current evidence.

Tests will follow red-green-refactor: each behavior must fail for the expected
reason before production code changes are written.

## Scheduling-editor Cutover

After the product fix is verified, preserve the existing scheduling-editor
audit log by renaming it to `audit.pre-0.8.0.ndjson`. Do not delete it. The gate
runtime recreates `audit.ndjson` on the next event. Confirm the new log begins
with the installed 0.8.0 build stamp and current config fingerprint, then leave
the repository in audit mode until representative current-cohort evidence has
been collected. Do not use `--force`.

## Non-goals

- Adding arbitrary time-range or runtime-selection CLI flags.
- Deleting or migrating historical audit records.
- Changing EffectPlan semantics or readiness thresholds.
- Changing the semantics of `--force`.
- Automatically promoting any repository to enforce mode.
