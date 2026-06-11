# agent-belay SPEC v0.3

## Summary

v0.3 hardens Belay for production use: fail-closed shell classification, a user-level control plane, richer audit redaction, and the schema foundation for additional runtime adapters.

## Config v3 schema

`belay.config.json` uses `version: 3`. v1 and v2 configs migrate automatically on load.

### Top-level fields (unchanged from v2 unless noted)

| Field | Type | Notes |
|-------|------|-------|
| `version` | `3` | Required after migration |
| `mode` | `"enforce"` \| `"audit"` | Audit records would-be denies without blocking |
| `approvalTtlMinutes` | `number` | Default `15` |
| `tokenPrefix` | `string` | Default `"/belay-approve"` |
| `gates` | object | Per-gate toggles (`shell`, `subagent`, `fileMutation`, `toolShell`) |
| `classifier` | object | `strictChains`, `sensitivePaths` only in v3 |
| `audit` | object | `logPath`, `includeAssessment` |

### New sections

#### `policy`

Runtime classification policy knobs.

```json
{
  "policy": {
    "unknownLocalEffect": "allow_flagged"
  }
}
```

| Field | Values | Default | Notes |
|-------|--------|---------|-------|
| `unknownLocalEffect` | `"allow_flagged"` \| `"deny"` | `"allow_flagged"` | Controls `unknown_local_effect` shell verdict. Switch to `"deny"` for fail-closed mode (PR after overrides ship). |

#### `overrides`

Operator escape hatches for classifier verdicts. Replaces v2 `classifier.customAllowCommands` and `classifier.customExternalCommands`.

```json
{
  "overrides": {
    "allow": ["pnpm release:staging"],
    "external": ["./scripts/release.sh"]
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `allow` | `string[]` | Exact command or segment keys treated as `allow` |
| `external` | `string[]` | Exact command or segment keys treated as external/deny |

**Precedence (T4):** `overrides.allow` > `overrides.external` > built-in classifier rules.

**Migration M1:** On v2→v3 load, `classifier.customAllowCommands` maps to `overrides.allow` and `classifier.customExternalCommands` maps to `overrides.external`. If both legacy and v3 fields are present, arrays are merged with de-duplication (v3 `overrides` wins ordering).

#### `redaction`

Controls audit log scrubbing (see `src/core/scrub.ts`).

```json
{
  "redaction": {
    "maskApprovalIds": true,
    "maskBearerTokens": true,
    "maskAuthHeaders": true,
    "maskKeyValueSecrets": true,
    "maskHighEntropyStrings": false
  }
}
```

v0.3 implements configurable scrub patterns in `src/core/scrub.ts`; gate and postToolUse audit events honor `redaction` settings.

#### `controlPlane`

User-level state directory for approvals and shared config (R6–R8).

```json
{
  "controlPlane": {
    "enabled": false,
    "configDir": null
  }
}
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `enabled` | `boolean` | `false` | When `true`, runtime reads/writes `~/.config/agent-belay/` instead of repo-local `.cursor/belay/` |
| `configDir` | `string` \| `null` | `null` | Override; default resolves via `XDG_CONFIG_HOME` or `~/.config/agent-belay` |
| `spikeOnPrompt` | `boolean` | `false` | When `true`, run OQ3 filesystem spike once per hook process on `beforeSubmitPrompt` |

When `controlPlane.enabled` is `true`, approval state lives under the resolved control-plane directory. Enabling control plane on `upgrade` copies existing repo-local approval files if the destination is empty. Disabling merges control-plane approvals back to repo-local. See `docs/spikes/oq3-control-plane.md` for hook filesystem validation.

### OQ1 dogfood workflow (v0.3.1+)

**Quick start (v0.3.2):** `agent-belay dogfood` or `agent-belay init --dogfood`.

1. Set `mode: "audit"` and `policy.unknownLocalEffect: "deny"` (done by `dogfood` command).
2. Run normal agent work; gate events record `wouldBlock: true` without creating pending approvals.
3. Run `agent-belay metrics` to review would-block rate and top reasons.
4. Tune with `overrides.allow` and `agent-belay explain`.
5. Run `agent-belay dogfood --enforce` when metrics and OQ3 spike report ready (or `--force` to override).

Closure checklist: [v0.3-remaining.md](./v0.3-remaining.md).

## Migration matrix

| From | To | Behavior |
|------|-----|----------|
| v1 | v3 | v1→v2 defaults, then v2→v3 mapping |
| v2 | v3 | `custom*` → `overrides`, add new section defaults |
| v3 | v3 | `normalizeConfig` only |

## Requirement traceability

| ID | Description | v0.3 PR |
|----|-------------|---------|
| M1 | `custom*` → `overrides` auto-mapping | done |
| R1–R4 | Fail-closed shell + chain hardening | done |
| R5 | realpath resolution | done |
| R6–R8 | Control plane move | done |
| R9 | SECURITY.md | done |
| R10 | Redaction extension | done |
| R13 | `overrides` runtime wiring | done |
| T1 | Shell classifier unit tests | done |
| T3 | Control plane e2e | done |
| T4 | Override precedence tests | done |
| OQ1 | `unknown_local_effect` deny default | `dogfood` / `metrics` CLI shipped; default unchanged until v0.4 |
| OQ3 | Hook can access `~/.config/agent-belay/` | `spikeOnPrompt` + status/doctor; manual Cursor validation per v0.3-remaining.md |

## Non-goals (v0.3)

- Second runtime adapter implementation
- LLM-based classification
- Web dashboard
