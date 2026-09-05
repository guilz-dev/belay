# Merge safety

This document records the repository merge policy for `guilz-dev/belay`. It
complements the GitHub Ruleset named `require-review` and the CI workflow in
`.github/workflows/ci.yml`.

## Required status checks

All merges to `main` must pass these checks on the latest `main` tip (including
merge queue runs):

| Check | Job |
|-------|-----|
| `verify` | Ubuntu lint, typecheck, structural gate, stable tests, corpus, build |
| `verify-docker` | Container boundary tests |
| `verify-macos` | macOS structural gate and stable tests |

The workflow triggers on `push` (to `main`), `pull_request`, and `merge_group`
so pull requests and queued merges report the same job names.

## Ruleset settings

Apply these settings on the `require-review` ruleset (Repository Settings →
Rules → Rulesets):

- **Required checks:** `verify`, `verify-docker`, `verify-macos`
- **Strict / up-to-date:** enabled
- **Merge queue:** required
- **Build concurrency:** 1
- **Maximum PRs to merge:** 1
- **Only merge non-failing PRs:** enabled
- **Check timeout:** 30 minutes
- **OrganizationAdmin always-bypass:** removed

Existing PR review requirements and force-push / branch-deletion protection stay
in place.

## Verification

After updating the ruleset, confirm via the GitHub API:

```bash
gh api repos/guilz-dev/belay/rulesets
gh api repos/guilz-dev/belay/rulesets/17656073
```

Expected: active rules include `required_status_checks` and `merge_queue` with
the three jobs listed above, and no `OrganizationAdmin` entry with
`bypass_mode: always`.

## Emergency bypass

If a ruleset bypass is required during an incident:

1. Record the reason on the PR timeline and in the postmortem.
2. Do not release until `main` CI has been confirmed green after the incident.
