# Mvdan Shell Compatibility Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce reproducible PASS/FAIL evidence for whether `sh-syntax@0.6.0` can safely support Belay's parser-neutral shell contract without adding a production dependency or changing runtime authority.

**Architecture:** Build and test a disposable Node.js probe in a private OS temporary directory with its own exact lockfile, then retain only a redacted result document in the repository. The probe loads repository-owned corpus generators and EffectPlan helpers from `dist/`, inspects the `sh-syntax` DTO without filling missing syntax from regexes, and converts every parse/projection/artifact/protocol failure to a partial program plus an indeterminate fail-closed plan. Preliminary upstream inspection shows that `sh-syntax@0.6.0` maps concrete command and word-part nodes to `{Pos, End}` only, so a FAIL outcome is expected unless the installed artifact proves otherwise; the exit criteria remain unchanged.

**Tech Stack:** Node.js 22 ESM, Node test runner, `sh-syntax@0.6.0`, `mvdan.cc/sh/v3@v3.13.1`, Belay `dist/` modules, npm isolated lockfile, pnpm verification.

**Spec:** `docs/superpowers/specs/2026-09-19-mvdan-shell-frontend-migration-design.md`

## Global Constraints

- This plan implements only the disposable compatibility probe. Do not add the Go/Wasm bridge, production parser artifact, production `MvdanShellFrontend`, rollout telemetry, or a promotion-mode change.
- Do not modify repository `package.json`, `pnpm-lock.yaml`, runtime bundles, installed hooks, configuration, authority, or release metadata.
- Pin `sh-syntax` exactly to `0.6.0`; record its npm integrity, annotated tag object `12510c789319c9f724290f2633324c78a7fc4b94`, and tag commit `d5a8e66beead01fb388db7de39f3d61960404c66`. The npm tarball does not ship `go.mod`, so record underlying `mvdan.cc/sh/v3` exactly as `v3.13.1` only after fetching `go.mod` from that immutable commit and matching it to the upstream source hash.
- Create all executable probe source, tests, package metadata, lockfiles, raw JSON, and timing samples beneath a mode-0700 directory returned by `mktemp -d` outside the repository.
- Use `recoverErrors: 0` and the default Bash variant. Do not infer omitted AST nodes from source text, regexes, printing, or a second shell parser.
- Every parse, projection, response-validation, artifact-load, timeout, node-limit, depth-limit, or span failure must produce `completeness: 'partial'`, at least one diagnostic, and an indeterminate EffectPlan disposition.
- Never classify an unknown upstream node as a known `command`, word part, redirect target, substitution, or control structure. Emit `unsupported` with a checked UTF-8 byte span instead.
- Keep raw commands, raw ASTs, absolute user paths, environment values, and exception messages out of `docs/ops/mvdan-shell-probe-result.md`.
- The only retained probe result is `docs/ops/mvdan-shell-probe-result.md`; this implementation plan is workflow documentation, not a runtime probe artifact.
- PASS requires every exit criterion in the design: complete required syntax projection, fail-closed failures, zero unresolved `candidate_looser`, no artifact/protocol allow, warm p95 below 100 ms and max below 500 ms, fresh-process cold max below 500 ms, and offline artifact load on supported platforms.
- A FAIL stops the production migration. Do not relax thresholds, substitute a different package, or begin the Go/Wasm bridge.

## Review Focus

- A syntactically successful parse whose `Cmd` contains only `Pos/End` must be reported as partial/unsupported, never as a complete simple command; Task 1 pins this with a synthetic collapsed AST and Task 2 repeats it against the installed package.
- UTF-8 offsets around non-BMP characters must remain byte offsets and invalid boundaries must fail closed; Task 1 tests both a valid emoji boundary and a mid-codepoint offset.
- Suite overlap must not inflate unique-case totals or erase per-suite counts; Task 2 tests stable IDs and independent corpus/structural/adversarial/dogfood membership accounting.
- Missing Wasm, corrupt Wasm, malformed adapter response, rejected parse, and timeout must all produce ask-equivalent indeterminate evidence; Task 3 injects each failure independently.
- Warm samples must exclude initialization while cold samples must include process startup and first Wasm load; Task 3 asserts sample counts and records the two distributions separately.

---

### Task 1: Define the disposable evidence and projection contract

**Files:**

- Create outside Git: `$BELAY_MVDAN_PROBE_DIR/package.json`
- Create outside Git: `$BELAY_MVDAN_PROBE_DIR/probe-contract.mjs`
- Create outside Git: `$BELAY_MVDAN_PROBE_DIR/probe-contract.test.mjs`
- Read: `src/core/shell-frontend/types.ts`
- Read: `src/core/shell-frontend/span.ts`
- Read: `src/core/shell-frontend/compare.ts`

**Interfaces:**

- Consumes: untrusted `unknown` parser responses, original command text, and a diagnostic code.
- Produces: `inspectShSyntaxResponse(value, source): ProjectionObservation`, `failureProgram(source, code, upstreamKind): ParsedShellProgram`, `projectShSyntax(value, source): ParsedShellProgram`, `classifyComparison(legacyOutcome, candidateOutcome): ComparisonClass`, `percentile(samples, fraction): number`, `decideProbe(report): 'PASS' | 'FAIL'`, and `redactReport(report): ProbeReportV1`.
- `ProjectionObservation` records only counts, node-kind names, missing-field names, and diagnostic codes; it never retains source or AST values.
- `ComparisonClass` is `'equal' | 'candidate_stricter' | 'candidate_looser' | 'not_comparable'`.

- [ ] **Step 1: Create a private probe directory and capture its literal path**

Run:

```bash
umask 077
export BELAY_MVDAN_PROBE_DIR="$(mktemp -d /private/tmp/belay-mvdan-shell-probe.XXXXXX)"
test -d "$BELAY_MVDAN_PROBE_DIR"
```

Expected: `test` exits 0. Record the returned literal path in the private run notes so later destructive cleanup targets only that directory.

- [ ] **Step 2: Create the isolated package manifest**

Use `apply_patch` to create this exact file beneath the resolved temporary directory:

```json
{
  "name": "belay-mvdan-shell-compatibility-probe",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "dependencies": { "sh-syntax": "0.6.0" }
}
```

Run from the temporary directory:

```bash
npm install --ignore-scripts --package-lock-only
npm ci --ignore-scripts
npm ls --all --json
```

Expected: the lockfile resolves exactly `sh-syntax@0.6.0` with no repository file changes.

Resolve the annotated tag once and save the raw API responses only in the private directory:

```bash
gh api repos/un-ts/sh-syntax/git/ref/tags/v0.6.0
gh api repos/un-ts/sh-syntax/git/tags/12510c789319c9f724290f2633324c78a7fc4b94
gh api -H 'Accept: application/vnd.github.raw+json' 'repos/un-ts/sh-syntax/contents/go.mod?ref=d5a8e66beead01fb388db7de39f3d61960404c66'
```

Expected: the tag resolves to commit `d5a8e66beead01fb388db7de39f3d61960404c66` and its `go.mod` requires `mvdan.cc/sh/v3 v3.13.1`. Hash the returned `go.mod` bytes and report the hash so the version claim is tied to immutable source rather than to an unpublished file in the npm tarball.

- [ ] **Step 3: Write failing pure-contract tests**

Create `probe-contract.test.mjs` using `node:test`. The tests must contain these exact load-bearing assertions:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyComparison,
  decideProbe,
  failureProgram,
  inspectShSyntaxResponse,
  percentile,
  projectShSyntax,
  redactReport,
} from './probe-contract.mjs'

test('collapsed command nodes are unsupported rather than silently complete', () => {
  const ast = {
    Name: '',
    Pos: { Offset: 0, Line: 1, Col: 1 },
    End: { Offset: 7, Line: 1, Col: 8 },
    Stmts: [{
      Pos: { Offset: 0, Line: 1, Col: 1 },
      End: { Offset: 7, Line: 1, Col: 8 },
      Cmd: { Pos: { Offset: 0, Line: 1, Col: 1 }, End: { Offset: 7, Line: 1, Col: 8 } },
      Redirs: [], Negated: false, Background: false, Coprocess: false,
    }],
  }
  const observation = inspectShSyntaxResponse(ast, 'echo ok')
  assert.deepEqual(observation.missingFields, ['Stmt.Cmd.kind', 'Stmt.Cmd.payload'])
  const projected = projectShSyntax(ast, 'echo ok')
  assert.equal(projected.completeness, 'partial')
  assert.deepEqual(projected.diagnostics.map(entry => entry.code), ['unsupported_node'])
  assert.equal(projected.nodes[0].kind, 'unsupported')
})

test('parse and protocol failures are partial', () => {
  for (const code of ['invalid_syntax', 'bridge_protocol_error', 'artifact_unavailable']) {
    const result = failureProgram('echo ok', code, `probe_${code}`)
    assert.equal(result.completeness, 'partial')
    assert.equal(result.nodes[0].kind, 'unsupported')
    assert.equal(result.diagnostics[0].code, code)
  }
})

test('UTF-8 spans reject a mid-codepoint offset', () => {
  const source = '🙂; echo ok'
  const valid = { Pos: { Offset: 4 }, End: { Offset: 12 } }
  const invalid = { Pos: { Offset: 1 }, End: { Offset: 12 } }
  assert.equal(inspectShSyntaxResponse({ Pos: valid.Pos, End: valid.End, Stmts: [] }, source).spanValid, true)
  assert.equal(inspectShSyntaxResponse({ Pos: invalid.Pos, End: invalid.End, Stmts: [] }, source).spanValid, false)
})

test('node and depth budgets fail closed', () => {
  const wide = { Pos: { Offset: 0 }, End: { Offset: 1 }, Stmts: [], Extra: [] }
  for (let index = 0; index < 10_001; index += 1) {
    wide.Extra.push({ Pos: { Offset: 0 }, End: { Offset: 1 } })
  }
  assert.equal(projectShSyntax(wide, 'x').diagnostics[0].code, 'node_limit')
  let deep = { Pos: { Offset: 0 }, End: { Offset: 1 } }
  for (let depth = 0; depth < 129; depth += 1) deep = { Pos: { Offset: 0 }, End: { Offset: 1 }, Child: deep }
  assert.equal(projectShSyntax({ Pos: { Offset: 0 }, End: { Offset: 1 }, Stmts: [], Extra: deep }, 'x').diagnostics[0].code, 'depth_limit')
})

test('decision requires every frozen gate', () => {
  const passing = {
    requiredSyntaxComplete: true,
    failuresFailClosed: true,
    unresolvedCandidateLooser: 0,
    artifactProtocolAllows: 0,
    warm: { p95Ms: 99, maxMs: 499 },
    cold: { maxMs: 499 },
    offlineLoad: { allSupportedPlatforms: true },
  }
  assert.equal(decideProbe(passing), 'PASS')
  assert.equal(decideProbe({ ...passing, requiredSyntaxComplete: false }), 'FAIL')
  assert.equal(decideProbe({ ...passing, unresolvedCandidateLooser: 1 }), 'FAIL')
  assert.equal(decideProbe({ ...passing, warm: { p95Ms: 100, maxMs: 499 } }), 'FAIL')
  assert.equal(decideProbe({ ...passing, cold: { maxMs: 500 } }), 'FAIL')
})

test('redaction retains aggregates only', () => {
  const report = redactReport({
    rawCommands: ['echo secret'], rawAst: { secret: true }, absolutePath: '/Users/example/private',
    summary: { total: 1 }, failures: [{ code: 'unsupported_node', feature: 'command' }],
  })
  const serialized = JSON.stringify(report)
  assert.equal(serialized.includes('echo secret'), false)
  assert.equal(serialized.includes('/Users/example/private'), false)
  assert.deepEqual(report.summary, { total: 1 })
})

test('nearest-rank percentile and comparison classes are deterministic', () => {
  assert.equal(percentile([5, 1, 4, 2, 3], 0.95), 5)
  assert.equal(classifyComparison({ permission: 'allow' }, { permission: 'ask' }), 'candidate_stricter')
  assert.equal(classifyComparison({ permission: 'ask' }, { permission: 'allow' }), 'candidate_looser')
})
```

- [ ] **Step 4: Run the tests and verify RED**

Run from the temporary directory:

```bash
node --test probe-contract.test.mjs
```

Expected: FAIL because `probe-contract.mjs` does not exist.

- [ ] **Step 5: Implement the minimal contract helpers**

Create `probe-contract.mjs` with the exact rules below:

```js
const DIAGNOSTICS = new Set([
  'invalid_syntax', 'unsupported_node', 'invalid_span', 'node_limit', 'depth_limit',
  'parser_timeout', 'artifact_unavailable', 'artifact_mismatch', 'bridge_protocol_error',
])
const PERMISSION_RANK = { allow: 0, ask: 1 }

export function failureProgram(source, code, upstreamKind) {
  if (!DIAGNOSTICS.has(code)) throw new Error(`unknown diagnostic: ${code}`)
  const sourceBytes = Buffer.byteLength(source, 'utf8')
  const span = { startByte: 0, endByte: sourceBytes }
  return { version: 1, sourceBytes, completeness: 'partial',
    nodes: [{ kind: 'unsupported', upstreamKind, span }], diagnostics: [{ code, span }] }
}

function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function byteBoundaries(source) {
  const set = new Set([0]); let offset = 0
  for (const scalar of source) { offset += Buffer.byteLength(scalar, 'utf8'); set.add(offset) }
  return set
}
function checkedSpan(node, source) {
  const startByte = node?.Pos?.Offset; const endByte = node?.End?.Offset
  const boundaries = byteBoundaries(source)
  if (!Number.isInteger(startByte) || !Number.isInteger(endByte) || startByte < 0 ||
      endByte < startByte || endByte > Buffer.byteLength(source, 'utf8') ||
      !boundaries.has(startByte) || !boundaries.has(endByte)) return null
  return { startByte, endByte }
}
function resourceUsage(value) {
  const seen = new WeakSet(); let nodeCount = 0; let maxDepth = 0
  const visit = (entry, depth) => {
    if (!entry || typeof entry !== 'object' || seen.has(entry)) return
    seen.add(entry); maxDepth = Math.max(maxDepth, depth)
    if (!Array.isArray(entry) && entry.Pos && entry.End) nodeCount += 1
    for (const child of Array.isArray(entry) ? entry : Object.values(entry)) visit(child, depth + 1)
  }
  visit(value, 0)
  return { nodeCount, maxDepth }
}

export function inspectShSyntaxResponse(value, source) {
  if (!isRecord(value) || !Array.isArray(value.Stmts)) {
    return { responseValid: false, spanValid: false, missingFields: ['File.Stmts'], statementCount: 0 }
  }
  const missing = new Set(); let spanValid = checkedSpan(value, source) !== null
  const usage = resourceUsage(value)
  for (const stmt of value.Stmts) {
    if (!checkedSpan(stmt, source)) spanValid = false
    if (stmt?.Cmd) {
      if (typeof stmt.Cmd.kind !== 'string') missing.add('Stmt.Cmd.kind')
      if (!Object.keys(stmt.Cmd).some(key => !['Pos', 'End'].includes(key))) missing.add('Stmt.Cmd.payload')
    }
    for (const redirect of Array.isArray(stmt?.Redirs) ? stmt.Redirs : []) {
      for (const part of Array.isArray(redirect?.Word?.Parts) ? redirect.Word.Parts : []) {
        if (typeof part.kind !== 'string') missing.add('Redirect.Word.Parts.kind')
      }
    }
  }
  return { responseValid: true, spanValid, missingFields: [...missing].sort(),
    statementCount: value.Stmts.length, ...usage }
}

export function projectShSyntax(value, source) {
  const observed = inspectShSyntaxResponse(value, source)
  if (!observed.responseValid) return failureProgram(source, 'bridge_protocol_error', 'invalid_sh_syntax_response')
  if (observed.nodeCount > 10_000) return failureProgram(source, 'node_limit', 'sh_syntax_node_limit')
  if (observed.maxDepth > 128) return failureProgram(source, 'depth_limit', 'sh_syntax_depth_limit')
  if (!observed.spanValid) return failureProgram(source, 'invalid_span', 'invalid_sh_syntax_span')
  if (observed.missingFields.length > 0) return failureProgram(source, 'unsupported_node', 'sh_syntax_collapsed_node')
  return failureProgram(source, 'unsupported_node', 'unproven_sh_syntax_projection')
}

export function classifyComparison(legacy, candidate) {
  if (!legacy?.permission || !candidate?.permission) return 'not_comparable'
  if (legacy.permission === candidate.permission) return 'equal'
  return PERMISSION_RANK[candidate.permission] > PERMISSION_RANK[legacy.permission]
    ? 'candidate_stricter' : 'candidate_looser'
}
export function percentile(samples, fraction) {
  if (samples.length === 0 || fraction <= 0 || fraction > 1) throw new Error('invalid percentile input')
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}
export function decideProbe(report) {
  return report.requiredSyntaxComplete && report.failuresFailClosed &&
    report.unresolvedCandidateLooser === 0 && report.artifactProtocolAllows === 0 &&
    report.warm.p95Ms < 100 && report.warm.maxMs < 500 && report.cold.maxMs < 500 &&
    report.offlineLoad.allSupportedPlatforms ? 'PASS' : 'FAIL'
}
export function redactReport(report) {
  return { version: 1, summary: structuredClone(report.summary ?? {}),
    failures: structuredClone(report.failures ?? []) }
}
```

The intentionally conservative final branch of `projectShSyntax` prevents a future package-shape change from silently becoming complete before a reviewed projector exists.

- [ ] **Step 6: Run the pure tests and verify GREEN**

Run:

```bash
node --test probe-contract.test.mjs
```

Expected: all seven tests pass.

### Task 2: Freeze and evaluate the compatibility case matrix

**Files:**

- Create outside Git: `$BELAY_MVDAN_PROBE_DIR/probe-cases.mjs`
- Create outside Git: `$BELAY_MVDAN_PROBE_DIR/probe-cases.test.mjs`
- Create outside Git: `$BELAY_MVDAN_PROBE_DIR/run-probe.mjs`
- Read generated modules: `dist/corpus/evaluate.js`, `dist/corpus/adversarial-probe.js`, `dist/corpus/mutators.js`, `dist/corpus/benign-probe-cores.js`
- Read generated modules: `dist/core/effect-ir/shell-lower.js`, `dist/core/effect-ir/policy.js`, `dist/core/shell-frontend/compare.js`, `dist/core/verdict/adapter.js`

**Interfaces:**

- Consumes: repository root as the first CLI argument, fixed seed `42`, installed `sh-syntax.parse`, and the Task 1 helpers.
- Produces: `loadProbeCases(repoRoot): Promise<ProbeCase[]>`, `featureCases(): ProbeCase[]`, `stableCaseId(command): string`, `suiteCounts(cases): Record<string, number>`, and private `probe-report.json`.
- `ProbeCase` is `{ id: string, command: string, suites: ('corpus'|'structural'|'adversarial'|'dogfood'|'feature')[], features: string[] }`.
- Duplicate commands merge suite and feature membership by stable SHA-256 ID; source order cannot change the aggregate.

- [ ] **Step 1: Build repository modules without changing dependency state**

Run from the worktree root:

```bash
pnpm build
```

Expected: exit 0 and `dist/` contains the modules listed above.

- [ ] **Step 2: Write failing case-matrix tests**

Create `probe-cases.test.mjs` with synthetic duplicate inputs plus assertions against repository fixtures:

```js
import assert from 'node:assert/strict'
import test from 'node:test'
import { featureCases, loadProbeCases, mergeCases, suiteCounts } from './probe-cases.mjs'

const repoRoot = process.env.BELAY_REPO_ROOT
if (!repoRoot) throw new Error('BELAY_REPO_ROOT is required')

test('suite overlap merges by command without losing membership', () => {
  const merged = mergeCases([
    { command: 'git status', suites: ['corpus'], features: ['command'] },
    { command: 'git status', suites: ['dogfood'], features: ['command'] },
  ])
  assert.equal(merged.length, 1)
  assert.deepEqual(merged[0].suites, ['corpus', 'dogfood'])
})

test('feature matrix covers every parser-neutral node and word category', () => {
  const features = new Set(featureCases().flatMap(entry => entry.features))
  for (const required of [
    'command', 'assignment', 'literal', 'quoted', 'parameter_expansion',
    'arithmetic_expansion', 'command_substitution', 'process_substitution', 'redirect',
    'heredoc', 'pipeline', 'and_or', 'sequence', 'subshell', 'brace_group',
    'if', 'loop', 'case', 'function', 'invalid_syntax', 'utf8_span',
  ]) assert.equal(features.has(required), true, required)
})

test('real fixture groups are non-empty and dogfood is provenance-derived', async () => {
  const cases = await loadProbeCases(repoRoot)
  const counts = suiteCounts(cases)
  for (const suite of ['corpus', 'structural', 'adversarial', 'dogfood', 'feature']) {
    assert.ok(counts[suite] > 0, suite)
  }
  assert.equal(cases.filter(entry => entry.suites.includes('dogfood')).every(
    entry => entry.provenanceSource === 'harvest'), true)
})
```

- [ ] **Step 3: Run the case tests and verify RED**

Run from the temporary directory:

```bash
BELAY_REPO_ROOT=/Users/kaz/product/guilz/belay/.worktrees/docs-mvdan-shell-migration-remaining-work node --test probe-cases.test.mjs
```

Expected: FAIL because `probe-cases.mjs` does not exist.

- [ ] **Step 4: Implement the frozen case matrix**

Implement `featureCases()` with these exact commands and labels:

```js
const FEATURE_INPUTS = [
  ['command literal', 'printf ok', ['command', 'literal']],
  ['assignment quoted parameter', 'A="${HOME}" printf "%s" "$A"', ['assignment', 'quoted', 'parameter_expansion']],
  ['arithmetic', 'echo $((1 + 2))', ['arithmetic_expansion']],
  ['command substitution', 'echo "$(git status)"', ['command_substitution']],
  ['process substitution', 'diff <(printf a) <(printf b)', ['process_substitution']],
  ['redirect', 'printf ok 2>out.txt', ['redirect']],
  ['heredoc', "cat <<'EOF'\nliteral\nEOF", ['heredoc']],
  ['pipeline', 'printf ok | wc -c', ['pipeline']],
  ['and-or', 'git status && printf ok || false', ['and_or']],
  ['sequence', 'printf a; printf b & wait', ['sequence']],
  ['subshell', '(git status)', ['subshell']],
  ['brace group', '{ git status; }', ['brace_group']],
  ['if', 'if true; then git status; else false; fi', ['if']],
  ['loop', 'for x in a; do printf "%s" "$x"; done', ['loop']],
  ['case', 'case "$x" in a) git status;; *) false;; esac', ['case']],
  ['function', 'f() { git status; }; f', ['function']],
  ['invalid', 'if true; then', ['invalid_syntax']],
  ['utf8', 'printf "🙂" && git status', ['utf8_span']],
]
```

Load the other groups as follows:

```js
const corpus = await loadCorpusCases(path.join(repoRoot, 'corpus'))
const structural = [
  ...CATASTROPHIC_CORES.map(command => ({ command })),
  ...generateMutatedCases(CATASTROPHIC_CORES, ALL_STRUCTURAL_WRAPPERS),
  ...BENIGN_PROBE_CORES.map(command => ({ command })),
]
const adversarial = [...generateProbeCases(42), ...generateFpProbeCases(42)]
const dogfood = corpus.filter(entry => entry.provenance?.source === 'harvest')
```

Normalize into `ProbeCase[]`, preserve `provenanceSource: 'harvest'` only on dogfood members, merge duplicate IDs, sort suite/feature arrays, and sort final cases by ID. Do not copy commands or provenance fingerprints into the retained report.

- [ ] **Step 5: Run the case tests and verify GREEN**

Run the command from Step 3. Expected: all three tests pass and each required suite count is non-zero.

- [ ] **Step 6: Implement parse, projection, and normalized plan observations**

Create `run-probe.mjs`. For each case:

1. Call `parse(command, { recoverErrors: 0 })` with a per-case 250 ms `Promise.race` deadline.
2. Inspect and project the returned DTO using Task 1 helpers.
3. On parse rejection use `invalid_syntax`; on deadline use `parser_timeout`; on any unknown adapter failure use `bridge_protocol_error`.
4. Build one `VerdictContext` with `buildVerdictContext({ cwd: path.join(repoRoot, 'src'), repoRoot, config: DEFAULT_CONFIG_V3 })`. Obtain the legacy EffectPlan with `lowerShellEffectPlan({ command, cwd, repoRoot, inputFingerprint: stableCaseId(command), belayConfig: DEFAULT_CONFIG_V3, shellFrontendMode: 'legacy' })`, normalize it with `projectAuthorization`, and derive its allow/ask outcome from `evaluateEffectPlanPolicy(legacyPlan, context).projection.permission`.
5. Because `sh-syntax@0.6.0` does not expose enough syntax to run the shared semantic lowerer, record semantic comparison as `not_comparable`. Separately create a fail-closed plan with `appendParserDisagreement(legacyPlan)`, normalize it with `projectAuthorization`, prove that it contains every legacy requirement plus the indeterminate marker, and evaluate it under the same policy. This validates the failure path but must not be labeled semantic parity.
6. Aggregate only counts by suite, feature, parse outcome, completeness, diagnostic, comparison class, and final permission. Store raw per-case records only in the temporary directory.

The report must have this shape:

```js
{
  version: 1,
  identity: { shSyntaxVersion, shSyntaxIntegrity, shSyntaxTagCommit, mvdanModuleVersion },
  input: { repositoryCommit, corpusSha256, uniqueCases, suiteCounts, featureCounts },
  syntax: { byFeature, requiredFields, missingFields, silentlyDroppedNodes },
  comparison: {
    semantic: { equal, candidateStricter, candidateLooser, notComparable },
    failClosedDisposition: { equal, candidateStricter, candidateLooser },
    unresolvedCandidateLooser,
  },
  failureModes: {}, package: {}, latency: {}, offlineLoad: {}, exitCriteria: {}, status: 'FAIL',
}
```

Assert `silentlyDroppedNodes === 0`: unsupported nodes count as explicit partial output, while a complete program with missing fields aborts the run as invalid evidence.

- [ ] **Step 7: Run the matrix and retain private evidence**

Run from the temporary directory:

```bash
node run-probe.mjs /Users/kaz/product/guilz/belay/.worktrees/docs-mvdan-shell-migration-remaining-work
```

Expected: `probe-report.json` is written privately; the process exits non-zero if a harness invariant is violated, but exits zero when it has produced a valid PASS or FAIL decision. Given the inspected upstream mapper, required syntax projection is expected to be incomplete and the decision is expected to be FAIL.

### Task 3: Exercise failure modes, package impact, and latency

**Files:**

- Create outside Git: `$BELAY_MVDAN_PROBE_DIR/failure-modes.test.mjs`
- Create outside Git: `$BELAY_MVDAN_PROBE_DIR/cold-child.mjs`
- Modify outside Git: `$BELAY_MVDAN_PROBE_DIR/run-probe.mjs`
- Modify outside Git: `$BELAY_MVDAN_PROBE_DIR/probe-report.json`

**Interfaces:**

- Consumes: injected parser functions, an explicit Wasm path, case matrix, and Task 1 decision helpers.
- Produces: `parseWithDeadline(parseFn, command, timeoutMs)`, `loadArtifact(readFileFn, wasmPath)`, `validateAdapterResponse(value, source)`, warm samples, cold samples, offline-load records, package-size records, and final exit-criterion booleans.

- [ ] **Step 1: Write failing failure-mode tests**

Create tests that inject each failure without mutating the installed package:

```js
test('missing artifact is partial and indeterminate', async () => {
  const result = await loadArtifact(async () => { const error = new Error('missing'); error.code = 'ENOENT'; throw error }, '/private/main.wasm')
  assert.equal(result.program.completeness, 'partial')
  assert.equal(result.program.diagnostics[0].code, 'artifact_unavailable')
  assert.equal(result.permission, 'ask')
})

test('corrupt artifact is mismatch and indeterminate', async () => {
  const result = await loadArtifact(async () => Buffer.from('not wasm'), '/private/main.wasm')
  assert.equal(result.program.diagnostics[0].code, 'artifact_mismatch')
  assert.equal(result.permission, 'ask')
})

test('malformed response is protocol error and indeterminate', async () => {
  const result = validateAdapterResponse({ Stmts: 'not-an-array' }, 'echo ok')
  assert.equal(result.program.diagnostics[0].code, 'bridge_protocol_error')
  assert.equal(result.permission, 'ask')
})

test('timeout is partial and indeterminate', async () => {
  const never = () => new Promise(() => {})
  const result = await parseWithDeadline(never, 'echo ok', 5)
  assert.equal(result.program.diagnostics[0].code, 'parser_timeout')
  assert.equal(result.permission, 'ask')
})
```

Also assert exactly one outcome is recorded per injected failure and zero failure outcome has permission `allow`.

- [ ] **Step 2: Run the failure tests and verify RED**

Run:

```bash
node --test failure-modes.test.mjs
```

Expected: FAIL because the injected adapters are not exported.

- [ ] **Step 3: Implement injected failure adapters and verify GREEN**

Implement the named functions without reading environment variables or absolute paths into the report. Validate Wasm magic/version bytes and require `WebAssembly.compile(bytes)` to succeed; map `ENOENT` to `artifact_unavailable`, other read, header, version, or compile failures to `artifact_mismatch`, malformed DTOs to `bridge_protocol_error`, and deadline expiry to `parser_timeout`. Build the returned ask disposition by adding the same indeterminate requirement used by `appendParserDisagreement`; do not call the legacy parser as an allow fallback.

Run the command from Step 2. Expected: all failure-mode tests pass and `artifactProtocolAllows` remains zero.

- [ ] **Step 4: Measure package and bundle impact**

Record:

- installed `node_modules/sh-syntax/main.wasm` byte size and SHA-256;
- installed package file count and total unpacked bytes;
- npm `dist.unpackedSize`, tarball size, and integrity for `sh-syntax@0.6.0`;
- current hook bundle sizes under `dist/bundle/` before any parser inclusion;
- actual repository bundle delta as exactly zero because no production file changed;
- projected minimum parser payload as the Wasm plus required runtime shim/module bytes, clearly labeled an estimate rather than a measured production bundle.

Reject the identity evidence if installed `package.json` is not `0.6.0`, the immutable tag commit is not `d5a8e66beead01fb388db7de39f3d61960404c66`, that commit's hashed `go.mod` does not require `mvdan.cc/sh/v3 v3.13.1`, or the npm integrity differs from the isolated lockfile.

- [ ] **Step 5: Measure warm full-gate latency**

Warm the parser and Belay classifier with five unrecorded feature cases. Then measure every unique case once using `performance.now()` around the complete probe path: parse, projection, fail-closed EffectPlan disposition, and policy permission. Record sample count, p50, p95, and max rounded upward to two decimals. Do not use parse-only timing for the exit criterion.

Expected gate: `p95Ms < 100` and `maxMs < 500`. Record the observed values even when syntax compatibility has already failed.

- [ ] **Step 6: Measure fresh-process cold latency**

Implement `cold-child.mjs` so one process imports the installed package, parses one fixed simple command, projects it, constructs the fail-closed plan, writes one aggregate JSON record, and exits. Spawn 20 children sequentially; each measurement begins immediately before `spawn` and ends after validated child exit so Node startup and first Wasm load are included. Kill a child at 2,000 ms and record a timeout rather than omitting the sample.

Expected gate: all 20 samples exist and `maxMs < 500`.

- [ ] **Step 7: Verify instrumented offline loading**

Spawn one fresh child after replacing userland network entry points (`fetch`, `http.request`, `https.request`, `net.connect`, `tls.connect`, and `dns.lookup`) with functions that throw. The child must import `sh-syntax`, load local `main.wasm`, and parse `printf ok`. Record platform, architecture, success, and interception count; do not claim OS-enforced isolation. Mark `allSupportedPlatforms: false` unless every platform named by the design (macOS arm64, macOS x64, Linux x64) has an equivalent recorded run.

Because this local disposable probe does not add a committed CI workflow, unmeasured supported platforms remain a failed exit criterion rather than being assumed successful.

- [ ] **Step 8: Re-run all disposable tests and finalize private JSON**

Run:

```bash
node --test probe-contract.test.mjs probe-cases.test.mjs failure-modes.test.mjs
node run-probe.mjs /Users/kaz/product/guilz/belay/.worktrees/docs-mvdan-shell-migration-remaining-work
```

Expected: tests pass; `probe-report.json` contains every required aggregate and a mechanically computed PASS or FAIL.

### Task 4: Publish the redacted decision, verify the branch, and clean up

**Files:**

- Create: `docs/ops/mvdan-shell-probe-result.md`
- Modify: `docs/ops/mvdan-shell-frontend-migration-remaining-work.md`
- Delete outside Git after evidence transfer: the single resolved `$BELAY_MVDAN_PROBE_DIR`

**Interfaces:**

- Consumes: validated private `probe-report.json`, exact package/revision evidence, and exit-criterion booleans.
- Produces: a human-reviewable result with no raw commands, raw ASTs, private paths, or secrets; updates the remaining-work status without claiming later migration stages are implemented.

- [ ] **Step 1: Write the result document from approved aggregates**

Use `apply_patch` to create `docs/ops/mvdan-shell-probe-result.md` with these sections and no others omitted:

1. terminal `PASS` or `FAIL` status and migration consequence;
2. probe date, repository commit, host/platform scope;
3. `sh-syntax` version, npm integrity, tag commit, `mvdan/sh` version, Wasm SHA-256;
4. corpus/structural/adversarial/dogfood/feature counts plus unique total and overlap note;
5. parse success/partial/failure by feature;
6. required AST information and missing information;
7. normalized EffectPlan semantic comparison and separately labeled fail-closed disposition counts;
8. every `candidate_looser` disposition or an explicit zero row;
9. missing/corrupt artifact, malformed response, timeout, invalid span, node/depth limit results;
10. warm and cold latency distributions and thresholds;
11. offline-load platform matrix and its limitations;
12. package size, current bundle size, zero actual delta, and projected payload estimate;
13. one row per exit criterion with evidence and pass/fail;
14. final decision and the exact next permitted action.

If the public DTO still lacks concrete command kinds or word-part payloads, state that parse success is not contract compatibility and the next permitted action is to stop production migration and open a new design decision; do not recommend beginning the Go/Wasm bridge under this design.

- [ ] **Step 2: Update the remaining-work index**

Add a dated compatibility-probe status beneath stage 1. Link the result document, record PASS/FAIL, and preserve all later stages as blocked on a PASS. Do not change the top-level migration state to complete.

- [ ] **Step 3: Verify redaction before deleting private evidence**

Run focused scans against the result document for the literal temporary path, current username/home path, known raw command samples, `rawAst`, and environment-like key/value strings. Expected: no matches. Review the document manually to confirm it contains only aggregates and approved immutable hashes.

- [ ] **Step 4: Remove only the resolved private probe directory**

First print and compare the literal directory against the path recorded in Task 1. Then remove that exact directory; do not use a glob, `$HOME`, `~`, a parent directory, or an unresolved variable. Confirm the exact path no longer exists. Raw evidence is intentionally unrecoverable after this step; the redacted result remains in Git.

- [ ] **Step 5: Run repository verification**

Run from the worktree root:

```bash
pnpm lint
pnpm typecheck
pnpm test
git diff --check
```

Expected: all commands exit 0; lint may show only pre-existing warnings already present on the branch; the full suite has no failures.

- [ ] **Step 6: Review the exact implementation diff once**

Review the fixed `origin/main..HEAD` diff for spec compliance and repository standards. If blocking findings exist, fix them in one batch and perform one limited re-review of only the findings and fix diff, matching the repository review termination rule. Do not start an additional whole-branch review.

- [ ] **Step 7: Commit and push the probe evidence**

```bash
git add docs/ops/mvdan-shell-probe-result.md docs/ops/mvdan-shell-frontend-migration-remaining-work.md
git commit -m "docs: record mvdan shell compatibility probe"
git push origin docs/mvdan-shell-migration-remaining-work
```

Expected: Draft PR #146 updates with the result, and no temporary probe source, package lock, `node_modules`, raw evidence, production dependency, or runtime artifact appears in the diff.
