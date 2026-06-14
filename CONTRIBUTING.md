# Contributing to belay

belay is a **restorability floor** for AI coding agents: it lets an agent work freely and
only asks a human when an action is **irreversible × catastrophic**. It is *not* a denylist
or a permission fence.

Before contributing, read the two documents that govern every change:

- [docs/CONCEPT-v2.0.md](docs/CONCEPT-v2.0.md) — what belay is (the restorability floor).
- [docs/ADR-002-concept-conformance.md](docs/ADR-002-concept-conformance.md) — the rule
  every contribution must satisfy.

---

## The one rule (read this first)

> **If this action were a mistake, can it be undone?**
> Recoverable / nothing changed → **pass**. Irreversible **and** catastrophic → **ask**.
> Ambiguous → defer to Tier1 (**fail-closed = ask**).

belay's entire value is the **narrowness** of what it stops. A change is wrong if it:

- **blocks a recoverable action** (false positive → belay becomes a fence), or
- **lets an irreversible × catastrophic action through silently** (false negative → the floor has a hole).

If you cannot justify a rule with *"this stops an irreversible × catastrophic action"*, it
does not belong in belay. We **stop actions, not tools / categories / intent**: `aws s3 ls`
and a bare `curl https://example.com` must pass; `aws s3 rm` and `curl -d @.env …` must ask.

## Two invariants we never break

| Invariant | Meaning | Gate |
| --- | --- | --- |
| **FN = 0** | never miss an irreversible × catastrophic action | `MUST-ASK` structural suite |
| **FP → 0** | never block a recoverable / benign action | `MUST-ALLOW` structural suite |

Both are **hard CI gates**, and the public conformance table is executed against the real
engine (`src/__tests__/conformance/guarantee-table.test.ts`). Do **not** weaken either
invariant to make a test pass.

---

## Development

Requires Node and **pnpm** (`pnpm@10`).

```bash
pnpm install
pnpm lint        # biome
pnpm typecheck   # tsc --noEmit
pnpm test        # runs `pnpm build` first, then vitest
pnpm build       # compile + generate per-adapter runtime bundles
```

`pnpm test` runs `pnpm build` first because hook integration tests install the
esbuild-bundled runtimes from `dist/bundle/<adapter>-runtime.mjs`.

Convenience: `make verify` (lint + typecheck + test), `make verify-parallel`.
`pnpm test:stable` runs the suite 3× to catch order-dependent flakiness.

## Architecture (v2.x)

- `src/core/v2/` — the verdict engine: **Tier0** (deterministic, owns FN=0) + **Tier1**
  (local LLM for open-ended cases). This is the floor's brain.
- `src/adapters/{cursor,claude,codex}/` — per-host hook wiring over a single shared
  `gate-runtime`. Adapters are thin and carry **no** judgment logic. See
  [docs/adapter-sdk.md](docs/adapter-sdk.md).
- `skills/belay/` — the skill front-door. **Advisory only**: it routes to the CLI and never
  classifies commands itself (`init` installs the actual hooks).
- `src/conformance/guarantee-table.ts` + [docs/guarantee-table.md](docs/guarantee-table.md)
  — the public conformance contract (executed in tests).
- `scripts/build-runtime.mjs` — bundles hook runtimes into `dist/bundle/`.

When changing hook semantics, update core modules and tests first, then rebuild so the
generated `.<adapter>/belay/runtime/core.mjs` artifacts pick up the new bundle.

## Workflow: spec-first

Non-trivial changes — anything touching the verdict/gate, a new rule, or a new adapter —
**start with a short `docs/SPEC-*.md`** (or extend an existing one) that is reviewed before
code. Reason from the concept, not the symptom (ADR-002 M7): state which consequence of the
restorability rule your change follows from.

## Changing a gate rule — required checklist

Any change that makes belay **ask** or **allow** must answer:

- [ ] Does it stop a *recoverable* action? If yes, the design is wrong (fence).
- [ ] Is the stop justified by *irreversible × catastrophic* — not tool name, category, or
      the wording of a request?
- [ ] Do ambiguous cases fall to Tier1 (fail-closed = ask)?
- [ ] Did you add **both** a `MUST-ALLOW` test (it does not over-block) **and** a `MUST-ASK`
      test (it catches the catastrophe)?
- [ ] Are the FN=0 structural suite and the guarantee-table still green?

Every deterministic (Tier0) rule should carry a one-line justification and a paired
`MUST-ALLOW` counter-example (ADR-002 M2/M3).

## Adapters

Cursor and Claude Code ship as stable; **Codex is experimental** (shell gating verified;
non-shell tool mapping is best-guess — `belay doctor` surfaces the caveats). To add or
change an adapter: add a `layout`, a `runtime-entry`, register it in `registry.ts`, and
extend the conformance suite. Keep the verdict core single-sourced.

## What to update alongside a change

- `README.md` — public-facing runtime, command, or scope changes.
- `src/__tests__/` — any observable behavior change (with `MUST-ALLOW` + `MUST-ASK` cases).
- `skills/belay/SKILL.md` and `skills/belay/belay-*.md` — distributed skill/command content.
- `docs/SPEC-*.md` — when scope or design decisions change.

## Pull requests

- Branch off `main`. `pnpm typecheck` and `pnpm test` must be green.
- Concept-justify any gate change (link the SPEC/ADR consequence).
- Keep diffs focused; match the style of surrounding code (biome enforces formatting).

## Reporting issues

- **Safety issues are the highest priority**: a *missed* catastrophe (false negative) or an
  *over-block* of something recoverable (false positive). See [SECURITY.md](SECURITY.md).
  Please include the command and the verdict from `belay explain --command "<command>"`.
- Bugs and feature requests: GitHub issues on `guilz-dev/belay`.

## Releases

Releases follow [docs/semver-policy.md](docs/semver-policy.md). Before cutting a release:

1. `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` all pass (Ubuntu + macOS CI).
2. FN=0 structural suite and the guarantee-table execute-verification are green.
3. Conformance scenarios match [docs/guarantee-table.md](docs/guarantee-table.md).
4. `README.md` and the active `docs/SPEC-v2.*.md` match the release.
5. `dist/` rebuilt from current sources; `npm pack --dry-run` contents reviewed.
6. `npx skills add guilz-dev/belay --list` shows `belay` after push.

## License

By contributing you agree your contributions are licensed under the project
[LICENSE](LICENSE).
