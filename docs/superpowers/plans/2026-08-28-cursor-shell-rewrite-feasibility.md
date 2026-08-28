# Cursor Shell Rewrite Feasibility Plan

> **For implementers:** This is a contract probe, not permission to ship native mediation. Stop at the decision gate.

**Goal:** Prove or disprove that Cursor can replace one Shell tool command with a Belay ticket runner while preserving normal tool output and preventing execution of the original command.

**Primary sources:**

- Cursor native hooks: <https://prod.cursor.com/docs/hooks>
- Cursor third-party hook compatibility: <https://prod.cursor.com/docs/reference/third-party-hooks>

**Known contract:** `permission: deny` blocks; `permission: allow` proceeds; `updated_input.command` can replace Shell input. The docs do not promise synthetic completed-tool output, re-hook behavior, precedence with multiple mutating hooks, or the exact interaction with `beforeShellExecution`.

---

### Task 1: Add a repeatable real-host probe

**Files:**

- Create: `scripts/cursor-shell-rewrite-probe.mjs`
- Create: `src/__tests__/cursor-shell-rewrite-probe.test.ts`
- Create: `docs/superpowers/specs/2026-08-28-cursor-shell-rewrite-probe-result.md`
- Modify: `package.json`

Add `probe:cursor-shell-rewrite` invoking the script. The script must:

1. Refuse to run unless `cursor-agent` is present and authenticated; print an explicit SKIP without changing production config.
2. Create a private temporary workspace with a project-local `.cursor/hooks.json`, probe hook, event log, and two marker paths.
3. Register both `preToolUse` Shell and `beforeShellExecution` probe hooks.
4. Invoke the installed Cursor Agent using `--print --output-format stream-json --trust --workspace <temp>` and a prompt that requests one exact Shell marker command.
5. Capture Cursor version, stdout/stderr event stream, hook inputs/outputs, marker state, and timestamps into the temporary workspace; redact user identity and tokens before copying the result summary into the spec.
6. Always print the temporary evidence directory so a reviewer can inspect raw data. Do not delete it automatically.

Use marker files rather than trusting agent prose:

- Original command creates `ORIGINAL_RAN`.
- Rewritten command creates `MEDIATED_RAN` and prints a unique stdout marker.
- A second case prints a unique stderr marker and exits `37`.

The probe hook must log every invocation before responding. It may rewrite only the exact nonce-bearing probe command; every other command returns `permission: deny` so agent retries cannot contaminate evidence.

- [ ] Write a script-level unit test around transcript parsing with fixed synthetic stream-json fixtures.
- [ ] Verify the parser test fails before implementation and passes afterward.
- [ ] Run `pnpm probe:cursor-shell-rewrite` on the currently installed Cursor Agent.
- [ ] Record the exact Cursor version, OS, command, result, and evidence-directory hash in the result spec. Do not commit raw transcripts containing local paths or account data.

---

### Task 2: Test all transport invariants

Run and record these cases separately.

#### Case A — replacement and single execution

Expected:

- `MEDIATED_RAN` exists.
- `ORIGINAL_RAN` does not exist.
- The Shell tool result contains the mediated stdout marker.
- Logs reveal whether `preToolUse` sees the replacement a second time.

#### Case B — exit and stderr propagation

Expected:

- The first Shell result reports exit code `37`.
- The first Shell result contains the exact stderr marker.
- The original command never runs after the replacement fails.

#### Case C — secondary hook interaction

Expected:

- Record whether `beforeShellExecution` receives the original command or replacement.
- If it receives the replacement, demonstrate that a ticket-shaped command can be validated without consuming the ticket; consumption belongs to the runner.
- If it receives the original or blocks replacement, mark the transport NO-GO until a deterministic protocol exists.

#### Case D — competing `updated_input`

Add a second matching project hook that rewrites the same command to a third marker.

Expected:

- Establish deterministic merge order from evidence.
- If Belay cannot detect that its rewrite lost or was modified, default-on mediation is NO-GO.
- If version/scope ordering is the only control, record the required minimum Cursor version and installation constraints; do not assume them.

#### Case E — malformed/denied responses

Expected:

- `permission: deny` produces no marker and is visibly a block.
- Malformed hook output and nonzero hook exits are recorded to determine Cursor’s fail-open behavior, but Belay’s production hook must continue emitting valid fail-closed JSON.

---

### Task 3: Review the adapter contract impact

**Files:**

- Modify: `docs/adapter-sdk.md` only if the probe passes
- Modify: `src/__tests__/gate-contract.test.ts` only if the probe demonstrates an exported contract change is unavoidable

- [ ] Map the passing transport to a Cursor-only response type containing optional `updated_input`; do not add it to generic `GateVerdict` merely for convenience.
- [ ] Confirm that `gateVerdictToCursorResponse` can remain the ordinary allow/deny mapper and that mediation can be a separate adapter orchestration result. If it cannot, document why `GATE_CONTRACT_VERSION` must increment and defer that breaking change to ADR review.
- [ ] Confirm the wrapper invocation can be distinguished by a cryptographic single-use ticket rather than a command-name allowlist, satisfying ADR-005.
- [ ] Confirm native eligibility will be represented as a separate EffectPlan action/world, not as `if unknown then bypass policy`, satisfying ADR-004.
- [ ] Review the evidence before editing any production runtime file.

---

### Task 4: Make the go/no-go decision

The result spec must end with exactly one status:

- `GO`: all Cases A–D pass on a stated supported Cursor version and Case E is understood.
- `NO-GO`: any original command executes, result propagation fails, recursion is uncontrollable, or another hook can silently defeat the replacement.
- `BLOCKED`: the probe cannot run because Cursor Agent is unavailable or unauthenticated; this is not equivalent to GO.

For `GO`, the result spec must list:

- supported version floor backed by evidence (initially the exact probed version unless a compatibility matrix is run);
- observed re-hook and `beforeShellExecution` sequence;
- multiple-hook precedence and required conflict detection;
- exact adapter response shape;
- evidence that stdout, stderr, and exit status are preserved;
- remaining design risks to resolve in ADR-007.

For `NO-GO`, retain ordinary exact approval and close the native execution proposal without adding its config option. For `BLOCKED`, do not proceed until the same probe runs against a real supported Cursor environment.

Final verification for this spike:

```bash
pnpm lint
pnpm typecheck
pnpm exec vitest run \
  src/__tests__/cursor-shell-rewrite-probe.test.ts \
  src/__tests__/gate-contract.test.ts
pnpm build
git diff --check
```

Commit the probe and decision evidence separately from production changes as `test: probe Cursor Shell command replacement`.

**Definition of done:** Reviewers can reproduce the result and decide feasibility from marker files and raw hook/tool events, not from an agent’s narrative or an undocumented assumption.
