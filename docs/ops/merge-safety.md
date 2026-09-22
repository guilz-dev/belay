# Merge safety

This document records the repository merge policy for `guilz-dev/belay`. It
complements the GitHub Rulesets and the CI workflow in `.github/workflows/ci.yml`.

## Required status checks

All merges to `main` must pass these checks on the latest `main` tip:

| Check | Job |
|-------|-----|
| `verify` | Ubuntu lint, typecheck, structural gate, tests, corpus, build |
| `verify-docker` | Container boundary tests |
| `verify-macos` | macOS platform and installed-hook tests |

The workflow triggers on `push` (to `main`), `pull_request`, and `merge_group`.

## Ruleset settings

Use a separate active `require-green-ci` ruleset on the default branch
(Repository Settings → Rules → Rulesets):

The API payload is [require-green-ci.ruleset.json](./require-green-ci.ruleset.json).
Ruleset ID `23802903` was activated and read back on 2026-09-22.

- **Required checks:** `verify`, `verify-docker`, `verify-macos`
- **Strict / up-to-date:** enabled
- **Bypass list:** empty, including administrators and repository roles

Keep the existing `require-review` ruleset for requiring a PR and for
force-push / branch-deletion protection. Its required approval count is zero:
the repository owner's PRs must be mergeable after green CI without a separate
reviewer. The ruleset retains its historical name.

The rulesets apply together. The existing ruleset allows the owner to bypass
its PR requirement, but `require-green-ci` still enforces passing checks.
PR #151 merged while `verify` had failed under the old, bypassable check rule.

## Verification

After updating the ruleset, confirm via the GitHub API:

```bash
gh api repos/guilz-dev/belay/rulesets
gh api repos/guilz-dev/belay/rules/branches/main
ruleset_id="$(gh api repos/guilz-dev/belay/rulesets --jq '.[] | select(.name == "require-green-ci") | .id')"
gh api "repos/guilz-dev/belay/rulesets/${ruleset_id}"
```

Expected: an active `require-green-ci` ruleset includes only
`required_status_checks` with the three jobs listed above; its response shows
an empty `bypass_actors` array. The `require-review` ruleset remains active
with zero required approvals.

## Emergency bypass

If checks must be bypassed during an incident:

1. Record the reason on the PR timeline and in the postmortem before changing
   `require-green-ci`.
2. Do not release until `main` CI has been confirmed green after the incident.
