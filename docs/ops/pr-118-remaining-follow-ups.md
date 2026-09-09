# PR #118 Remaining Follow-ups

Status: P0/P1 completed by the recent-review remediation on 2026-09-10

When PR #118 merged, it did not publish a package, upgrade another repository, or enable enforce
mode. At that point, the two items below remained required before enforce activation or the next
release workflow that depended on cross-repository dogfood evidence.

Completion record:

- `2231ad1` implements retained-evidence readiness reconstruction (P0).
- `6bed57e` binds harvest reviews to their source boundaries.
- `208b6ba` safely recovers locks left by crashed audit writers.
- P1 is completed by the release-ordering update that retains this historical problem statement.

## P0: Seed repaired readiness state from retained audit evidence — completed in `2231ad1`

Original problem statement (historical):

The persistent availability watermark currently fails readiness closed when it is missing,
malformed, or for another cohort. Its next repair starts from the incoming gate record, however,
instead of first reconstructing same-cohort availability asks that are still present in retained
audit generations. A legacy availability ask can therefore be forgotten after subsequent rotation.

Required implementation:

- Under the existing audit writer lock, inspect the exact retained generations before rotation.
- Stream the bounded retained records and reconstruct availability count and timestamps only for
  the incoming record's cohort.
- Apply the incoming availability delta exactly once.
- Do not rescan or double-count when a valid current-cohort sidecar already exists.
- Reset only for a proven cohort transition; missing, malformed, or unreadable evidence must not be
  treated as a trusted zero.
- Preserve the existing 4 KiB sidecar limit, atomic replace, symlink checks, bounded reads, and
  privacy restriction against commands, cwd values, and payload bodies.

Acceptance evidence:

- A legacy current-cohort availability ask with no sidecar is retained through a non-availability
  append and rotation.
- After adding 150 reviewed benign events across three sessions, `quality` still reports at least
  one sticky availability ask and both `trafficReadyForEnforce` and `readyForEnforce` remain false.
- Missing, malformed, same-cohort, and different-cohort sidecar cases have focused storage tests.

The initial RED integration test for this scenario is intentionally excluded from PR #118 and is
saved locally in the named stash `wip: sticky readiness seed RED test`.

## P1: Run cross-repository checks only after package publication — completed

Original problem statement (historical):

The release guide currently asks non-Belay targets to execute the requested release version before
that version is published. This makes the documented order impossible for a new version.

Completed disposition: [releasing.md](./releasing.md) now keeps only the Belay source-build helper
in pre-release checks, then selects the shared cutoff, performs authorized target upgrades, and
runs the pinned published-package checks after publication. Every result is retained in the release
PR.

Required documentation change:

- Keep source-build helper checks in the pre-release phase and scope them to the Belay checkout.
- Move non-Belay checks using `@guilz-dev/belay@<version>` after npm publication and the authorized
  target upgrade.
- Choose one shared cutoff immediately before the first authorized target upgrade.
- Run each target from its own trusted working directory and pass a literal absolute `--target`.
- Record the shared cutoff and every target result in the release PR.

## Non-blocking backlog

These findings did not block PR #118 or enforce readiness. Items not marked completed should be
handled in later focused changes:

1. Clarify whether `harvest apply --include-reviewed` should accept already reviewed candidates.
2. Reject malformed Git ranges containing additional dots consistently.
3. Remove ambiguity between dotted numeric values and path-like command arguments.
4. Keep Makefile continuation parsing fail-closed when the following line is not tab-indented.
5. Normalize canonical `tool_name` projection across adapters.
6. Define fail-closed behavior for unknown future snapshot schemas.
7. Prefer explicit telemetry cwd evidence in the Claude adapter when multiple cwd sources exist.
8. Recheck lock-file ownership after open/stat failures so orphan cleanup cannot race. Completed in
   `208b6ba` with inode-bound recovery claims and owner-token verification.
9. Keep lock acquisition timeout behavior within the documented deadline. Completed in `208b6ba`;
   the 2,000 ms deadline remains authoritative.
10. Escape remaining C1 control characters in raw session identifiers used by diagnostics.

## Explicitly out of scope for this merge

- npm publication, GitHub release, or tag creation
- upgrades of active dogfood repositories
- selection of the release-window cutoff
- activation of enforce mode

P0 is implemented and verified, but this documentation change does not activate enforce mode.
Enforce activation still requires the ordinary readiness gates and a separately authorized
operator decision.
The executable task breakdown remains in
[`2026-09-08-pr118-readiness-followup.md`](../superpowers/plans/2026-09-08-pr118-readiness-followup.md).
