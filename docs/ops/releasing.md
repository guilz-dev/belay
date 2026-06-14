# Releasing

This document describes the practical release procedure for `belay`.

For version bump rules, see [semver-policy.md](./semver-policy.md).

## Decide whether a release is needed

Not every repository change should become a new npm release.

Cut a new npm release when the published package changes, such as:

- CLI behavior
- runtime bundles in `dist/`
- exported APIs
- shipped skills
- packaged docs like `README.md`

Do **not** cut a new npm release for repository-only changes that are not part of
the published package, such as:

- GitHub issue templates
- GitHub Actions workflow-only changes
- labels, issue forms, and other repository settings

Those changes should usually land on `main` without publishing a new package
version.

## Choose the version

Pick the next version according to [semver-policy.md](./semver-policy.md).

For pre-`1.0.0` releases, still use the same intent:

- breaking or compatibility-sensitive changes: bump the leftmost changing part intentionally
- new behavior or capabilities: treat as a feature release
- fixes, docs, and internal cleanup with no intended behavior change: treat as a patch release

## Pre-release checklist

Before tagging or publishing:

1. Confirm the release scope is intentional and review the diff.
2. Update `package.json` to the target version.
3. Update `CHANGELOG.md` with a new version section and accurate release notes.
4. Ensure `README.md` and any user-facing docs match the shipped behavior.
5. Rebuild from a clean working tree and run:

```bash
scripts/pre-release-check.sh
```

That script runs lint, typecheck, tests, corpus, build, CLI version checks, and
`npm pack --dry-run`. Do not publish if it fails.

6. Verify Ubuntu and macOS CI are green on the release commit.

## Release steps

Once the release commit is ready on `main`:

1. Create and merge the release PR.
2. Pull the exact merged commit locally.
3. Create the git tag:

```bash
git tag v0.0.2
git push origin v0.0.2
```

4. Publish to npm:

```bash
npm publish
```

5. Create the GitHub Release for the same tag and reuse the `CHANGELOG.md`
   summary as release notes.

## Post-release verification

After publishing:

1. Confirm npm shows the expected version:

```bash
npm view @guilz-dev/belay version
```

2. Confirm the package can be fetched and invoked:

```bash
scripts/post-release-verify.sh 0.0.2
```

Or manually:

```bash
npx @guilz-dev/belay@0.0.2 --version
```

3. Confirm the GitHub tag and GitHub Release both point to the intended commit.
4. If the release changed installation or workflow guidance, verify the README
   quick start against the published package.

## Notes

- `package.json` already publishes with `access: public`.
- Prefer releasing from a clean, reviewed `main` commit rather than from a dirty
  working tree.
- If a release includes only repository metadata changes, skip `npm publish`.
