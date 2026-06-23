# Judge session transport rollout

This document describes the optional Tier1 judge session transport introduced to reduce
`spawn` latency **without reducing hook trigger counts**.

## Goals

- Keep hook evaluation frequency unchanged (Tier0/Tier1 trigger parity).
- Reuse provider CLI sessions only behind strict context guards.
- Fail closed to `spawn` on any anomaly.
- Never persist session context (prompt/response/chat id) to disk or audit logs.

## Configuration (`judge.runtime`)

| Field | Default | Notes |
|-------|---------|-------|
| `session.enabled` | `false` | Master switch; safe default |
| `session.maxTurns` | `32` | Force new session after N evaluates |
| `session.maxAgeMs` | `1800000` | Wall-clock session cap |
| `session.maxIdleMs` | `300000` | Idle cap between evaluates |
| `session.maxPromptBytes` | `65536` | Per-eval prompt budget |
| `session.providerAllowlist` | `["cursor"]` | Pilot: cursor only |
| `session.connectTimeoutMs` | `5000` | CLI `--version` fingerprint budget |
| `session.evalTimeoutMs` | `null` | Falls back to `judge.timeoutMs` |
| `session.parseTimeoutMs` | `2000` | Parse budget |
| `shadow.enabled` | `false` | Shadow compare vs spawn |
| `shadow.sampleRate` | `0.01` | Base sample rate |
| `shadow.dailyRequestCap` | `500` | Egress budget |

Example (local dogfood):

```json
{
  "judge": {
    "runtime": {
      "session": {
        "enabled": true,
        "providerAllowlist": ["cursor"]
      },
      "shadow": {
        "enabled": true,
        "sampleRate": 0.01
      }
    }
  }
}
```

## Rollout phases

1. **Phase A** — ship with `session.enabled=false` (no behavior change).
2. **Phase B** — enable cursor session locally with strict budgets.
3. **Phase C** — verify p95 improvement, fallback rate, shadow mismatch rate in CI/dogfood.
4. **Phase D** — expand `providerAllowlist` for codex/claude after matrix verification.

## Immediate rollback

```bash
belay config set judge.runtime.session.enabled false
```

Programmatic broker cleanup:

```ts
import { stopJudgeSessionBrokers } from './src/core/judge-doctor.js'
await stopJudgeSessionBrokers(repoRoot, stateDir)
```

Or run `belay doctor --fix` to stop the unix-socket broker daemon and clear the kill switch file.

## Cross-hook session reuse

When `session.enabled=true`, hooks spawn a repo-scoped **unix socket broker daemon**
(`judge-broker.sock` under the Belay state dir). Session context (prompt, response, chat id)
lives in the daemon process memory only. The daemon shuts down after `maxIdleMs` idle.

## Observability (audit fields)

- `judgeSessionUsed`, `judgeSessionReused`
- `judgeFallbackReason`, `judgeSessionResetReason`
- `judgeConnectMs`, `judgeEvalMs`, `judgeParseMs`
- `judgeSessionRefHash` (hashed session key; no raw chat id)
- `judgeShadowCompared`, `judgeShadowMismatch`, `judgeKillSwitchTriggered`

Latency bench: `belay judge bench [--json]`

## SLO reference

Baseline (spawn): Tier1 p95 ~25s (dogfood), Tier0 p95 ~60ms.

Target: Tier1 session p95 ≥40% below spawn baseline while maintaining verdict parity
via shadow sampling and automatic kill switch.

See `JUDGE_LATENCY_SLO` in `src/core/verdict/judge-runtime-config.ts`.

## Trust boundary (MUST)

- Session state lives in process memory only (repo-scoped broker map).
- No raw prompt/response/chat id in control plane or audit storage.
- Provider/model/repo/mode/cli-version mismatch forces a new session.
- Shadow uses spawn verdict as source of truth on mismatch.
