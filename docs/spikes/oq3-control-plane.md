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

## Follow-up before R6 merge

1. Install hooks in a real Cursor workspace and trigger `beforeSubmitPrompt` with a spike hook entry.
2. Confirm no sandbox blocks writes outside the workspace (if blocked, R8 Write-tool deny + in-repo fallback required).
3. Document final path layout: `pending-approvals.json`, `approved-approvals.json`, optional shared config.

## Artifacts

- `src/core/control-plane-spike.ts`
- `src/__tests__/oq3-control-plane-spike.test.ts`
- `scripts/oq3-control-plane-spike.mjs`
