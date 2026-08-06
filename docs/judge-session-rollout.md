# Judge session transport rollout

This document describes the optional Tier1 judge session transport introduced to reduce
`spawn` latency **without reducing hook trigger counts**. Cursor uses a persistent
`cursor-agent acp` process; other providers retain their existing CLI behavior.

## Goals

- Keep hook evaluation frequency unchanged (Tier0/Tier1 trigger parity).
- Reuse provider sessions only behind strict context guards.
- Fail closed to approval on any session anomaly without adding a second slow CLI attempt.
- Never persist session context (prompt/response/chat id) to disk or audit logs.

## Configuration (`judge.runtime`)

| Field | Default | Notes |
|-------|---------|-------|
| `session.enabled` | `true` | Enabled for the Cursor allowlist; explicit `false` remains respected |
| `session.maxTurns` | `8` | Force a fresh ACP conversation after N evaluates |
| `session.maxAgeMs` | `600000` | Wall-clock session cap |
| `session.maxIdleMs` | `120000` | Idle cap between evaluates |
| `session.maxPromptBytes` | `32768` | Accumulated prompt budget per conversation |
| `session.providerAllowlist` | `["cursor"]` | Pilot: cursor only |
| `session.connectTimeoutMs` | `5000` | ACP initialization and session setup budget |
| `session.evalTimeoutMs` | `null` | Falls back to `judge.timeoutMs` |
| `session.parseTimeoutMs` | `2000` | Parse budget |
| `shadow.enabled` | `false` | Shadow compare vs spawn; keep disabled on latency-sensitive hooks |
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
        "enabled": false,
        "sampleRate": 0.01
      }
    }
  }
}
```

Shadow comparison invokes the one-shot CLI and waits for it. Enable it only during a bounded
measurement window; it is intentionally disabled for normal hook execution.

## Rollout phases

1. **Phase A** — ship the ACP path behind `session.enabled` and strict guards.
2. **Phase B** — verify Cursor in a bounded measurement window with a manual rollback switch.
3. **Phase C** — enable Cursor by default and monitor p95, fallback, and mismatch rates.
4. **Phase D** — expand `providerAllowlist` only after provider-specific verification.

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
(`judge-broker.sock` under the Belay state dir). For Cursor, the daemon owns one persistent
ACP process and reuses its conversation only within the limits above. ACP runs in a dedicated
judge workspace with MCP, client filesystem access, terminal access, and permission grants
disabled. Session context lives in process memory only. The daemon shuts down after
`maxIdleMs` idle.

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

- Session state lives in process memory only (repo-scoped broker and ACP process).
- No raw prompt/response/chat id in control plane or audit storage.
- Provider/model/repo/mode/cli-version mismatch forces a new session.
- Shadow uses spawn verdict as source of truth on mismatch.
