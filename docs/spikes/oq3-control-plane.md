# OQ3 Spike: Control Plane Filesystem Access from Hook Context

## Question

Can `beforeSubmitPrompt` (and other Belay hooks) read and write `~/.config/agent-belay/` when invoked by Cursor?

## Method

1. Implemented `runControlPlaneSpike()` in `src/core/control-plane-spike.ts` — same Node `fs` APIs the runtime uses today.
2. Unit tests isolate `HOME` / `XDG_CONFIG_HOME` under temp dirs (no Cursor required).
3. CLI: `node scripts/oq3-control-plane-spike.mjs` after `pnpm build`.

The spike mirrors hook constraints:

- Resolves control-plane dir via `XDG_CONFIG_HOME` or `~/.config/agent-belay`
- `mkdir` recursive, `writeFile`, `readFile`, cleanup
- Records `cwd`, `HOME`, and `XDG_CONFIG_HOME` in the result

## Result (cloud-agent VM, Node 22)

Spike **passes** in standard Node subprocess context:

- `HOME` resolves correctly
- `XDG_CONFIG_HOME` override is honored when set
- Default fallback `~/.config/agent-belay` works when unset
- Read-after-write round-trip succeeds

## Implications for R6–R8

| Finding | Design impact |
|---------|---------------|
| User config dir is writable from hook Node process | Control-plane move is **feasible** without a separate daemon |
| `XDG_CONFIG_HOME` respected | Use `defaultControlPlaneDir()` everywhere; do not hardcode `~/.config` |
| Hook `cwd` is repo-local | Control-plane paths must not depend on repo `cwd` for resolution (already true in spike) |
| Cursor sandbox unknown | Re-run spike inside an actual Cursor `beforeSubmitPrompt` hook after `init` on a dogfood repo |

## Hook integration (v0.3.1)

Enable in config:

```json
{ "controlPlane": { "spikeOnPrompt": true } }
```

Or set `BELAY_OQ3_SPIKE=1` in the hook environment. The runtime runs the spike once per hook process on the first `beforeSubmitPrompt`, writes `oq3-spike-last.json` under the resolved control-plane directory, and appends a `controlPlaneSpike` audit event.

## Validation checklist

1. `agent-belay init` in a real Cursor workspace.
2. Submit any chat prompt (triggers `beforeSubmitPrompt`).
3. Verify `~/.config/agent-belay/oq3-spike-last.json` has `"ok": true`.
4. Check `.cursor/belay/audit.ndjson` for `controlPlaneSpike` events.
5. If blocked, keep control plane disabled or use repo-local fallback; R8 already denies Write/shell mutations to control-plane paths.

## Artifacts

- `src/core/control-plane-spike.ts`
- `src/__tests__/oq3-control-plane-spike.test.ts`
- `scripts/oq3-control-plane-spike.mjs`
