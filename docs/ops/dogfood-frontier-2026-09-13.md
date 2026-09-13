# Horizon 1 frontier — 2026-09-13

Issue: [#72](https://github.com/guilz-dev/belay/issues/72). This is a local inspection and
implementation record, not evidence that Horizon 1 has exited or permission to enable enforce.

## Installed-runtime evidence

Read-only `harvest list`, `metrics`, and `quality` inspections of the Belay target observed:

- Runtime: `0.12.1`; boundary: `l3-l4-only`.
- Runtime artifact: `d4f92825805e6c54b40d3f27199acf54d5c277cbec66f1cf29efa86ba8e9ea4a`.
- Decision config: `8867a58f615ef3f289a6aacf721dd16ba6184229bb92ceb294c129f193b0ccc8`.
- Active version log: `v0.12.1.log`; 106 parsed records, 51 gate events (18 shell, 33 tool).
- 23 would-block events: 19 `unknown_local_effect`, 4 `outside_repo_mutation`.
- Availability asks: 0; malformed/oversized records: 0.
- Shell harvest: no unreviewed candidates, no availability queue. This does not mean
  all-channel precision is perfect: harvest is shell-scoped.
- Reviewed provably-benign events: 0; reviewed sessions: 0; ready for enforce: false.
- The pre-change corpus passed 96 cases, including 42 must-ask and 35 provably-benign cases,
  with no hard-gate misses or blocks.

## Bounded implementation increment

Tool Read calls for ordinary plugin instructions and terminal logs outside the repository were
classified as `outside_repo_mutation`. The generic PolicyEngine path-scope rule applied to
`fs.read` as well as writes. Read requests now use the existing shell effect credential and
configured-sensitive-path checks before the outside-repository mutation rule.

Regression coverage includes ordinary external reads, credential reads inside and outside the
repository, a symlink to a credential, and configured sensitive reads in a trusted workspace.
Existing external-write tests retain the approval boundary. This also closes the inconsistent
allowance of an in-repository `.npmrc` tool read.

No command-name exception, approval grant, or runtime harvest allowlist is added. Dynamic scripts,
upgrade loops, and publication workflows remain outside this read-only increment.

## Remaining exit work

Issue #72's original 20-event / 5% raw would-block criterion is historical. The implemented
criterion is at least 150 reviewed provably-benign events across three valid session correlations,
benign block rate below 2%, zero active-cohort availability asks, and passing corpus hard gates.
See [per-target evidence](./dogfood-install-targets.md#per-target-readiness-evidence).

Collect normal development traffic after the corrected runtime is installed and review actual
effects. Preserve separate runtime/config/boundary cohorts and per-target evidence. Neither old
logs, simulated reclassification, nor synthetic sessions satisfy the fresh-cohort exit.
Publication, target upgrades, and enforce activation are not performed by this change.

## Local validation

Node 22.17.0: build and typecheck passed; lint passed with 15 existing warnings and one
informational diagnostic. The final `pnpm test:run --maxWorkers=2` run passed all 198 test files
(2,948 tests passed, two skipped). Default parallelism initially caused timeout/lock-contention
failures; the final run retained the original timeouts. Corpus remained 96/96 with zero hard-gate
misses or blocks. Independent review reported no blocking or important findings.
