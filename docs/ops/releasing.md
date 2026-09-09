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

6. For the **Belay product checkout only**, set the host Shell action `working_directory` to the
   Belay checkout and invoke its source-build helper by absolute path with a pre-release cutoff:

```bash
/absolute/path/to/belay/scripts/pre-release-dogfood-check.sh /absolute/path/to/belay <pre-release-cutoff-iso>
```

   The helper changes to the Belay checkout and runs `pnpm build`; it is not a valid check action
   for another target repository. Record its result in the release PR. Do not select the shared
   release-window cutoff or execute the requested package in another repository before publish.

7. Verify Ubuntu and macOS CI are green on the release commit.

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
npm whoami
npm publish
```

   **Do not use `--otp`.** OTP-based publish is not part of this project's release
   workflow and cannot be used by agents or non-interactive automation.

   | Method | Role |
   | --- | --- |
   | Granular Access Token (Bypass 2FA) | Primary path for local/CI publish; set in `~/.npmrc` or `NPM_TOKEN` with publish rights for `@guilz-dev` |
   | OIDC trusted publishing | Tokenless publish from GitHub Actions (migration target before bypass-GAT direct publish ends ~2027-01) |
   | `--otp` | **Not used here.** Requires interactive TOTP; not a valid release unblock for agents |

   Before publishing, `npm whoami` must succeed. On `EOTP`, `ENEEDAUTH`, or `E403`:

   - Configure a publish-capable Granular Access Token (Bypass 2FA) in `~/.npmrc` /
     `NPM_TOKEN`; do not ask the operator for an OTP.
   - An `EOTP` with a successful `npm whoami` usually means a 2FA login session is
     active but no bypass publish token is configured.
   - Regenerate the token at [npmjs.com/settings/~/tokens](https://www.npmjs.com/settings/~/tokens) if needed.

   npm revoked classic tokens (Nov 2025). Bypass-2FA GAT direct publish is scheduled
   to end around Jan 2027; plan OIDC or staged publishing before then. See
   [GitHub Changelog 2026-07-31](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/).

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

5. Immediately before the first authorized target upgrade, choose one shared release-window
   cutoff (`since`, ISO8601). Record it in the release PR and reuse that same literal cutoff for
   every active target listed in
   [dogfood-install-targets.md](./dogfood-install-targets.md).

6. Perform each authorized target upgrade. Run `upgrade` as a separate host Shell action from that
   target's own trusted, literal absolute `working_directory`, with the same literal absolute
   `--target`. After the upgrade, run `dogfood`, `doctor`, and `status` as separate actions under
   that same working-directory/target rule. Follow the product-checkout and published-package forms in
   [dogfood-install-targets.md](./dogfood-install-targets.md); do not use a shell loop or a function
   that changes to a variable-derived directory. Record every upgrade and diagnostic result in the
   release PR.

7. After each non-Belay target has been upgraded, run the published release check as a separate
   host Shell action from that target's own trusted working directory:

```bash
npx -y @guilz-dev/belay@<version> dogfood --check --target /absolute/target/path --since <literal-shared-cutoff-iso> --json
```

   An explicitly unpacked released artifact may be used instead, but its CLI path must be absolute;
   do not rely on a `belay` found through `PATH`. Do not combine target checks in a loop or run them
   from the Belay checkout. Record every command and result in the release PR. All target checks
   must pass before the release is considered verified.

   `npx -y`, package publishing, push, and control-plane mutation may still need exact
   approval. Selecting the cutoff, upgrading another repository, and running its checks remain
   explicit operator-authorized external actions. These are classifier decisions, not
   action-working-directory availability failures, and this local operator gate must not be moved
   into public GitHub CI.

## npm authentication

This project does **not** use OTP (`npm publish --otp`) for releases. Agents must not
ask operators for OTP codes.

| Method | Notes |
| --- | --- |
| Granular Access Token (Bypass 2FA) | Publish scope for `@guilz-dev`; set in `~/.npmrc` or `NPM_TOKEN` |
| OIDC trusted publishing | Tokenless CI publish; preferred long-term path |
| `--otp` | **Not used** — interactive TOTP only; not available as an agent/automation unblock |

Verify auth before every publish:

```bash
npm whoami
```

If publish fails with `EOTP`, switch to a Bypass-2FA Granular Access Token rather than
waiting for OTP input.

## Notes

- `package.json` already publishes with `access: public`.
- Prefer releasing from a clean, reviewed `main` commit rather than from a dirty
  working tree.
- If a release includes only repository metadata changes, skip `npm publish`.
