# Mvdan Shell compatibility probe result

## Terminal status

**FAIL — production migration stopped**

`sh-syntax@0.6.0` parsed 309 of 310 unique inputs, but its public DTO does not retain the
concrete command kinds, child structure, or word-part kinds required by Belay's parser-neutral
contract. All 310 inputs therefore projected to `partial`; no input qualified as a complete
candidate program. Parse success is not contract compatibility.

The design's exit criteria are conjunctive. Required syntax projection, fresh-process cold latency,
and supported-platform offline coverage failed. The pinned Go/Wasm bridge, production parser
artifact, and rollout work must not begin under the current design.

## Probe scope

| Field | Value |
| --- | --- |
| Probe date | 2026-09-21 |
| Repository commit | `5fc2f17319587b84a9f19379774fee32f352e607` |
| Corpus SHA-256 | `15b8b0173153cdc066ad998fd2070454fef2f8438bee8bfba86c95537bcbfb44` |
| Host | macOS 26.5.1 / Darwin 25.5.0 / arm64 |
| Node.js | `v22.22.3` |
| Shell variant | Bash default; `recoverErrors: 0` |
| Retained evidence | This redacted aggregate document only |

The executable harness, isolated lockfile, raw case records, AST responses, and timing samples were
created in a mode-0700 OS temporary directory outside the repository and removed after redaction.

## Parser identity

| Field | Value |
| --- | --- |
| `sh-syntax` | `0.6.0` |
| npm integrity | `sha512-52VK6z/cdZHv7UURjIcwfBUQZrAhIEEe0bY4lrkfypjnFIKsDZdD3Uaz/dBiw/sF8BeX0Mssv140s8EnrsJ9dQ==` |
| Annotated tag object | `12510c789319c9f724290f2633324c78a7fc4b94` |
| Tag commit | `d5a8e66beead01fb388db7de39f3d61960404c66` |
| Underlying parser | `mvdan.cc/sh/v3 v3.13.1` |
| Upstream `go.mod` SHA-256 | `a858005dbd69c0a4c0b82d6ff04f4000074772e078a7c05f88602ca509a40dfb` |
| Wasm SHA-256 | `334d4e636ce92da6d227c48fe1ab6a2f0837a1862ea2babde478ca53a2c2d89d` |

The npm lockfile, installed package metadata, npm registry integrity, immutable tag commit, and
tagged `go.mod` agreed on these identities.

## Input matrix

| Suite | Cases |
| --- | ---: |
| Corpus | 100 |
| Structural | 140 |
| Adversarial | 92 |
| Reviewed dogfood-derived | 16 |
| Required-feature matrix | 18 |
| **Unique inputs after deduplication** | **310** |

Suite counts overlap intentionally. Dogfood-derived cases are the reviewed
`provenance.source: harvest` subset of the corpus, and generated cases can also coincide with corpus
or feature inputs. Counts are preserved by suite while the execution set is deduplicated by command
SHA-256.

## Parse and projection results

Overall results:

| Outcome | Count |
| --- | ---: |
| Parse success | 309 |
| Parse failure | 1 |
| Complete projection | 0 |
| Partial projection | 310 |
| `unsupported_node` | 309 |
| `invalid_syntax` | 1 |
| Silently dropped node | 0 |

Required-feature results:

| Feature set | Cases | Parse success | Partial | Failure |
| --- | ---: | ---: | ---: | ---: |
| `command`, `literal`, `assignment`, `quoted`, `parameter_expansion` | 5 labels / 2 inputs | 5 | 5 | 0 |
| `arithmetic_expansion`, `command_substitution`, `process_substitution` | 3 | 3 | 3 | 0 |
| `redirect`, `heredoc` | 2 | 2 | 2 | 0 |
| `pipeline`, `and_or`, `sequence` | 3 | 3 | 3 | 0 |
| `subshell`, `brace_group` | 2 | 2 | 2 | 0 |
| `if`, `loop`, `case`, `function` | 4 | 4 | 4 | 0 |
| `utf8_span` | 1 | 1 | 1 | 0 |
| `invalid_syntax` | 1 | 0 | 1 | 1 |

The feature table counts labels; some inputs exercise more than one label. Every valid feature input
parsed, but every one remained partial because the DTO could not prove the structure it represented.

## AST information gap

Belay requires concrete command kinds and children, ordered word-part kinds and payloads,
assignments and words, redirect targets and heredoc expansion metadata, nested substitutions and
control structures, and valid UTF-8 byte spans.

The observed DTO was missing:

- `Stmt.Cmd.kind`
- `Stmt.Cmd.payload`
- `Redirect.Word.Parts.kind`

In `sh-syntax@0.6.0`, command nodes and word parts are reduced to positional data by the public DTO
mapper. Positions alone cannot distinguish simple commands, pipelines, substitutions, control
structures, quoting, parameters, or arithmetic. The probe emitted explicit `unsupported` nodes and
never reconstructed missing syntax from source text, regexes, printing, or the legacy parser.

## EffectPlan comparison

Semantic comparison and failure-path validation are reported separately:

| Comparison | Equal | Candidate stricter | Candidate looser | Not comparable |
| --- | ---: | ---: | ---: | ---: |
| Candidate semantic lowering | 0 | 0 | 0 | 310 |
| Fail-closed disposition | 204 | 106 | 0 | 0 |

No standalone candidate EffectPlan could be produced because the AST contract was incomplete.
Labeling the legacy EffectPlan as candidate output would have created false parity. Instead, the
probe appended `parser.disagreement` and an indeterminate requirement to the legacy plan solely to
validate the failure path. That path retained every legacy authorization requirement; merged
indeterminate requirements retained the legacy signal set and added the disagreement signal.

| Candidate-looser status | Count | Disposition |
| --- | ---: | --- |
| Observed | 0 | No cases to disposition |
| Unresolved | 0 | Gate passes |

Zero candidate-looser findings does not offset the missing semantic comparison: all 310 semantic
cases remain not comparable, which independently fails the probe.

## Failure behavior

| Injected condition | Diagnostic | Permission |
| --- | --- | --- |
| Missing Wasm artifact | `artifact_unavailable` | ask |
| Corrupt Wasm artifact | `artifact_mismatch` | ask |
| Malformed adapter response | `bridge_protocol_error` | ask |
| Parser timeout | `parser_timeout` | ask |
| Invalid UTF-8 byte span | `invalid_span` | ask |
| Node limit exceeded | `node_limit` | ask |
| Depth limit exceeded | `depth_limit` | ask |

The installed Wasm artifact loaded successfully. All seven injected failures produced a partial
program plus an indeterminate ask disposition. Artifact/protocol failure produced **0 allows**.

## Latency

Warm measurement used five unrecorded warm-ups, followed by the 310 unique inputs. Each recorded
sample covered parse, projection, fail-closed EffectPlan construction, and policy evaluation.

| Distribution | Samples | p50 | p95 | Max | Gate | Result |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| Warm full gate | 310 | 9.03 ms | 59.73 ms | 216.37 ms | p95 < 100 ms; max < 500 ms | PASS |
| Fresh-process cold | 20 | 255.69 ms | 617.11 ms | 717.17 ms | max < 500 ms | **FAIL** |

Cold measurements included Node process startup, first module/Wasm load, projection, fail-closed
plan construction, and policy evaluation. All 20 children returned valid output and none timed out.

## Offline loading

| Platform | Node | Local load | Network attempts | Result |
| --- | --- | --- | ---: | --- |
| macOS arm64 | 22.22.3 | Successful | 0 | PASS on observed host |
| macOS x64 | Not measured | Not measured | — | **FAIL: missing evidence** |
| Linux x64 | Not measured | Not measured | — | **FAIL: missing evidence** |

The observed host replaced userland `fetch`, HTTP(S), TCP, TLS, and DNS entry points before import;
the local artifact loaded without invoking them. This is instrumented offline evidence, not
OS-enforced network isolation. Supported-platform coverage is incomplete and therefore fails the
conjunctive gate.

## Package and bundle impact

| Measurement | Bytes |
| --- | ---: |
| npm tarball | 278,824 |
| npm unpacked package | 793,650 |
| `main.wasm` | 734,403 |
| Projected minimum parser payload | 755,585 |
| Current generated hook/runtime bundles | 2,798,713 |
| Actual repository bundle delta | 0 |

The installed package contained 23 files. The projected payload includes `main.wasm`, the Go Wasm
runtime shim, and the runtime JavaScript modules needed by the package; it is an estimate, not a
measured production bundle. It is approximately 27.0% of the current aggregate generated bundle
size. The actual delta is zero because the probe changed no repository dependency or runtime
artifact.

## Exit criteria

| Criterion | Evidence | Result |
| --- | --- | --- |
| Every required syntax category projects without silently dropped nodes | 0 dropped, but 0/310 complete; concrete node and word-part information missing | **FAIL** |
| Parse/projection failures become partial and indeterminate | 310/310 partial; all injected failures ask | PASS |
| Unresolved `candidate_looser` is zero | 0 | PASS |
| Artifact/protocol failures never allow | 0 allows across seven injected failures | PASS |
| Warm full-gate p95 < 100 ms and max < 500 ms | p95 59.73 ms; max 216.37 ms | PASS |
| Fresh-process cold max < 500 ms | max 717.17 ms | **FAIL** |
| Offline artifact load on supported platforms | macOS arm64 only; macOS x64 and Linux x64 unmeasured | **FAIL** |

## Decision and next permitted action

The compatibility probe is **FAIL**. Production migration is stopped. Do not add the pinned Go/Wasm
bridge, parser artifacts, production frontend, shared lowering changes, or rollout modes under the
current decision.

The next permitted action is a new design decision that either obtains a lossless upstream AST DTO
or replaces the disposable adapter strategy while preserving the same fail-closed and performance
criteria. Any revised design requires a new compatibility probe and a PASS before production
dependencies or artifacts are introduced. Threshold relaxation and automatic parser substitution
remain prohibited.
