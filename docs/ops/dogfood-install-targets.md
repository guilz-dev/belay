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

**guilz-dev/belay product repo:** Do not rely on `npx @guilz-dev/belay@…` from inside the
repository root (same-package name resolution can fail with `belay: command not found`). Use the
source build instead:

```bash
cd /path/to/belay
pnpm build
node dist/cli.js upgrade --with-skill
node dist/cli.js doctor
node dist/cli.js status
```

For main sync + upgrade: [update-local-belay skill](../../.cursor/skills/update-local-belay/SKILL.md).

**Other dogfood targets:** In each repo root:

```bash
npx @guilz-dev/belay@<version> upgrade --with-skill
npx @guilz-dev/belay@<version> doctor
```

For monorepos or linked Git worktrees, run the same `upgrade` + `doctor` + `dogfood` sequence in
each worktree where Cursor may execute hooks. A sibling worktree without `belay.config.json` stays
on defaults (`mode: enforce`) and can still block host actions even when the main worktree is in
dogfood (`mode: audit`, `unknownLocalEffect: deny`).

See [releasing.md](./releasing.md) for publish steps.

## Pre-release blocking check

Before tagging a release, pick one release-window cutoff timestamp (`since`, ISO8601) and run
this command for **each active local target** corresponding to the repositories above:

```bash
scripts/pre-release-dogfood-check.sh <target-dir> <since-iso>
```

The check must pass for every active target. Copy the cutoff timestamp and command output into
the release PR.

## Out of scope

- **zoe-llc/avoid-shadow** — legacy `enforce` install (0.4.x); not on this roster
- **archive---agent-belay** working copy — archive only

Update this file and the `.ja.md` companion when adding or removing targets.
