# Merge safety

This document records the repository merge policy for `guilz-dev/belay`. It
complements the GitHub Rulesets and the CI workflow in `.github/workflows/ci.yml`.

## Required status checks

All merges to `main` must pass these checks on the latest `main` tip (including
merge queue runs):

| Check | Job |
|-------|-----|
| `verify` | Ubuntu lint, typecheck, structural gate, tests, corpus, build |
| `verify-docker` | Container boundary tests |
| `verify-macos` | macOS platform and installed-hook tests |

The workflow triggers on `push` (to `main`), `pull_request`, and `merge_group`
so pull requests and queued merges report the same job names.

## Ruleset settings

Use a separate active `require-green-ci` ruleset on the default branch
(Repository Settings → Rules → Rulesets):

The API payload is [require-green-ci.ruleset.json](./require-green-ci.ruleset.json).
Ruleset ID `23802903` was activated and read back on 2026-09-22.

- **Required checks:** `verify`, `verify-docker`, `verify-macos`
- **Strict / up-to-date:** enabled
- **Merge queue:** required
- **Build concurrency:** 1
- **Maximum PRs to merge:** 1
- **Only merge non-failing PRs:** enabled
- **Check timeout:** 30 minutes
- **Bypass list:** empty, including administrators and repository roles

Keep the existing `require-review` ruleset for PR review requirements and
force-push / branch-deletion protection. Its bypass actors must not be able to
bypass `require-green-ci`. A single ruleset with both checks and bypass actors
does not enforce green CI for those actors: PR #151 merged while `verify` had
failed.

## Verification

After updating the ruleset, confirm via the GitHub API:

```bash
gh api repos/guilz-dev/belay/rulesets
gh api repos/guilz-dev/belay/rules/branches/main
ruleset_id="$(gh api repos/guilz-dev/belay/rulesets --jq '.[] | select(.name == "require-green-ci") | .id')"
gh api "repos/guilz-dev/belay/rulesets/${ruleset_id}"
```

Expected: an active `require-green-ci` ruleset includes
`required_status_checks` and `merge_queue` with the three jobs listed above,
and the individual ruleset response shows an empty `bypass_actors` array.
The `require-review` ruleset remains active.

## Emergency bypass

If checks or the merge queue must be bypassed during an incident:

1. Record the reason on the PR timeline and in the postmortem before changing
   `require-green-ci`.
2. Do not release until `main` CI has been confirmed green after the incident.
