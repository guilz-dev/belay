# Contributing to belay

belay is a **restorability floor** for AI coding agents: it lets an agent work freely and
only asks a human when an action is **irreversible × catastrophic**. It is *not* a denylist
or a permission fence.

Before contributing, read the two documents that govern every change:

- [docs/CONCEPT.md](docs/CONCEPT.md) — what belay is (the restorability floor).
- [docs/adr/ADR-002-concept-conformance.md](docs/adr/ADR-002-concept-conformance.md) — the rule
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

## Architecture

- `src/core/verdict/` — the verdict engine: **Tier0** (deterministic, owns FN=0) + **Tier1**
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

## Workflow: design-first

Non-trivial changes — anything touching the verdict/gate, a new rule, or a new adapter —
**start with a short design note in `docs/`** (ADR, plan doc, or an extension to
[CONCEPT.md](docs/CONCEPT.md)) that is reviewed before code. Reason from the
concept, not the symptom (ADR-002 M7): state which consequence of the restorability rule
your change follows from.

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
- `docs/` — when scope or design decisions change (CONCEPT, ADR, ROADMAP, guarantee-table).

## Pull requests

- Branch off `main`. `pnpm typecheck` and `pnpm test` must be green.
- Concept-justify any gate change (link the ADR / CONCEPT consequence).
- Keep diffs focused; match the style of surrounding code (biome enforces formatting).

## Reporting issues

- **Safety issues are the highest priority**: a *missed* catastrophe (false negative) or an
  *over-block* of something recoverable (false positive). See [SECURITY.md](SECURITY.md).
  Please include the command and the verdict from `belay explain --command "<command>"`.
- Bugs and feature requests: GitHub issues on `guilz-dev/belay`.

## Releases

Release execution lives in [docs/ops/releasing.md](docs/ops/releasing.md).

Version bump policy lives in [docs/ops/semver-policy.md](docs/ops/semver-policy.md).

## License

By contributing you agree your contributions are licensed under the project
[LICENSE](LICENSE).
