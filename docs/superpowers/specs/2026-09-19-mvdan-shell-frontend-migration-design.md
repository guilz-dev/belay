# Mvdan Shell Frontend Migration Design

## Status

Approved for design documentation on 2026-09-19. This document defines the architecture and
promotion criteria only. It does not authorize implementation, dependency installation, release,
or rollout.

## Goal

Replace Belay's hand-written shell grammar frontend with a pinned `mvdan/sh`-based frontend without
changing the canonical `EffectPlan` authorization model, weakening fail-closed behavior, or
introducing a command allowlist.

The migration must first prove syntax coverage, EffectPlan compatibility, artifact integrity, and
hook latency in a non-authoritative shadow path. The `mvdan/sh` frontend becomes authoritative only
after the measured promotion gates in this document pass.

## Context

Belay currently performs shell tokenization, structural parsing, substitution discovery, and
EffectPlan lowering in TypeScript. The implementation has accumulated dedicated handling for
redirects, heredocs, recursive interpreters, shell control syntax, dynamic current-working-directory
transitions, and wrapper composition. The semantic decoders are Belay-specific and remain necessary,
but maintaining a second shell grammar creates avoidable correctness and maintenance risk.

This design follows the existing decisions:

- [ADR-004](../../adr/ADR-004-effectplan-shell-authority.md): canonical `EffectPlan` remains the sole
  shell authorization input.
- [ADR-005](../../adr/ADR-005-command-allowlist-prohibition.ja.md): executable names, command
  prefixes, fingerprints, and corpus membership cannot grant authority.
- [ADR-006](../../adr/ADR-006-contained-unknown-execution.md): effects that remain unknown after
  normalization require approval or an independently verified contained-execution route.
- [`docs/CONTEXT.md`](../../CONTEXT.md): policy precedence, runtime/config cohort identity, input
  limits, and readiness rules continue to apply.

## Non-goals

- Defining effects for `ctx` or other CLI-specific subcommands.
- Migrating the policy backend to Cedar, OPA, Jacquard, or another effect language.
- Introducing `EffectPlan` version 2.
- Permitting unknown commands because their executable, package, or ecosystem is familiar.
- Executing a shell command, performing shell expansion, or invoking an LLM to infer its effects.
- Replacing Docker, Seatbelt, Landlock, or another OS execution boundary.
- Complete support for zsh- or fish-only syntax. The production frontend targets the Bash language
  variant supported by the pinned `mvdan/sh` release.
- Rewriting every existing Git, egress, filesystem, launcher, or toolchain decoder during parser
  migration.
- Treating parser equivalence as proof of CLI semantics. Parsing `ctx status` correctly does not
  establish that the command is read-only.

## Decision summary

1. Run a disposable `sh-syntax` compatibility probe before adding production dependencies.
2. If the probe passes, build a small Belay-owned Go-to-Wasm bridge over an immutable `mvdan/sh`
   module version and ship the generated Wasm with every hook runtime.
3. Put both the legacy and mvdan implementations behind a `ShellFrontend` interface and lower both
   through the same semantic-effect layer.
4. Roll out through `legacy`, `shadow`, `canary`, and `mvdan` modes.
5. Never select the more permissive result. A canary disagreement becomes an explicit
   `indeterminate` requirement in the canonical plan.
6. Once mvdan is authoritative, parser failure never falls back to a legacy allow decision.
7. Remove the legacy grammar frontend only after at least one release of authoritative observation
   with no rollback incident.

## Alternatives considered

### Direct `sh-syntax` runtime dependency

This is the fastest way to exercise a `mvdan/sh`-derived parser from Node and is suitable for the
disposable probe. It is not selected as the production authority because it is a third-party Wasm
projection, and Belay must prove that every AST field required for security lowering is retained.
Depending directly on its public projection would also couple Belay's authority boundary to a
wrapper API it does not control.

### `tree-sitter-bash`

Tree-sitter has mature tooling and Node bindings, but its primary use case requires useful trees for
incomplete editor input. That error-recovery behavior is a liability for a fail-closed gate unless
every recovered or error node is conservatively modeled. It remains useful as a test oracle, not as
the selected authority frontend.

### OSS parser as an offline oracle only

Keeping the legacy parser authoritative while running OSS comparison solely in CI would reduce some
testing risk but would not remove the long-term grammar maintenance burden. This is the permanent
fallback if the Wasm, completeness, or latency gates fail, not the target architecture.

## Architecture

```text
                          +---------------------+
shell input ------------->| ShellFrontendRouter |
                          +----------+----------+
                                     |
                    +----------------+----------------+
                    |                                 |
                    v                                 v
          LegacyShellFrontend                MvdanShellFrontend
          current TypeScript grammar         pinned mvdan/sh Wasm worker
                    |                                 |
                    v                                 v
              ParsedShellProgram                ParsedShellProgram
                    +----------------+----------------+
                                     |
                                     v
                           SemanticEffectLowerer
                           Git/egress/fs/launcher/etc.
                                     |
                                     v
                              EffectPlan version 1
                                     |
                                     v
                                PolicyEngine
```

The parser frontend owns shell syntax only. It must not label commands as safe, dangerous,
read-only, or mutating. `SemanticEffectLowerer` owns translation from parsed commands and shell
structure to `EffectRequirement[]`. `PolicyEngine` remains the only component that turns those
requirements into `allow`, `allow_flagged`, or `ask`.

### Component boundaries

| Component | Responsibility | Must not do |
| --- | --- | --- |
| `ShellFrontendRouter` | Select the configured rollout mode and orchestrate comparison | Choose the more permissive plan |
| `LegacyShellFrontend` | Adapt the existing tokenizer/parser into the shared syntax contract | Gain new authority from corpus or command names |
| `MvdanShellFrontend` | Validate artifacts, invoke the worker, validate its response | Evaluate policy or silently discard nodes |
| Wasm worker | Parse bounded UTF-8 input using pinned `mvdan/sh` and return a bounded DTO | Read files, network, environment, or Belay state |
| `SemanticEffectLowerer` | Apply existing CLI and resource semantics to parsed structure | Parse shell text with regex fallbacks |
| comparator | Compare normalized authorization-relevant plan projections | Store raw commands or full ASTs in audit logs |

## Parser-neutral syntax contract

```ts
export interface ShellFrontend {
  readonly id: 'legacy-v1' | 'mvdan-v1'
  parse(command: string): Promise<ParsedShellProgram>
}

export interface ParsedShellProgram {
  version: 1
  sourceBytes: number
  completeness: 'complete' | 'partial'
  nodes: readonly ShellSyntaxNode[]
  diagnostics: readonly ShellParseDiagnostic[]
}

export interface ShellSourceSpan {
  startByte: number
  endByte: number
}

export interface ShellParseDiagnostic {
  code: ShellParseDiagnosticCode
  span?: ShellSourceSpan
}

export type ShellParseDiagnosticCode =
  | 'invalid_syntax'
  | 'unsupported_node'
  | 'invalid_span'
  | 'node_limit'
  | 'depth_limit'
  | 'parser_timeout'
  | 'artifact_unavailable'
  | 'artifact_mismatch'
  | 'bridge_protocol_error'
```

`ShellSyntaxNode` is a closed discriminated union containing:

- `command`: assignments, words, redirects, and source span;
- `pipeline`: ordered children, negation, and pipe operators;
- `and_or`: left/right children and `&&` or `||`;
- `sequence`: ordered foreground/background children;
- `subshell`: nested children;
- `brace_group`: nested children;
- `if`, `loop`, `case`, and `function`: control structure plus nested children;
- `command_substitution` and `process_substitution`: nested children and source span;
- `unsupported`: upstream node kind and source span, without raw source content.

Words preserve ordered literal, quoted, parameter-expansion, arithmetic-expansion, and substitution
parts. Redirects preserve file-descriptor origin, operator, target word, and heredoc metadata. The
contract does not perform shell expansion.

All bridge offsets use UTF-8 byte positions, matching the parsed input bytes. A TypeScript span
helper performs checked conversion when a JavaScript string slice is required. Any out-of-range,
non-boundary, overlapping, or parent/child-inconsistent span adds `invalid_span` and makes the
program partial.

The union is intentionally smaller than the upstream AST but is not a second parser. The bridge
must emit `unsupported` for an upstream node it cannot project; it must never omit that node.

## Production Wasm bridge

Production sources and generated artifacts use this layout:

```text
vendor/mvdan-shell-bridge/
  go.mod
  go.sum
  main.go
  LICENSES.md

dist/bundle/
  shell-parser.wasm
  shell-parser-worker.mjs
  shell-parser.manifest.json
  cursor-runtime.mjs
  claude-runtime.mjs
  codex-runtime.mjs
```

The selected `mvdan/sh` module is pinned to an immutable exact version in `go.mod` and `go.sum`.
Floating tags, `latest`, network downloads during install, and runtime downloads are forbidden.
Release CI rebuilds the bridge from the committed sources and refuses a generated hash mismatch.

The manifest contains:

```json
{
  "schemaVersion": 1,
  "frontendId": "mvdan-v1",
  "mvdanModuleVersion": "pinned-by-go.mod",
  "wasmSha256": "64-lowercase-hex",
  "workerSha256": "64-lowercase-hex",
  "bridgeSourceSha256": "64-lowercase-hex"
}
```

`pinned-by-go.mod` above describes the manifest contract: the build copies the exact normalized
module version from `go list -m`, rather than accepting a separately maintained version string.

The installer integrity manifest covers the runtime bundle, worker, Wasm, and parser manifest.
`runtimeArtifactHash` becomes a canonical aggregate hash over all enforcement artifacts rather than
the JavaScript runtime alone. Missing or mismatched parser artifacts are availability failures and
cannot produce an allow decision.

### Isolation and resource bounds

The existing `MAX_SHELL_COMMAND_BYTES` limit of 64 KiB applies before worker creation. The worker:

- receives only the command bytes and fixed parser options;
- has no application callback for filesystem, network, environment, or control-plane access;
- enforces `MAX_SHELL_AST_NODES = 10_000` and `MAX_SHELL_AST_DEPTH = 128` in the projection walk;
- returns only the bounded `ParsedShellProgram` DTO;
- is terminated after a 250 ms wall-clock parser budget;
- is terminated immediately after a protocol error or successful response.

A worker is required because synchronous Wasm evaluation cannot be safely preempted by a JavaScript
timer. The full gate must still meet p95 below 100 ms and max below 500 ms; the 250 ms timeout is a
failure ceiling, not an accepted normal latency.

## Disposable compatibility probe

The probe uses `sh-syntax` only as a disposable measurement adapter. It does not alter package
dependencies, runtime bundles, installed hooks, configuration, or authority. Prototype code is
created in an OS temporary directory outside the repository, uses an isolated package lock, and is
removed after measurement. The repository lockfile and `package.json` remain unchanged. The retained
artifact is:

```text
docs/ops/mvdan-shell-probe-result.md
```

The result records:

- exact `sh-syntax` and underlying `mvdan/sh` revisions;
- corpus, structural, adversarial, and real dogfood-derived case counts;
- parse success, partial, and failure counts by syntax feature;
- AST information required and missing for the parser-neutral contract;
- normalized EffectPlan comparison counts;
- every candidate-looser case with its disposition;
- warm and fresh-process cold latency distributions;
- Wasm load, malformed response, and missing-artifact behavior;
- package size and hook bundle impact;
- a final pass or fail against the probe exit criteria.

The probe passes only if:

1. every required syntax category can be projected without silently dropping nodes;
2. every parse or projection failure becomes partial and indeterminate;
3. unresolved candidate-looser cases equal zero;
4. no tested artifact or protocol failure produces allow;
5. full-gate warm p95 is below 100 ms and max below 500 ms;
6. fresh-process cold max is below 500 ms;
7. the generated artifact can be loaded without network access on supported platforms.

Failure stops the production migration. It does not trigger a threshold relaxation or an automatic
switch to another parser.

## Rollout modes and canonical authority

The trusted repository config gains one field:

```json
{
  "classifier": {
    "shellFrontendMode": "legacy"
  }
}
```

Allowed values and behavior are:

| Mode | Canonical plan | Secondary work | Disagreement behavior |
| --- | --- | --- | --- |
| `legacy` | legacy | none | not applicable |
| `shadow` | legacy | build and compare mvdan candidate | telemetry only |
| `canary` | mvdan candidate | build and compare legacy | add `indeterminate`; ask |
| `mvdan` | mvdan | none | not applicable |

The normalized default remains `legacy` until the probe passes and the shadow release is explicitly
prepared. `shellFrontendMode` is covered by repository config trust and
`decisionConfigFingerprint`. Every mode change starts a new decision cohort. No environment variable,
command-line override, hidden fallback, or per-command selector may change the mode.

### Shadow behavior

Shadow computation cannot modify the canonical plan, capability requests, permission, approval
state, contained-execution eligibility, or hook response. Candidate failure is audit telemetry only.
If shadow work would exceed the full-gate max latency, the comparison is abandoned and recorded as
`candidate_unavailable`; the legacy canonical decision still completes.

### Canary reconciliation

Canary starts with the mvdan plan as canonical. The legacy plan is normalized and compared. An
authorization-relevant difference appends an `indeterminate` requirement and
`parser.disagreement` signal to the mvdan plan before policy evaluation. The canary never unions
known requirements from the two plans and never chooses either plan based on which is more
permissive. This prevents the legacy parser from retaining authority while making every mismatch
explicitly fail closed.

### Authoritative behavior

In `mvdan` mode the legacy parser is not invoked. Wasm load failure, timeout, malformed bridge
response, invalid span, unsupported node, depth exhaustion, node exhaustion, or parse failure makes
the plan partial and adds an `indeterminate` requirement. None may fall back to a legacy allow
decision.

## Semantic lowering

Existing command-specific semantic decoders remain Belay-owned. Parser migration supplies them with
structured commands, words, redirects, substitutions, and nesting instead of asking them to infer
shell structure from flat tokens.

The first migration preserves the behavior of existing decoders unless the differential suite
proves that legacy behavior lost or mis-associated a shell node. Decoder fixes discovered during
migration are separate, named changes with their own corpus cases. This prevents syntax replacement
from becoming an unreviewable policy rewrite.

The lowering rules remain monotonic:

- effects found in nested commands are retained by their parent composition;
- adding an unsupported or dynamic construct cannot remove an existing requirement;
- redirects and heredocs contribute effects independently of command-head semantics;
- unknown CLI semantics remain `indeterminate` even when shell syntax is complete;
- executable and corpus identity never grant permission.

## Differential comparison

Plans are compared only after canonical normalization. The authorization-relevant projection is:

```text
requirements[]:
  tag
  action
  resource
  evidence.level
  provenance.segment/launcher/phase

plan:
  completeness
  opacity
  disposition
  policy projection
```

Array ordering, internal node identifiers, diagnostic prose, and other fields that cannot change
authorization are excluded.

Comparison classes are closed and stable:

- `equal`;
- `candidate_stricter`;
- `candidate_looser`;
- `structural_difference`;
- `candidate_unavailable`.

Classification uses the normalized requirement multiset and policy strictness rank
`allow < allow_flagged < ask`:

- `equal`: both the requirement multiset and policy projection are equal;
- `candidate_looser`: a legacy requirement has no equal-or-stronger candidate requirement, candidate
  evidence is weaker, or the candidate policy rank is lower;
- `candidate_stricter`: the inverse holds and no legacy requirement is weakened;
- `structural_difference`: both sides add or remove incomparable requirements, or resource/provenance
  differs without a strict ordering;
- `candidate_unavailable`: no validated candidate plan exists.

`candidate_looser` means the candidate removes or weakens a requirement or produces a less strict
policy projection. It blocks promotion until the lowering difference is fixed or a reviewed corpus
case proves the candidate restored the intended ADR-004 semantics. Review never creates a
command-specific runtime exception.

## Failure behavior

| Failure | Shadow | Canary / mvdan |
| --- | --- | --- |
| Wasm missing or hash mismatch | record unavailable; legacy remains canonical | partial + indeterminate; ask |
| Worker start failure | record unavailable; legacy remains canonical | partial + indeterminate; ask |
| 250 ms timeout | terminate and record unavailable | terminate; partial + indeterminate; ask |
| Parse error | record candidate partial | partial + indeterminate; ask |
| Unknown upstream AST node | emit `unsupported` and candidate partial | partial + indeterminate; ask |
| Invalid source span | candidate partial | partial + indeterminate; ask |
| Frontend disagreement | record comparison only | add parser disagreement indeterminate; ask |
| Audit write failure | retain existing audit failure policy | retain existing audit failure policy |

No failure path grants a parser capability, mints an approval, consumes a grant, or executes the
command.

## Audit and privacy

Parser comparison telemetry adds only:

```text
frontendId
frontendArtifactHash
parseCompleteness
diagnosticCodes[]
legacyEffectPlanHash
candidateEffectPlanHash
comparisonClass
parseDurationMs
```

The audit event must not add the full AST, raw command, raw word values, source slices, environment
values, or parser exception text. Existing scrub and size limits still apply. Diagnostic codes are a
closed enum; upstream error messages are mapped locally and discarded.

## Promotion gates

### Probe to shadow

- Probe exit criteria all pass.
- Wasm and worker build reproducibly in release CI.
- Installer and doctor verify every new artifact.
- Structural tests prove that shadow results cannot reach the canonical decision.

### Shadow to canary

- Unresolved `candidate_looser` count is zero.
- `candidate_unavailable` count is zero after the recorded warm-up period in the observed shadow
  cohort.
- Every comparison difference is reviewed and classified.
- Corpus and adversarial hard gates pass.
- Full gate p95 is below 100 ms and max below 500 ms.
- Missing, corrupt, timeout, protocol-error, and unsupported-node tests all fail closed.

### Canary to mvdan

- At least 150 reviewed provably benign events exist in the active canary cohort.
- Those events span at least three valid session correlations.
- Benign block rate is below 2%.
- Availability asks equal zero.
- Unsafe allows equal zero.
- All adapters produce the same canonical EffectPlan for the cross-adapter suite.

### Mvdan to legacy cleanup

- At least one released version has run with `mvdan` authority.
- No incident required parser rollback.
- No unresolved parser availability or candidate-looser finding remains.
- The immediately previous release and documented local downgrade procedure remain available.

Promotion is manual and release-scoped. Meeting a threshold does not mutate configuration or publish
a release automatically.

## Rollback

Through canary, rollback means changing trusted repository config from `canary` to `legacy`, which
starts a new cohort. The same installed release retains both frontends.

After legacy cleanup, rollback requires installing the immediately previous release. The cleanup
release must not claim an in-place `legacy` mode it no longer ships. Historical audit and approval
records remain readable, but exact approval replay continues to require the current normalized
request and EffectPlan hashes.

## Verification strategy

### Parser contract tests

- Quotes, escapes, assignments, and Unicode byte spans.
- File-descriptor redirects, heredocs, and here strings.
- Pipelines, and/or lists, foreground/background sequences.
- Subshells, brace groups, functions, conditionals, loops, and case statements.
- Command, process, parameter, and arithmetic substitutions.
- Truncated, malformed, deeply nested, and node-heavy inputs.
- Every upstream node kind maps to a known union member or `unsupported`.

### EffectPlan differential tests

- Run the complete shell corpus through both frontends.
- Run existing structural, substitution, recursive-wrapper, and shell-lowering fixtures.
- Add adversarial mutations around quoting, nesting, redirect placement, and wrappers.
- Compare normalized requirement sets, completeness, opacity, and policy projections.
- Require a reviewed disposition for every non-equal result.

### Safety properties

- A projected node cannot disappear without `unsupported` and partial completeness.
- Adding a shell construct cannot remove a previously discovered dangerous effect.
- Nested commands retain their effects through wrappers, substitutions, and pipelines.
- Parser failure, timeout, or artifact failure cannot transition an ask to allow.
- One-shot approval and resource-grant hash binding remains unchanged.
- Command name, corpus membership, or comparison history cannot change permission.

### Runtime and packaging tests

- Node 22 on macOS arm64, macOS x64, and Linux x64.
- Fresh-process cold and same-process warm latency.
- Offline hook startup and parser load.
- Package install, upgrade, doctor, and integrity-manifest verification.
- Missing, modified, truncated, and wrong-version Wasm/worker artifacts.
- Cursor, Claude, and Codex adapter conformance.
- Audit serialization proves raw AST and raw parser diagnostics are absent.

## Expected implementation boundaries

The future implementation is expected to create focused modules under
`src/core/shell-frontend/` for the shared contract, router, legacy adapter, mvdan worker client,
comparison, and span validation. The Wasm bridge lives under `vendor/mvdan-shell-bridge/`. Existing
semantic decoders remain under `src/core/effect-ir/shell-lower/` and are migrated to structured
inputs incrementally.

Likely integration points include:

- `src/core/effect-ir/shell-lower.ts` and its decoder modules;
- `src/core/config/types.ts`, defaults, normalization, and decision fingerprinting;
- `scripts/build-runtime.mjs`, installer templates, integrity manifests, and doctor;
- audit DTO and serialization modules;
- shell corpus, structural suites, latency budgets, and adapter conformance tests.

This section describes ownership, not an implementation task list. A separate implementation plan
requires explicit user approval and is outside the current design-only scope.

## Consequences

### Benefits

- Shell grammar maintenance moves to a mature parser with upstream fuzz coverage.
- Belay retains its resource-scoped effect and approval semantics.
- Parser changes become measurable before they receive authority.
- Unsupported syntax has one explicit, testable fail-closed representation.
- Runtime artifacts and audit cohorts identify the exact parser authority in use.

### Costs

- The release build gains a Go/Wasm toolchain and license/reproducibility obligations.
- Hook packages grow by the Wasm and worker artifacts.
- Worker startup may consume much of the synchronous gate latency budget.
- Both frontends exist during migration, increasing temporary code and test volume.
- A parser frontend still cannot infer arbitrary CLI semantics; semantic decoders and containment
  remain necessary.

## Final boundary

The migration is successful when Belay no longer maintains a general-purpose shell grammar, while
`EffectPlan` remains canonical, CLI semantics remain explicit, unknowns remain visible, and no
parser or migration failure can turn an approval-worthy operation into an allow decision.
