# Dogfood install targets

Repositories where Belay runs in **dogfood mode** (`mode: audit` +
`policy.unknownLocalEffect: deny`). Use this list after releases for coordinated
`upgrade`, and as the canonical set of active cohort audit logs.

Maintainer notes (local paths, Japanese): [dogfood-install-targets.ja.md](./dogfood-install-targets.ja.md)

## Active targets (2026-08-22)

| GitHub | Role |
| --- | --- |
| [guilz-dev/belay](https://github.com/guilz-dev/belay) | Product repo; release verification |
| [DriveX-Co/scheduling-editor](https://github.com/DriveX-Co/scheduling-editor) | Primary real-distribution dogfood |
| [guilz-dev/pr-tour](https://github.com/guilz-dev/pr-tour) | Secondary dogfood |
| [agency-star/freelance.modis.co.jp](https://github.com/agency-star/freelance.modis.co.jp) | Secondary dogfood |

Last upgraded to `@guilz-dev/belay@0.9.1` on 2026-08-22.

The remediation runtime described below has not been released or installed on these targets yet.
Its release, cross-repository upgrades, new-cohort collection, and limited enforce trial remain
pending operator actions.

## Post-release upgrade

Run separate host Shell actions for `dogfood`, `upgrade`, `doctor`, and `status` in every active
repository. Set the host action's `working_directory` to that repository's absolute path. The host
supplies this field; the hook process's current directory does not select policy or state.

Each action runs exactly one command and includes a literal absolute `--target` for the same
repository. Do not wrap the commands in a shell function or a loop that changes directory through
a variable-derived path (such as `dir` or `wt`): readiness collection does not support dynamic
directory transitions.

**guilz-dev/belay product repo:** Do not rely on `npx @guilz-dev/belay@…` from inside the
repository root (same-package name resolution can fail with `belay: command not found`). With the
Shell action `working_directory` set to `/absolute/path/to/belay`, use the source build in separate
actions:

```bash
pnpm build
node /absolute/path/to/belay/dist/cli.js dogfood --target /absolute/path/to/belay
node /absolute/path/to/belay/dist/cli.js upgrade --with-skill --target /absolute/path/to/belay
node /absolute/path/to/belay/dist/cli.js doctor --target /absolute/path/to/belay
node /absolute/path/to/belay/dist/cli.js status --target /absolute/path/to/belay
```

For main sync + upgrade: [update-local-belay skill](../../.cursor/skills/update-local-belay/SKILL.md).

**Other dogfood targets:** Set `working_directory` to the active repository's absolute path, then
create separate Shell actions:

```bash
npx -y @guilz-dev/belay@<version> dogfood --target /absolute/target/path
npx -y @guilz-dev/belay@<version> upgrade --with-skill --target /absolute/target/path
npx -y @guilz-dev/belay@<version> doctor --target /absolute/target/path
npx -y @guilz-dev/belay@<version> status --target /absolute/target/path
```

In a monorepo or linked Git worktree, create this set of actions for every worktree where Cursor
may execute hooks. A sibling worktree without `belay.config.json` stays on defaults (`mode:
enforce`) and can still block host actions even when the main worktree is in dogfood (`mode:
audit`, `unknownLocalEffect: deny`).

`npx -y`, package publishing, push, and control-plane mutation can still require an exact
approval. Those are classifier decisions about the requested effect, not failures to establish the
action working directory.

See [releasing.md](./releasing.md) for publish steps.

## Per-target readiness evidence

Immediately before the first authorized upgrade, record one ISO8601 release-window cutoff and use
that same literal value for every active target. Do not choose it during local implementation
verification. For every target, run upgrade, diagnostics, harvest review, quality, and any eventual
enforce promotion as separate host actions whose literal `working_directory` and literal
`--target` name the same repository. Evidence from one target never promotes another.

Record this checklist separately for each target; do not include raw audit rows or raw session IDs:

- installed package/runtime version, full `runtimeArtifactHash`, full
  `decisionConfigFingerprint`, and `boundaryProfile`;
- the shared cutoff and retained-storage diagnostics: files and bytes read, parsed records,
  malformed lines skipped, and oversized lines skipped;
- zero active-cohort availability-caused asks after the cutoff;
- at least 150 reviewed `provably-benign` active-cohort events across at least three distinct valid
  session correlations;
- reviewed benign block rate strictly below 2%; and
- zero must-ask corpus misses, zero provably-benign corpus blocks, and
  `readyForEnforce: true`.

The active cohort's raw/classifier would-block rate remains useful diagnostic context, but it is
not the promotion criterion. Promotion uses only the reviewed benign denominator plus the
availability and corpus hard gates above.

`quality --target <target>` uses the canonical corpus shipped in the executing Belay package by
default. A target-local corpus participates only through an explicit `--corpus <path>` override;
record that path whenever an override is deliberately used. The evidence-backed check is:

```bash
node /absolute/path/to/belay/dist/cli.js quality --target /absolute/target/path --json
```

### Review the current cohort

List only post-cutoff candidates from the selected target's active cohort. The default excludes
candidates whose latest exact `(fingerprint, kind, boundaryProfile)` review already exists:

```bash
node /absolute/path/to/belay/dist/cli.js harvest list --target /absolute/target/path --since <shared-cutoff-iso> --json
```

Review every residual candidate. Use its exact command and full fingerprint from the JSON output,
choose one of `provably-benign`, `accepted-benign`, `must-ask`, or `reject`, and store only a short
privacy-safe reason. Prepare a disposable copy of the canonical corpus and pass it to every review
so captured command bodies never enter the source corpus automatically (`reject` records the review
without reading the copy):

```bash
node /absolute/path/to/belay/dist/cli.js harvest apply --target /absolute/target/path --command "<exact-command>" --fingerprint <64-hex> --outcome <outcome> --reason "<short-reason>" --corpus /private/tmp/belay-harvest-review/shell-commands.json
```

Rerun the current-cohort list until it has no residual candidates, and rerun `pnpm corpus` after
independently curating any privacy-safe, structurally representative case into the source corpus.
`--include-reviewed` is for auditing already reviewed candidates.
`--all-cohorts` is forensic mixed-history mode only and must not supply promotion evidence. The
frozen 35-item batch in
[dogfood-harvest-review-2026-09-07.md](./dogfood-harvest-review-2026-09-07.md) stays closed unless a
specific recorded review error is documented first.

### Retained audit generations

The defaults are `audit.maxBytes: 33554432` (32 MiB) and `audit.maxFiles: 5`, including the active
`audit.ndjson`. Numbered files are `.1` newest through `.4` oldest; readers stream the exact
retained set from oldest to active. Rotation is serialized by the audit lock. Metrics and doctor
report files/bytes read, parsed records, and skipped malformed or oversized lines; preserve those
counts with the readiness evidence and investigate nonzero skipped-line counts. Numbered rotation
never removes `audit.ndjson.legacy-*.ndjson` archives.

## Release-window blocking check

Immediately before the first authorized upgrade, pick one release-window cutoff timestamp
(`since`, ISO8601) and run this command once per **active local repository** corresponding to the
entries above after that target is upgraded:

```bash
scripts/pre-release-dogfood-check.sh <target-dir> <since-iso>
```

The check must pass for every active repository. Copy the cutoff timestamp and command output into
the release PR. Use the same cutoff for the post-upgrade cohort checks above; the cutoff remains
pending until immediately before the first authorized upgrade.

## Out of scope

- **zoe-llc/avoid-shadow** — legacy `enforce` install (0.4.x); not on this roster
- **archive---agent-belay** working copy — archive only

Update this file and the `.ja.md` companion when adding or removing targets.
