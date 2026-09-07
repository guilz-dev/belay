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

## Pre-release blocking check

Before tagging a release, pick one release-window cutoff timestamp (`since`, ISO8601) and run
this command once per **active local repository** corresponding to the entries above:

```bash
scripts/pre-release-dogfood-check.sh <target-dir> <since-iso>
```

The check must pass for every active repository. Copy the cutoff timestamp and command output into
the release PR.

## Out of scope

- **zoe-llc/avoid-shadow** — legacy `enforce` install (0.4.x); not on this roster
- **archive---agent-belay** working copy — archive only

Update this file and the `.ja.md` companion when adding or removing targets.
