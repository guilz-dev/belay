# Native Seatbelt Boundary Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce reproducible GO/NO-GO/BLOCKED evidence that macOS Seatbelt can enforce Belay's native unknown-execution boundary without Docker and within the agreed latency budget.

**Architecture:** A probe-only Node script creates a private fixture mirror, derives an exact runtime closure, compiles a deny-by-default Seatbelt profile, and runs paired allow/deny cases through `/usr/bin/sandbox-exec`. Pure parsing, profile, decision, and redaction functions are unit-tested; the live command records raw evidence outside Git and writes only a redacted decision document after explicit execution.

**Tech Stack:** Node.js 22 ESM, macOS `/usr/bin/sandbox-exec`, `otool`, SHA-256, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-30-explicit-native-unknown-execution-design.md`

## Global Constraints

- This is feasibility code only; do not add a production `BoundaryDriver`, adapter behavior, config option, ADR-007, or Workstream C plan.
- Docker is completely outside the probe: do not discover, invoke, inspect, mock, or fall back to it.
- Run only on a real macOS host with the absolute executable `/usr/bin/sandbox-exec`; other hosts report BLOCKED without side effects.
- Use a private `mkdtemp` tree outside the repository for fixtures and raw evidence; never run an unknown command against the source workspace.
- Begin the Seatbelt profile with `deny default`; any required broad subpath grant for `/`, the user's home, `/usr/local`, or `/opt/homebrew` makes the result NO-GO.
- Exact literal runtime files beneath `/usr/local` or `/opt/homebrew` are permitted only when their absolute paths and SHA-256 hashes are recorded.
- Raw transcripts, absolute user paths, usernames, environment values, and secret sentinels never enter Git.
- N1 requires all security cases plus median Seatbelt overhead <= 100 ms and p95 <= 250 ms across 30 measured paired samples after five warm-ups.
- A live failure after a sandboxed process starts must still terminate the process group, confirm cleanup, and preserve evidence.

---

### Task 1: Define the evidence parser and decision gate

**Files:**

- Create: `scripts/native-seatbelt-boundary-probe.mjs`
- Create: `src/__tests__/native-seatbelt-boundary-probe.test.ts`

**Interfaces:**

- Consumes: newline-delimited JSON case records written by the probe child and parent listener records.
- Produces: `parseCaseRecords(text)`, `percentile(samples, fraction)`, `decideProbe(report)`, and `redactProbeReport(report, evidenceDir)` exports from the `.mjs` module.
- Produces: the frozen `REQUIRED_CASE_NAMES` array containing the ten case ids listed in Task 3.
- Produces: a `NativeSeatbeltProbeReportV1` object with `version: 1`, `status`, `host`, `substrate`, `runtimeClosure`, `profile`, `cases`, `latency`, `cleanup`, and `evidenceManifestSha256` fields.

- [ ] **Step 1: Write failing parser, redaction, percentile, and decision tests**

Use synthetic records and assert the four load-bearing rules directly:

```ts
const passing = reportFixture({
  cases: REQUIRED_CASES.map((name) => ({ name, passed: true })),
  latency: { samples: 30, medianOverheadMs: 80, p95OverheadMs: 220 },
  cleanup: { confirmed: true },
  profile: { forbiddenBroadGrants: [] },
})
expect(decideProbe(passing)).toBe('GO')
expect(decideProbe(reportFixture({ cases: [{ name: 'loopback-tcp', passed: false }] }))).toBe('NO-GO')
expect(
  decideProbe(
    reportFixture({
      profile: { forbiddenBroadGrants: [{ role: 'opt-homebrew', operation: 'file-read*' }] },
    }),
  ),
).toBe('NO-GO')
expect(decideProbe(reportFixture({ latency: { samples: 30, medianOverheadMs: 101, p95OverheadMs: 220 } }))).toBe('NO-GO')
expect(decideProbe(reportFixture({ host: { supported: false } }))).toBe('BLOCKED')
```

The redaction test must include the actual temporary path, fake username, environment token, and
secret sentinel and prove none remain in serialized output.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
pnpm exec vitest run src/__tests__/native-seatbelt-boundary-probe.test.ts
```

Expected: FAIL because `scripts/native-seatbelt-boundary-probe.mjs` or its named exports do not
exist.

- [ ] **Step 3: Implement the pure report helpers**

Define and export these exact functions:

```js
export function parseCaseRecords(text) {
  const records = new Map()
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue
    const value = JSON.parse(line)
    if (
      value?.version !== 1 ||
      typeof value.name !== 'string' ||
      typeof value.passed !== 'boolean' ||
      records.has(value.name)
    ) {
      throw new Error('invalid or duplicate Seatbelt probe case record')
    }
    records.set(value.name, value)
  }
  return [...records.values()]
}

export function percentile(samples, fraction) {
  if (samples.length === 0 || fraction <= 0 || fraction > 1) {
    throw new Error('percentile requires samples and a fraction in (0, 1]')
  }
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.ceil(sorted.length * fraction) - 1]
}

export function decideProbe(report) {
  if (!report.host.supported || !report.substrate.available) return 'BLOCKED'
  const observed = new Map(report.cases.map((entry) => [entry.name, entry]))
  const casesPass = REQUIRED_CASE_NAMES.every((name) => observed.get(name)?.passed === true)
  const latencyPass =
    report.latency.samples === 30 &&
    report.latency.medianOverheadMs <= 100 &&
    report.latency.p95OverheadMs <= 250
  return casesPass &&
    report.cleanup.confirmed &&
    report.profile.forbiddenBroadGrants.length === 0 &&
    latencyPass
    ? 'GO'
    : 'NO-GO'
}

export function redactProbeReport(report, evidenceDir) {
  const roleForPath = (value) => {
    if (value === evidenceDir) return '<PRIVATE_EVIDENCE_DIR>'
    if (value === '/usr/bin/sandbox-exec') return '<SANDBOX_EXEC>'
    return '<RUNTIME_FILE>'
  }
  return {
    version: 1,
    status: report.status,
    host: {
      platform: report.host.platform,
      supported: report.host.supported,
      productVersion: report.host.productVersion,
      kernel: report.host.kernel,
      arch: report.host.arch,
    },
    substrate: {
      available: report.substrate.available,
      executableRole: roleForPath(report.substrate.executable),
      sha256: report.substrate.sha256,
    },
    runtimeClosure: report.runtimeClosure.map(({ path, sha256, source }) => ({
      pathRole: roleForPath(path),
      sha256,
      source,
    })),
    profile: {
      literalReadCount: report.profile.literalReads.length,
      literalExecCount: report.profile.literalExecs.length,
      forbiddenBroadGrants: report.profile.forbiddenBroadGrants.map(({ role, operation }) => ({
        role,
        operation,
      })),
      sourceSha256: report.profile.sourceSha256,
    },
    cases: report.cases.map(({ name, passed, evidence }) => ({
      name,
      passed,
      evidence: {
        operationDenied: evidence.operationDenied,
        exitCode: evidence.exitCode,
        signal: evidence.signal,
        timedOut: evidence.timedOut,
        markerPresent: evidence.markerPresent,
        acceptedConnections: evidence.acceptedConnections,
        targetUnchanged: evidence.targetUnchanged,
        settledAfterMs: evidence.settledAfterMs,
      },
    })),
    latency: { ...report.latency },
    cleanup: { confirmed: report.cleanup.confirmed },
    evidenceManifestSha256: report.evidenceManifestSha256,
  }
}
```

`parseCaseRecords` must reject malformed JSON, unknown record versions, duplicate case names, and
missing required scalar fields. `redactProbeReport` must construct a new object from approved
fields and replace every absolute path with a stable role such as `<SANDBOX_EXEC>`,
`<RUNTIME_EXECUTABLE>`, or `<PRIVATE_EVIDENCE_DIR>`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: all parser, percentile, decision, and redaction tests pass.

- [ ] **Step 5: Commit the pure evidence contract**

```bash
git add scripts/native-seatbelt-boundary-probe.mjs src/__tests__/native-seatbelt-boundary-probe.test.ts
git commit -m "test: define native Seatbelt probe evidence contract"
```

### Task 2: Derive the runtime closure and compile a deny-by-default profile

**Files:**

- Modify: `scripts/native-seatbelt-boundary-probe.mjs`
- Modify: `src/__tests__/native-seatbelt-boundary-probe.test.ts`

**Interfaces:**

- Consumes: `process.execPath`, synthetic or real `otool -L` output, the private mirror root, and
  literal fixture paths.
- Produces: `parseOtoolLibraries(stdout)`, `resolveRuntimeClosure(executable, deps)`,
  `resolveLibraryReference(reference, loaderPath, executablePath)`, `seatbeltQuote(value)`,
  `compileSeatbeltProfile(input)`, and `validateProfileGrantInventory(profile)`.
- `compileSeatbeltProfile` returns `{ source, literalReads, literalExecs, mirrorRoot,
  forbiddenBroadGrants }`.

- [ ] **Step 1: Write failing runtime-closure and profile tests**

Cover `@loader_path`, absolute dylib paths, duplicate dependencies, symlink canonicalization,
spaces and quotes in paths, and recursive closure cycles. Assert the compiled source:

```ts
expect(profile.source).toContain('(version 1)')
expect(profile.source).toContain('(deny default)')
expect(profile.source).toContain(`(allow file-write* (subpath ${seatbeltQuote(mirrorRoot)}))`)
expect(profile.source).not.toContain('(allow network*')
expect(profile.source).not.toContain(`(subpath ${seatbeltQuote(homeDir)})`)
expect(profile.literalExecs).toEqual([canonicalNodePath])
expect(profile.forbiddenBroadGrants).toEqual([])
```

Add negative cases for a closure request using `/`, `$HOME`, `/usr/local`, or `/opt/homebrew` as a
subpath. Exact literal files under the last two roots remain valid.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm exec vitest run src/__tests__/native-seatbelt-boundary-probe.test.ts
```

Expected: FAIL on the missing closure/profile exports.

- [ ] **Step 3: Implement dependency-injected closure discovery**

Use an injected interface so unit tests never spawn host tools:

```js
export async function resolveRuntimeClosure(executable, deps = {
  realpath,
  stat,
  sha256File,
  runOtool: (file) => execFileCapture('/usr/bin/otool', ['-L', file]),
}) {
  const executablePath = await deps.realpath(executable)
  const queue = [{ path: executablePath, source: 'executable' }]
  const visited = new Set()
  const closure = []
  while (queue.length > 0) {
    const item = queue.shift()
    const canonical = await deps.realpath(item.path)
    if (visited.has(canonical)) continue
    const fileStat = await deps.stat(canonical)
    if (!fileStat.isFile()) throw new Error(`runtime closure is not a file: ${canonical}`)
    visited.add(canonical)
    closure.push({ path: canonical, sha256: await deps.sha256File(canonical), source: item.source })
    const output = await deps.runOtool(canonical)
    for (const library of parseOtoolLibraries(output.stdout)) {
      const resolved = resolveLibraryReference(library, canonical, executablePath)
      queue.push({ path: resolved, source: 'dependency' })
    }
  }
  return closure.sort((left, right) => left.path.localeCompare(right.path))
}
```

Record `{ pathRole, sha256, source }` for the executable and each exact library. Reject unresolved
`@rpath`, non-absolute resolved paths, newline/NUL-bearing paths, non-regular files, and any
directory grant.

- [ ] **Step 4: Implement the profile compiler and inventory validator**

The profile compiler must use a Seatbelt string encoder that escapes backslash and double quote
and rejects NUL/newline. It must emit only literal runtime reads/execs, mirror subpath read/write,
the exact private evidence-output path, and the fixed minimal device/system literals proven by the
live fixture. `validateProfileGrantInventory` returns NO-GO evidence rather than silently widening
the profile when a required resource is absent.

- [ ] **Step 5: Run focused tests, lint, and typecheck**

```bash
pnpm exec vitest run src/__tests__/native-seatbelt-boundary-probe.test.ts
pnpm lint
pnpm typecheck
```

Expected: focused tests and typecheck pass; lint has no new errors or warnings in the two probe
files.

- [ ] **Step 6: Commit the profile compiler**

```bash
git add scripts/native-seatbelt-boundary-probe.mjs src/__tests__/native-seatbelt-boundary-probe.test.ts
git commit -m "test: compile deny-by-default Seatbelt probe profile"
```

### Task 3: Implement private fixtures and live containment cases

**Files:**

- Modify: `scripts/native-seatbelt-boundary-probe.mjs`
- Modify: `src/__tests__/native-seatbelt-boundary-probe.test.ts`

**Interfaces:**

- Consumes: the helpers from Tasks 1 and 2.
- Produces: `createPrivateFixture()`, `runSandboxedCase()`, `terminateProcessGroup()`,
  `runLiveProbe()`, and a child entry point selected only by an exact nonce-bearing `--probe-child`
  argument.
- `runSandboxedCase` returns `{ exitCode, signal, timedOut, stdout, stderr, settledAfterMs }`.

- [ ] **Step 1: Write failing lifecycle tests with a fake process runner**

Assert that preflight checks `process.platform === 'darwin'` and the literal
`/usr/bin/sandbox-exec`, fixture directories use mode `0700`, fixture files use `0600`, and every
spawn uses an explicit environment allowlist containing only `PATH`, `TMPDIR`, `HOME`, `LANG`, and
the probe nonce. Assert no dependency or command name contains `docker`.

Add the same timeout-settlement regression used by the Cursor probe: a child acknowledges SIGTERM,
a descendant ignores it, and the returned promise must not settle before the one-second SIGKILL
fallback has run.

- [ ] **Step 2: Run the focused tests and verify RED**

```bash
pnpm exec vitest run src/__tests__/native-seatbelt-boundary-probe.test.ts
```

Expected: FAIL on the missing lifecycle exports.

- [ ] **Step 3: Implement preflight and fixture creation**

Create one `mkdtemp(path.join(os.tmpdir(), 'belay-native-seatbelt-probe-'))` root containing
`mirror`, `forbidden-source`, `fake-home`, `control-plane`, `listeners`, and `evidence`. Put unique
random sentinels in every forbidden location. Copy the probe script into `mirror` and execute the
copy with the exact hashed Node binary so the sandbox receives no read grant to the repository.

Preflight records `sw_vers -productVersion`, `uname -a`, architecture, sandbox-exec SHA-256, Node
path/SHA-256, and the runtime closure. A missing command or hash mismatch returns BLOCKED before
creating a sandboxed child.

- [ ] **Step 4: Implement all required allow/deny cases**

The nonce-bearing child supports exact case ids:

```text
mirror-read-write
source-read-write
home-secret-read-write
control-plane-read-write
absolute-path-read-write
loopback-tcp
unix-socket
descendant-inheritance
timeout-process-group
output-capture
```

For read denials, require both a nonzero operation result and absence of the sentinel from stdout,
stderr, and evidence records. For write denials, hash the target before and after. For TCP and Unix
sockets, the parent owns listeners and records an accepted-connection count of zero. For descendant
inheritance, the child spawns the same copied script with the same nonce and four forbidden
operations; every operation must fail independently.

- [ ] **Step 5: Implement process-group timeout and cleanup verification**

Spawn `/usr/bin/sandbox-exec -p <profile> <node> <copied-script> --probe-child <nonce> <case>` with
`detached: true`. On timeout, send SIGTERM to the negative process-group id, wait one second, send
SIGKILL if the group still exists, await stream settlement, and verify no post-cleanup descendant
marker appears during the following 250 ms. Cleanup uncertainty is a case failure, not a warning.

- [ ] **Step 6: Run unit tests without starting the live evidence run**

```bash
pnpm exec vitest run src/__tests__/native-seatbelt-boundary-probe.test.ts
```

Expected: unit tests pass with the fake process runner. Do not invoke `--live` in this task; the one
complete evidence run occurs only after the benchmark and decision document path exist in Task 4.

- [ ] **Step 7: Commit the live probe implementation, not raw evidence**

```bash
git add scripts/native-seatbelt-boundary-probe.mjs src/__tests__/native-seatbelt-boundary-probe.test.ts
git commit -m "test: probe native Seatbelt containment"
```

### Task 4: Measure overhead and publish the N1 decision

**Files:**

- Modify: `scripts/native-seatbelt-boundary-probe.mjs`
- Modify: `src/__tests__/native-seatbelt-boundary-probe.test.ts`
- Create: `docs/superpowers/specs/2026-08-30-native-seatbelt-boundary-probe-result.md`
- Modify: `package.json`

**Interfaces:**

- Consumes: `runLiveProbe()` and the redacted report from Task 3.
- Produces: package script `probe:native-seatbelt-boundary`, paired latency samples, a manifest hash,
  and the redacted N1 result document.

- [ ] **Step 1: Write failing paired-latency tests**

Inject monotonic durations for five warm-ups and 30 measured pairs. Assert each overhead sample is
`max(0, sandboxedMs - baselineMs)`, samples are paired in alternating order to reduce drift, and
the report uses nearest-rank median and p95. Assert 101 ms median or 251 ms p95 yields NO-GO.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm exec vitest run src/__tests__/native-seatbelt-boundary-probe.test.ts
```

Expected: FAIL until the paired benchmark helpers exist.

- [ ] **Step 3: Implement the benchmark and package command**

Add:

```json
"probe:native-seatbelt-boundary": "node scripts/native-seatbelt-boundary-probe.mjs --live"
```

The baseline and sandboxed sample execute the same copied no-op child with the same environment and
output capture. Alternate which member runs first for each pair. Record every raw duration and the
computed overhead; do not round before percentile calculation.

- [ ] **Step 4: Execute exactly one evidence run**

```bash
pnpm probe:native-seatbelt-boundary
```

Record the printed evidence directory and manifest hash. Do not rerun to seek a more favorable
result. A harness failure may be fixed under TDD, but the failed run remains recorded separately
from the next authorized evidence run.

- [ ] **Step 5: Write the redacted result document**

The document must contain:

- invocation, host versions, absolute executable roles and hashes;
- complete profile grant inventory with user paths replaced by stable roles;
- a table for every required case with marker/listener/hash evidence;
- all 30 paired overhead samples, median, p95, and thresholds;
- cleanup result and evidence manifest SHA-256;
- a statement that Docker was neither inspected nor invoked;
- review boundaries describing what raw evidence remains private; and
- exactly one terminal status: `GO`, `NO-GO`, or `BLOCKED` with the rule that selected it.

- [ ] **Step 6: Commit the decision evidence separately**

```bash
git add scripts/native-seatbelt-boundary-probe.mjs src/__tests__/native-seatbelt-boundary-probe.test.ts package.json docs/superpowers/specs/2026-08-30-native-seatbelt-boundary-probe-result.md
git commit -m "docs: record native Seatbelt probe decision"
```

### Task 5: Verify and review the feasibility result

**Files:**

- Review only: all files created or modified in Tasks 1-4.

**Interfaces:**

- Consumes: committed probe code, tests, result document, and private raw evidence manifest.
- Produces: a reviewed N1 terminal decision. Only GO authorizes creation of an N2 probe plan.

- [ ] **Step 1: Run the final quality gates**

```bash
pnpm lint
pnpm typecheck
pnpm exec vitest run src/__tests__/native-seatbelt-boundary-probe.test.ts
pnpm build
git diff --check
```

Expected: every command exits 0. Existing unrelated lint warnings must be recorded separately and
must not originate in the probe files.

- [ ] **Step 2: Perform mutation checks on the decision gate**

Temporarily invert each of these conditions one at a time and prove the focused suite fails:

- forbidden case success;
- forbidden broad grant;
- unconfirmed cleanup;
- median over 100 ms;
- p95 over 250 ms; and
- unsupported host incorrectly mapped to GO.

Restore the implementation after each mutation and rerun the focused suite to GREEN.

- [ ] **Step 3: Review raw evidence against the redacted result**

Confirm case counts, exit/signal values, listener accept counts, hashes, grant inventory, latency
samples, manifest hash, and terminal status match. Confirm the committed tree contains no raw
transcript, sentinel, username, temporary absolute path, environment secret, or private evidence
directory.

- [ ] **Step 4: Apply the terminal gate**

- GO: create a separate N2 Cursor deny-to-MCP continuation design review and probe plan; do not yet
  create ADR-007 or production code.
- NO-GO: close native unknown execution and retain ordinary exact approval.
- BLOCKED: retain ordinary exact approval and record the exact missing host prerequisite.

- [ ] **Step 5: Commit any review-only corrections**

```bash
git add scripts/native-seatbelt-boundary-probe.mjs src/__tests__/native-seatbelt-boundary-probe.test.ts package.json docs/superpowers/specs/2026-08-30-native-seatbelt-boundary-probe-result.md
git commit -m "test: harden native Seatbelt probe evidence"
```

## Definition of done

- The probe has one reviewed terminal status supported by raw host evidence and a committed redacted
  result.
- The source workspace and Git common directory were never exposed to the sandboxed fixture.
- Docker is absent from the probe call graph and execution record.
- Security, inheritance, cleanup, output, and latency gates are enforced by tests and mutation
  checks.
- No production configuration, adapter, boundary driver, ADR-007, or Workstream C implementation
  plan was added.
