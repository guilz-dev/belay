# Task 4 Implementer Report

## Summary

Implemented a contained-only Docker execution and attestation route without integrating it into
the gate.

- Enabled session start resolves the explicitly configured local image using
  `docker image inspect`; it never pulls or builds. It creates a probe container with the same
  hardened argument builder used for runtime, verifies the complete inspect result, runs the
  probe command, confirms container removal, and signs a container-only contained capability.
- The contained capability binds the immutable image ID, resource limits, host UID:GID,
  `/bin/sh` entrypoint, cap/security policy, a 64 MiB `/tmp` tmpfs with mode `01777` and
  `nosuid,nodev,noexec`, and the exact proxy-neutralization rule. Existing general boundary
  booleans remain false and `isolatesWorkspaceMounts` remains false.
- Runtime verifies the signed attestation against the repository and control-plane signing key,
  checks both envelope and contained-capability freshness, requires exact configured/fixed-policy
  and host-identity matches, then resolves the configured image reference again and executes only
  the attested immutable ID.
- The runtime accepts exactly one Task 3 `file_copy` mirror at the original absolute guest path,
  validates the guest cwd against the mirror filesystem, rejects source-workspace mounts and
  unknown mount/env/config options, and provides no egress, proxy, device, Docker-socket, or host
  environment path.
- Runtime output uses the existing 16 KiB bounded tail capture. The returned deterministic receipt
  records only enforcement settings, immutable image ID, mirror backend, and exit/timeout status;
  its hash excludes raw output and the command.
- Probe and runtime containers are removed and then inspected for confirmed absence. Cleanup
  uncertainty overrides the operation result and fails closed.

## Files changed

- `src/core/contained-execution/docker.ts`
- `src/core/capability/attestation.ts`
- `src/core/capability/boundary-session.ts`
- `src/core/index.ts`
- `src/__tests__/contained-execution-docker.test.ts`
- `src/__tests__/contained-execution-docker.integration.test.ts`
- `src/__tests__/contained-execution-contracts.test.ts`

## TDD evidence

Initial RED:

```text
FAIL src/__tests__/contained-execution-docker.test.ts
Cannot find module '../core/contained-execution/docker.js'
```

Subsequent focused RED cycles proved the session route initially returned the legacy
`host-integration` attestation, missing immutable-image inspect binding was accepted, UID drift and
fixed-policy drift were accepted, an injected non-image environment variable was accepted, stale
signed-envelope timestamps were accepted, a source-root mirror handle was accepted, and nested
extra config/mount options were accepted. Each was made green before continuing.

The guarded Docker integration test also failed first with:

```text
contained_execution_probe_create_failed
```

The captured daemon error identified the root cause: long `--mount` syntax treats read-write as
the default and rejects the bare `,rw` field. Removing only that invalid field made the real
create/inspect/run/remove probe pass.

## Verification

Node runtime: `v22.22.3`.

Fresh final focused verification:

```text
Test Files  15 passed (15)
Tests       183 passed (183)
```

This included contained contracts, eligibility, mirror, bounded process output, signed
attestation/session, existing boundary run/workspace/egress/grant behavior, both old container
integration suites, and the new actual-inspect integration test.

- `pnpm typecheck` — passed (`tsc --noEmit`).
- Targeted Biome check for all Task 4 implementation/test files — clean (7 files).
- `git diff --cached --check` — passed immediately before the implementation commit.

No full-suite baseline comparison was run; the task requested focused boundary, attestation,
mirror, process, typecheck, and Biome verification.

## Security rulings

- The new route does not call or extend the existing grant-materializing / egress-proxy container
  driver. With contained execution enabled, session start performs only the contained probe and
  signs a proof whose general grant booleans remain false.
- Image-defined environment variables are allowed as image content, not host grants. Probe compares
  the created container environment exactly with the inspected image environment plus eight
  explicitly empty common proxy variables (upper/lower HTTP, HTTPS, ALL, and NO proxy forms).
- `/tmp` is intentionally `noexec` in v1. The exact size/mode/flags are signed and receipted.
- Docker's long bind-mount syntax denotes the single writable mirror by omitting `readonly`; no
  additional mount option is supplied.
- The runtime does not clean the Task 3 mirror itself; Task 5 must compose it with
  `withContainedExecutionMirror` so mirror cleanup remains the outer lifecycle owner. Container
  cleanup is owned and confirmed by Task 4.
- Task 5 gate routing, audit/metrics/explain integration, and host-command denial are intentionally
  not implemented here.

## Commit

`f94e4f9` — `feat: add contained Docker execution`
