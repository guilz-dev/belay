# Adapter SDK (v1.0)

This document is the minimum guide to implement a **third-party belay adapter**
against the stable 1.x public API.

## Overview

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  IDE / runtime  │────▶│  Adapter hooks   │────▶│  gate-runtime   │
│  (Cursor, etc.) │     │  (thin I/O)      │     │  + core         │
└─────────────────┘     └──────────────────┘     └─────────────────┘
```

- **Core** (`src/core/`) — classification, policy, approval, config (host-agnostic).
- **Gate runtime** (`src/adapters/shared/gate-runtime.ts`) — shared hook decision path.
- **Adapter** — install layout, hook script templates, `BelayAdapter` implementation.

Existing references: `src/adapters/cursor/`, `src/adapters/claude/`.

## `BelayAdapter` interface

```typescript
interface BelayAdapter {
  name: 'cursor' | 'claude' | /* your adapter id */
  layout: AdapterLayout
  install(repoRoot: string, options: InitOptions): Promise<{ repoRoot: string; withSkill: boolean }>
  upgrade(repoRoot: string, options: UpgradeOptions): Promise<{ repoRoot: string }>
  doctor(options: DoctorOptions): Promise<DoctorReport>
  hookEvents(): Array<{ event: string; definition: ManagedHookDefinition }>
}
```

Register in `src/adapters/registry.ts`.

## `AdapterLayout`

Defines paths for a repository:

- `configPath(repoRoot)` — belay config JSON location
- `repoLocalStateDir(repoRoot)` — approvals, audit, runtime bundle
- `hooksSettingsPath(repoRoot)` — host hook manifest
- `defaultConfig(repoRoot)` — adapter-specific config defaults

See `src/adapters/layouts/types.ts`.

## Gate contract

**Version:** `GATE_CONTRACT_VERSION` (currently `1`).

Hook scripts should normalize incoming payloads to `GatedAction` and call
`evaluateGatedAction` from `gate-runtime.ts`. Response shape: `GateVerdict` with
`permission: 'allow' | 'deny'`.

Exported from `agent-belay`:

```typescript
import {
  GATE_CONTRACT_VERSION,
  type GatedAction,
  type GateVerdict,
} from 'agent-belay'
```

Breaking changes to `GatedAction` / `GateVerdict` require incrementing
`GATE_CONTRACT_VERSION` and a **major** release.

## Conformance tests

Your adapter must pass `src/__tests__/conformance/adapters.test.ts`:

1. `install` + `upgrade` produce expected files
2. Shell gate returns valid `GateVerdict`
3. Approval loop (`approved_once`) works
4. Protected paths blocked for file tools

Run:

```bash
pnpm test src/__tests__/conformance/adapters.test.ts
```

Add your adapter name to the test matrix when registering.

## Runtime bundle

Cursor/Claude ship a prebuilt ESM bundle (`dist/bundle/*-runtime.mjs`) produced by
`scripts/build-runtime.mjs`. Hook shell scripts load this bundle; keep adapter I/O
thin.

## Config

Adapters read merged **config v3** via `loadConfigFile`. Do not fork classification
logic in adapters — use `runtimeClassifierOptions` from gate-runtime.

## Checklist for a new adapter

1. Implement `AdapterLayout` + `BelayAdapter`
2. Register in `registry.ts`
3. Add hook templates (or reuse shared runners)
4. Extend conformance test matrix
5. Document install path in README
6. Run full `pnpm test`

## Stability

See [SPEC-v1.0.md](./SPEC-v1.0.md) § Adapter SDK for the stable export list.
Undocumented internals under `src/` may change in minor releases.
