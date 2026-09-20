# Effect Manifest Design

## Status

Approved on 2026-09-19 and implemented for the legacy frontend in PR #144. This document defines
the architecture and security contract. Mvdan authority remains fail-closed until its separately
pinned parser artifact is shipped; shadow mode must not relabel legacy output as an mvdan result.

## Goal

Allow an operator to describe the effects of a currently unknown executable without adding a
command allowlist or a new policy authority. Belay must provide a CLI that creates a repository-
local candidate manifest for an exact command invocation, lets the operator review and trust rules
individually, and uses only trusted matching rules to lower the unknown process into canonical
`EffectRequirement` values.

The first target is an invocation such as `ctx status`: after its exact rule and executable identity
are trusted, Belay can classify its declared effects. Other `ctx` invocations, modified rules, and a
different `ctx` binary remain indeterminate and therefore require approval.

## Context and invariants

This design extends the semantic decoder layer. It does not replace the shell frontend, Effect IR,
or PolicyEngine.

- [ADR-004](../../adr/ADR-004-effectplan-shell-authority.md): canonical `EffectPlan` remains the
  sole shell authorization input.
- [ADR-005](../../adr/ADR-005-command-allowlist-prohibition.md): executable names, command prefixes,
  command-text fingerprints, and corpus membership cannot grant runtime authority.
- [ADR-006](../../adr/ADR-006-contained-unknown-execution.md): effects that remain indeterminate may
  still require one-shot approval or independently verified contained execution.
- [ADR-010](../../adr/ADR-010-repository-config-trust.md): repository-controlled files do not gain
  policy authority merely by existing or being edited.
- [Mvdan Shell Frontend Migration Design](./2026-09-19-mvdan-shell-frontend-migration-design.md):
  every configured shell frontend lowers through the same semantic-effect layer, and frontend
  plans are normalized and compared before policy evaluation.
- [`docs/CONTEXT.md`](../../CONTEXT.md): synchronous gate evaluation stays deterministic and performs
  no network I/O, LLM request, or target process spawn.

A trusted effect-manifest rule is an operator assertion that its declared effect set is a complete
upper bound for one executable identity and one argv language. It is stronger than a one-shot
approval and must be presented as such. It still does not authorize those effects: PolicyEngine
may allow, flag, require approval, or deny them according to their actions and resources.

## Non-goals

- Adding an `allow`, `deny`, `safe`, or risk-disposition field to a manifest.
- Trusting an executable name, package name, command prefix, help text, corpus label, or model output.
- Running the target command, including with `--help`, while generating a candidate.
- Calling an LLM or performing network I/O on the hook decision path.
- Replacing built-in semantic decoders or weakening an incomplete built-in decoder.
- Inferring shell effects from raw command text when shell parsing or expansion is incomplete.
- User-global manifests, dynamic sandbox inference, arbitrary regular expressions, repeated or
  optional argv patterns, trust expiry, or policy-backend migration in version 1.
- Sharing manifests or trust automatically between separate checkout roots or repositories.

## Decision summary

1. Store one repository-local manifest per executable at `.belay/manifests/<basename>.json`.
2. Generate exact-argv candidate rules with `belay manifest infer -- <command> [args...]` without
   invoking the target.
3. Keep candidate files non-authoritative until a human trusts an individual rule.
4. Bind trust to the canonical checkout root, manifest schema, executable identity, fallback,
   matcher, and effect contract.
5. Within each frontend's semantic lowering, consult manifests only for the built-in decoder's exact
   `process.grammar_unknown` unsupported-process result: the `process.exec` spawn plus
   `indeterminate` pair bearing only that signal.
6. Resolve manifests independently for every complete frontend result, before EffectPlan
   normalization, differential comparison, and canonical-plan selection.
7. Replace only that specific unsupported-process result. Preserve all shell-, redirect-,
   substitution-, pipeline-, and sibling-command effects already present in the plan.
8. Keep shadow results observational, compare manifest-resolved plans in canary, and never let a
   manifest remove parser-, comparator-, or partial-analysis uncertainty.
9. Route the resulting requirements through the existing PolicyEngine. A manifest cannot return an
   allow decision.
10. Treat every missing, malformed, stale, ambiguous, unmatched, or untrusted case as the original
   indeterminate effect.

## Alternatives considered

### Exact command approvals

One-shot approval already handles a single blocked invocation safely. It does not teach EffectPlan
what the command does, so the same benign invocation asks again after the approval is consumed. It
remains the correct mechanism when the operator cannot assert a reusable complete effect contract.

### Built-in decoder for every executable

Built-in TypeScript decoders provide the strongest reviewed semantics and remain preferred for
widely used tools. Requiring a Belay release for every local or niche CLI does not scale. Effect
manifests provide the same kind of structured lowering at a narrower, explicitly trusted boundary.

### Command-wide generated rules

Trusting a generated description for an entire executable would be convenient but would recreate a
command allowlist in semantic clothing. Version 1 therefore starts with exact argv and permits only
bounded, typed captures that participate in effect-resource construction.

### Dynamic contained inference

Observing one run inside a sandbox cannot prove that all future runs have the same effects, and the
current contained-execution route intentionally discards changes and blocks host replay. Dynamic
inference may provide evidence in a later design, but it cannot establish completeness by itself.

## Architecture

```text
explicit CLI invocation
        |
        v
CandidateInferencer -- static evidence / optional explicit LLM use
        |
        v
.belay/manifests/<basename>.json             control-plane trust record
        |                                                  |
        +--------------------+-----------------------------+
                             v
                    TrustedManifestLoader
                             |
                             | verified manifest and trust
                             |
shell input --> ShellFrontendRouter                        |
                    |                                      |
          +---------+---------+                            |
          |                   |                            |
          v                   v                            |
 LegacyShellFrontend   MvdanShellFrontend                  |
          |                   |                            |
          v                   v                            |
 ParsedShellProgram    ParsedShellProgram                  |
          |                   |                            |
          +---- per-frontend semantic lowering ----+       |
                                                   |       |
                                                   v       |
                                      built-in semantic decoder
                                                   |
                                      process.grammar_unknown?
                                                   |
                                                   v
                                         ManifestRuleMatcher <----+
                                                   |
                                      trusted exact match / no match
                                                   |
                                                   v
                                        frontend EffectPlan v1
                                                   |
                                  normalize / compare / select by mode
                                                   |
                                                   v
                              canonical EffectPlan (+ disagreement marker)
                                                   |
                                                   v
                                              PolicyEngine
```

### Component boundaries

| Component | Responsibility | Must not do |
| --- | --- | --- |
| `CandidateInferencer` | Resolve the executable, collect bounded static evidence, and write a candidate rule | Execute the target, create trust, or decide policy |
| `EffectManifestCodec` | Parse, validate, canonicalize, and fingerprint schema v1 | Accept unknown fields or silently repair malformed authority data |
| `EffectManifestTrustStore` | Atomically maintain rule trust outside the repository | Trust a whole command name or accept a changed rule |
| `TrustedManifestLoader` | Verify repository, file, executable, and rule identity within gate limits | Perform network I/O, invoke an LLM, or use untrusted candidates |
| `ManifestRuleMatcher` | Match a complete structured argv vector inside each frontend's semantic lowering and instantiate fixed effect templates | Parse shell text, use regex, select a permissive overlap, or run after frontend-plan comparison |
| built-in decoder integration | Offer only the exact two-requirement `process.grammar_unknown` unsupported-process result from that frontend lowering to manifest matching | Override known, grammar-incomplete, parser-incomplete, or comparator-derived semantics |
| `ShellFrontendRouter` / comparator | Compare normalized, manifest-resolved frontend plans and apply the configured authority mode | Let a shadow candidate affect authority or let a manifest remove `parser.disagreement` |
| `PolicyEngine` | Evaluate every resulting requirement and select the strictest disposition | Special-case a manifested command as allowed |

### Shell frontend rollout integration

Manifest resolution is part of the shared `SemanticEffectLowerer`, not a post-comparison rewrite of
the selected EffectPlan. Each available frontend result is lowered independently. Only a frontend
program marked complete whose command node has a stable executable token and complete structured
argv may reach the built-in decoder and then the manifest fallback. A partial program, unsupported
syntax node, invalid span, artifact failure, dynamic executable, or incomplete expansion bypasses
manifests and keeps its indeterminate requirements.

| Mode | Manifest work | Authority rule |
| --- | --- | --- |
| `legacy` | Resolve only while lowering the legacy program | The manifest-resolved legacy plan is canonical |
| `shadow` | Resolve independently in legacy and mvdan lowering when the candidate is available | Legacy remains canonical; candidate matches and failures are telemetry only |
| `canary` | Resolve independently in mvdan and legacy lowering | Compare the normalized manifest-resolved plans; any difference appends `parser.disagreement` and `indeterminate` to the mvdan plan |
| `mvdan` | Resolve only while lowering the mvdan program | The manifest-resolved mvdan plan is canonical; frontend failure remains partial and indeterminate |

The comparator observes the same authorization semantics that PolicyEngine would receive from each
frontend. Manifest matching can replace only the exact generic unsupported-process result produced
inside that frontend's semantic lowering. It cannot replace an `indeterminate` requirement produced
by the parser, plan completeness, artifact availability, differential comparator, redirect,
substitution, wrapper, or any command-specific incomplete grammar. In particular, a trusted rule can
never remove `parser.disagreement` after canary reconciliation.

## Repository-local manifest

### Location and naming

Version 1 uses:

```text
<canonical-checkout-root>/.belay/manifests/<normalized-basename>.json
```

`.belay/` is already repository-local runtime state and is ignored by this repository. Version 1
therefore treats manifests as per-checkout operator state, not automatically shared project policy.
The basename is only a lookup key; it has no authority. The canonical executable path and content
identity inside the document and trust record are authoritative. A repository may have only one
manifest for a given normalized basename in version 1.

The manifests directory uses mode `0o700` and candidate files use mode `0o600`. A later design may
add an explicitly shareable project format; version 1 does not infer trust from Git history,
ownership, or file mode.

The normalized basename must be a portable filename composed from ASCII letters, digits, `.`, `_`,
and `-`. Commands whose basename cannot be represented unambiguously are ineligible in version 1.
Manifest lookup never follows a path supplied by the command or a manifest field.

### Schema v1

```ts
interface EffectManifestV1 {
  schemaVersion: 1
  command: {
    basename: string
    canonicalPath: string
    sha256: string
    kind: 'native' | 'script'
    interpreter?: {
      canonicalPath: string
      sha256: string
    }
  }
  fallback: 'indeterminate'
  rules: EffectManifestRuleV1[]
}

interface EffectManifestRuleV1 {
  id: string
  matcher: {
    argv: ArgvMatcherV1[]
  }
  contract: {
    processOperation: 'inspect' | 'spawn' | 'signal'
    effects: ManifestEffectTemplateV1[]
  }
  assertion: 'complete-upper-bound'
  inference: {
    method: 'static' | 'llm-assisted' | 'manual'
    generatedAt: string
    generatorVersion: string
    model?: string
    evidence: ManifestEvidenceReferenceV1[]
    warnings: string[]
  }
}
```

The executable token is excluded from `matcher.argv`; the matcher applies to the final structured
argv after supported transparent wrappers are lowered. JSON parsing rejects duplicate keys,
unknown fields, non-NFC strings, invalid UTF-8, non-finite values, and documents outside bounded
size, depth, rule-count, and argv-count limits.

`fallback` is required and has the single value `indeterminate`. This makes failure behavior
explicit and prevents a future parser default from becoming an implicit allow path.

An abbreviated candidate for `ctx status` looks like this; it illustrates the format and does not
claim that the real command is effect-free beyond process inspection:

```json
{
  "schemaVersion": 1,
  "command": {
    "basename": "ctx",
    "canonicalPath": "/usr/local/bin/ctx",
    "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "kind": "native"
  },
  "fallback": "indeterminate",
  "rules": [
    {
      "id": "argv-92a1c4e09b35",
      "matcher": {
        "argv": [{ "kind": "literal", "value": "status" }]
      },
      "contract": {
        "processOperation": "inspect",
        "effects": []
      },
      "assertion": "complete-upper-bound",
      "inference": {
        "method": "manual",
        "generatedAt": "2026-09-19T00:00:00.000Z",
        "generatorVersion": "0.0.0-design-example",
        "evidence": [],
        "warnings": ["Verify the implementation before trusting this complete upper bound."]
      }
    }
  ]
}
```

### Executable identity

`infer` resolves the target using the effective PATH without spawning a process, canonicalizes
symlinks, verifies a regular file, and hashes the opened file with SHA-256. The implementation must
verify file identity before and after reading so a changed file cannot be trusted under the previous
hash.

For a script with a supported absolute or `/usr/bin/env <name>` shebang, version 1 also resolves and
hashes the interpreter. Unsupported, dynamic, or ambiguous shebangs can produce a candidate but are
ineligible for trust. A gate-time mismatch in the command or interpreter path/hash makes every rule
in that manifest unavailable. File version strings are diagnostic only and never establish identity.

Shell builtins, functions, aliases, non-regular files, and dynamically resolved executable tokens
are not eligible for effect manifests.

## Argv matcher language

Version 1 is deliberately non-regex and exact-length. A matcher element is one of:

```ts
type ArgvMatcherV1 =
  | { kind: 'literal'; value: string }
  | { kind: 'enum'; name: string; values: string[] }
  | { kind: 'path'; name: string }
  | { kind: 'host'; name: string }
  | { kind: 'integer'; name: string; min?: number; max?: number }
  | { kind: 'token'; name: string }
```

Matching is case-sensitive, ordered, and against the complete argv vector. There are no optional,
repeated, prefix, suffix, glob, or arbitrary-regex forms. `--flag=value` and `--flag value` are
different token sequences unless separate rules declare both.

Every non-literal capture must be referenced by at least one effect resource template. A `token`
capture is allowed only after at least one literal argv element and cannot occupy the subcommand
position. This prevents a rule equivalent to “all invocations of this executable.” Captures may
instantiate resource values, but they cannot choose an action, effect tag, process operation, or
evidence level.

The validator rejects rules whose matcher languages overlap. Runtime never selects by order or
specificity. An overlap introduced by a manual edit makes the complete manifest non-authoritative
until corrected and re-trusted.

Candidate generation emits literal-only matchers. Typed captures are an explicit later edit and
therefore change the rule fingerprint and invalidate that rule's trust.

## Effect contract

`processOperation` always produces the canonical `process.exec` requirement for the bound
executable. `effects` is a closed list of templates for existing EffectPlan v1 actions and resource
kinds:

- `fs.read`, `fs.write`, and `secret.read` with a literal or captured path;
- `network.connect` with a literal or captured host and fixed protocol, mode, and payload class;
- `git.ref.write` with a literal or captured ref and fixed local/remote scope;
- `control_plane.write` with a literal path resource;
- `process.exec` for a statically declared nested executable;
- `indeterminate` with an unknown resource for an incomplete candidate.

Resource templates can interpolate one validated capture into the corresponding typed field. Path
captures are resolved against the action working directory and pass through the existing repository,
outside-workspace, secret-path, and high-stakes classification. A manifest cannot label a path as
workspace-local or harmless; the existing normalizer derives that property.

`trust` refuses a rule containing `indeterminate`, an unresolved resource, an unsupported template,
or an unused capture. Once trusted, the operator assertion supplies `certain` evidence with basis
`effect_manifest.trusted_complete_upper_bound`. Generation method, model confidence, help text, and
documentation are provenance only; they never become gate evidence by themselves.

Potentially dangerous contracts are valid. For example, a rule declaring a payload-bearing network
mutation still reaches PolicyEngine and requires approval. This is the central distinction from a
command allowlist.

## Candidate inference

### CLI contract

```text
belay manifest infer [--llm] -- <command> [args...]
```

`--` is mandatory so Belay options cannot be confused with target argv. The command resolves
relative to the supplied or current action working directory. Generation is explicit and offline by
default.

The inferencer may collect only bounded static sources:

- the current shell frontend and EffectPlan result;
- canonical executable and interpreter metadata and hashes;
- a bounded textual script body when the executable is a script;
- installed man-page, shell-completion, and package metadata found without invoking the target;
- optional user-supplied context in a later backward-compatible CLI extension.

It must not execute the target, load its plugins, source its shell completion dynamically, perform
shell expansion, or inspect unrelated repository files.

Without `--llm`, the inferencer writes an exact matcher and either a statically supported contract or
an `indeterminate` contract requiring manual completion. With `--llm`, it may use an already
configured provider only for this explicit CLI operation. The request uses existing secret
scrubbing, bounded inputs, and an output JSON schema. No provider configuration or network access is
created implicitly. The transport must be text-only: configured HTTP endpoints are supported, while
native agent CLIs are rejected because they cannot enforce the inferencer's static-source boundary.

Model output is always a candidate. The decoder rejects invented actions, resource kinds, matcher
forms, or unknown fields. A model cannot set `assertion`, create trust, or upgrade evidence to
`certain`.

### Existing files

If no manifest exists, `infer` creates it atomically. If it exists, `infer` appends a new candidate
with a deterministic ID derived from its literal argv hash. It refuses to replace an existing
matcher by default. A future explicit replacement option may replace an untrusted candidate, but no
generation command may overwrite a trusted rule in version 1.

If the existing file binds the basename to a different canonical executable or interpreter
identity, `infer` refuses to append. The operator must revoke the old rules and remove or archive the
old candidate explicitly before generating a manifest for the new identity.

## Trust model and lifecycle

### Trust record

Trust is stored outside the repository in the default control-plane directory:

```text
<defaultControlPlaneDir>/effect-manifest-trust/
  <sha256(canonicalCheckoutRoot + "\0" + canonicalExecutablePath)>.json
```

```ts
interface EffectManifestTrustRecordV1 {
  schemaVersion: 1
  repoRoot: string
  manifestPath: string
  commandIdentityFingerprint: string
  trustedRules: Array<{
    id: string
    ruleFingerprint: string
    trustedAt: string
  }>
}
```

The record is host-adapter-neutral because Cursor, Claude, and Codex lower through the same canonical
EffectPlan and PolicyEngine. Trust is also shared across shell frontends within the same canonical
checkout and executable identity; frontend role affects lowering and audit attribution, not the rule
fingerprint. Parent directories use mode `0o700`; records use `0o600`; writes are atomic.

`ruleFingerprint` is SHA-256 over a domain-separated canonical encoding of schema version, command
identity, mandatory fallback, rule ID, matcher, contract, and assertion. Inference timestamps,
generator version, model name, evidence references, and warnings are excluded because they are audit
provenance, not authorization semantics. Editing semantic fields invalidates only that rule. Changing
the executable or interpreter identity invalidates every rule for the executable.

### Commands

Version 1 exposes:

```text
belay manifest infer [--llm] -- <command> [args...]
belay manifest list [--json]
belay manifest show <command> [--json]
belay manifest validate <command> [--json]
belay manifest trust <command> --rule <id> [--json]
belay manifest revoke <command> --rule <id> [--json]
```

`validate` reports schema, executable identity, matcher overlap, resource-template validity, and
trust eligibility without changing authority. `trust` prints the canonical matcher and complete
effect contract and explicitly states that the operator is asserting a reusable complete upper
bound, not approving one execution. `revoke` atomically removes only the selected rule trust.

An agent-shell invocation of `trust` or `revoke` is a `control_plane.write` and requires separate
human approval, following ADR-010. `infer`, `list`, `show`, and `validate` cannot change runtime
authority; normal filesystem policy still applies to their writes and reads.

Version 1 has no trust expiry. Rule or executable changes provide deterministic invalidation.

## Runtime data flow

1. `ShellFrontendRouter` selects the frontend programs required by `legacy`, `shadow`, `canary`, or
   `mvdan` mode.
2. Each available frontend program enters the shared semantic lowerer independently. Dynamic or
   incomplete shell structure bypasses manifests and remains indeterminate in that frontend plan.
3. Redirect, substitution, pipe, cwd-change, wrapper, and sibling-segment requirements are derived
   and retained for that frontend plan.
4. The built-in semantic decoder runs first for each complete command node.
5. If it recognizes the command, its result is final for that segment. A manifest is not consulted,
   including when the built-in decoder returns a command-specific `*_grammar_incomplete` signal.
6. After supported transparent wrappers are lowered, only the exact generic
   `process.grammar_unknown` unsupported-process result—the `process.exec` spawn plus
   `indeterminate` pair bearing only that signal—is eligible for manifest resolution.
7. The loader resolves and verifies executable identity, manifest schema, rule trust, and matcher
   uniqueness under existing synchronous gate limits. A trusted match replaces only that generic
   result with its instantiated requirements.
8. Each frontend plan is completed and canonically normalized before differential comparison.
9. `legacy` and `mvdan` use their sole canonical plan. `shadow` keeps the legacy plan authoritative
   and records candidate results only as telemetry. `canary` compares the two manifest-resolved plans
   and appends `parser.disagreement` plus `indeterminate` to the mvdan plan on any authorization-
   relevant difference.
10. PolicyEngine evaluates only the resulting canonical plan and applies the strictest disposition.

If no rule matches, the original two-requirement `process.grammar_unknown` result remains. There is
no negative cache or basename-based fallback that can change this result.

When a later Belay release adds a built-in decoder for the executable, that decoder automatically
takes precedence. The dormant manifest remains inspectable and revocable but does not weaken the
built-in result.

## Failure handling

The following conditions leave the original indeterminate requirement in place:

- absent manifest or trust record;
- malformed, oversized, or unsupported schema;
- unsafe filename or path traversal attempt;
- non-regular executable or unresolved/dynamic command;
- command or interpreter path/hash mismatch;
- changed file during identity verification;
- rule fingerprint mismatch;
- no matcher, multiple matchers, or statically overlapping matchers;
- capture parse or resource substitution failure;
- gate-time I/O error or existing latency-budget exhaustion.

Failures never fall back to a candidate, stale trust, basename match, model confidence, built-in
allow, or direct allow decision. `doctor` reports malformed/stale manifests and trust records, while
an ordinary absent manifest is not a health error.

## Audit, explain, and cohort identity

When a rule is considered, audit and explain output may include one bounded object per frontend
consideration:

```ts
interface EffectManifestAuditV1 {
  frontendId: 'legacy-v1' | 'mvdan-v1'
  role: 'canonical' | 'candidate'
  commandBasename: string
  manifestFingerprint: string
  ruleId?: string
  ruleFingerprint?: string
  trust: 'trusted' | 'missing' | 'stale' | 'invalid'
  outcome: 'matched' | 'unmatched' | 'unavailable'
  reason: string
}
```

Candidate entries in `shadow` and the legacy comparison entry in `canary` are observational. They
cannot change the canonical plan, permission, approval state, contained-execution eligibility, trust
state, or hook response. Canary's mvdan entry remains `canonical` even when reconciliation appends a
parser-disagreement requirement afterward.

Raw manifest contents, unredacted argv, documentation excerpts, script bodies, model prompts, and
model responses are not written to gate audit records. Inference provenance remains in the local
candidate file and explicit CLI output.

The sorted set of active trusted semantic rule fingerprints is authorization-relevant input. Its
aggregate hash is incorporated into `decisionConfigFingerprint` alongside the configured
`shellFrontendMode`; adding, changing, trusting, or revoking a rule or changing frontend mode starts
a new dogfood decision cohort. Candidate match outcomes and untrusted candidate edits do not change
the cohort.

## Security properties

This design is not a command allowlist because:

1. executable identity and argv select an effect contract, never a disposition;
2. PolicyEngine still evaluates every resulting action and resource;
3. unmatched argv is explicitly indeterminate;
4. built-in and shell-derived effects cannot be removed or weakened;
5. repository file edits alone cannot create authority;
6. a dangerous declared effect still requires approval;
7. rule and executable changes invalidate trust.

The principal residual risk is an incorrect human completeness assertion. Static analysis and an
LLM can help draft a contract but cannot prove arbitrary CLI behavior. The CLI must therefore show
the exact reusable scope and effects at trust time. Operators who cannot make that assertion should
keep the rule indeterminate and use one-shot approval or contained execution instead.

## Testing and acceptance criteria

### Schema and matching

- Parse and canonicalize valid schema v1 documents deterministically.
- Reject unknown fields, duplicate JSON keys, oversized inputs, invalid hashes, unsafe names, and
  unsupported schema versions.
- Prove exact-length, case-sensitive argv matching for literals and every capture type.
- Reject unused captures, broad leading token captures, optional/repeated behavior, and overlapping
  rule languages.
- Resolve captured paths through existing workspace, outside-path, secret, and high-stakes logic.

### Identity and trust

- Bind a rule to canonical checkout root, executable path/hash, interpreter path/hash when present,
  fallback, matcher, and contract.
- Show that editing one rule invalidates only that rule.
- Show that executable or interpreter replacement invalidates every rule.
- Show that trust in repository A or checkout A does not affect repository B or checkout B.
- Show that candidate generation and manual repository-file edits cannot create authority.
- Classify agent-shell `trust` and `revoke` as approval-worthy control-plane writes.

### EffectPlan integration

- A trusted exact `ctx status` rule replaces only the exact generic `process.grammar_unknown`
  unsupported-process pair and produces the declared canonical requirements.
- `ctx`, `ctx other`, additional argv, and changed casing remain indeterminate unless separately
  trusted.
- Redirect, pipeline, substitution, wrapper, and sibling-segment effects survive manifest lowering.
- A known built-in decoder always wins; a manifest cannot weaken Git, GitHub CLI, filesystem, Docker,
  Belay, or other recognized grammar.
- A command-specific built-in grammar-incomplete result remains indeterminate even if a manifest
  would otherwise match.
- `legacy`, `shadow`, `canary`, and `mvdan` apply manifest resolution inside each available
  frontend's semantic lowering before plan normalization and comparison.
- A shadow candidate manifest match cannot change the canonical plan, permission, approval state,
  contained-execution eligibility, trust state, or hook response.
- Canary compares manifest-resolved frontend plans. A rule that matches only one frontend produces
  an authorization-relevant difference and therefore `parser.disagreement` plus `indeterminate`.
- Parser-, artifact-, plan-completeness-, and comparator-derived indeterminate requirements remain
  present even when the canonical frontend's argv would otherwise match a trusted rule.
- Dangerous manifested effects retain their ordinary PolicyEngine ask behavior.
- No-manifest installations preserve existing decisions.

### Inference, observability, and performance

- Prove that inference never spawns the target, including for help or completion discovery.
- Prove that default inference performs no network I/O and that LLM use requires explicit `--llm`
  plus an existing configured provider.
- Validate model output against the closed schema and prove it cannot create trust.
- Scrub and bound provider inputs and keep prompts/responses out of gate audit logs.
- Expose match, trust, stale identity, and fallback reasons through `show`, `validate`, `explain`, and
  `doctor`.
- Include active trusted-rule state in the decision cohort fingerprint.
- Keep manifest loading, hashing, matching, and lowering within the existing hook latency budgets;
  budget exhaustion remains indeterminate rather than permissive.

## Documentation and decision records

Implementation must add an ADR that records trusted effect manifests as a permitted EffectPlan
decoder input and distinguishes them from prohibited command allowlists. It must update
`docs/CONTEXT.md`, `docs/CONCEPT.md`, CLI reference material, configuration/state documentation,
security guarantees, and operator guidance. Examples must show that `trust` asserts a complete
effect upper bound and that `ask` remains correct whenever completeness cannot be established.

## Rollout

Version 1 is opt-in by presence of trusted rules; no configuration flag or automatic migration is
required. Candidate generation can ship before gate consumption, but gate consumption must not ship
until schema, trust, identity, fail-closed integration, audit/cohort, doctor, and latency tests pass
together. Existing unknown-command behavior remains the rollback path: ignoring all effect manifests
restores the previous indeterminate result without changing policy or approval state.
