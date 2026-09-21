# Trusted effect manifests

Effect manifests let an operator describe a complete upper bound for one otherwise unknown
executable invocation. They are semantic decoder input, not an allowlist: every instantiated
effect still goes through the normal `EffectPlan` and `PolicyEngine` rules.

## Safe workflow

```bash
# Candidate generation is offline and never executes the target.
belay manifest infer -- /absolute/path/to/ctx status

# Inspect and validate the exact executable, matcher, and effect contract.
belay manifest show ctx
belay manifest validate ctx

# Edit .belay/manifests/ctx.json until the contract is a complete upper bound.
# Keep an indeterminate effect when completeness cannot be established.

# Trust one reviewed rule. This is a reusable completeness assertion, not approval of one run.
belay manifest trust /absolute/path/to/ctx --rule argv-92a1c4e09b35

# Remove only that rule's authority.
belay manifest revoke /absolute/path/to/ctx --rule argv-92a1c4e09b35
```

`infer --llm -- …` may ask the already configured judge provider to draft an effect contract. It
is the only inference mode that performs provider I/O. Inputs use the existing outbound scrubber
and size limits; output must match the closed effect-contract schema. Model output remains an
untrusted candidate and can never create trust. The provider must expose a configured text-only
HTTP endpoint (including local Ollama); native agent CLIs are rejected because their tool access
cannot satisfy the inferencer's static-source boundary.

## Identity and storage

- Candidate documents are repository-local at `.belay/manifests/<basename>.json`, mode `0600`.
- Rule trust is always stored in the configured user control-plane directory under
  `effect-manifest-trust/`, even when general control-plane approval storage is disabled.
- Trust binds the canonical checkout root, canonical executable path and SHA-256, script
  interpreter path and SHA-256 when applicable, fallback, matcher, contract, and assertion.
- Gate application requires a literal path-qualified executable head. A bare command name remains
  ineligible because a shell function or alias can shadow the executable found through `PATH`.
  `infer` may resolve a bare name to draft a candidate, but that does not make bare runtime
  invocations eligible.
- A changed executable, interpreter, matcher, or contract is stale and stays indeterminate until
  it is reviewed and trusted again.
- Agent-shell `manifest trust` and `manifest revoke` are `control_plane.write` operations and
  require human approval.

Files use bounded, strict JSON parsing: duplicate keys, invalid UTF-8, unknown fields, non-NFC
strings, oversized documents, and malformed nested values are rejected. Trust writes are atomic
and fsynced.

## Matcher and resource templates

Matchers consume the complete argv vector after the executable. They are case-sensitive and have
no regex, optional, repeated, prefix, or suffix form. Available elements are `literal`, `enum`,
`path`, `host`, bounded `integer`, and `token`. Capture names are unique; every capture must be used
by an effect resource. A `token` capture must follow a literal so it cannot mean “every invocation.”
Overlapping rules invalidate the complete manifest rather than selecting by order.

Resource captures use `${name}`. Typed fields must use the corresponding capture type: `path` and
`repoPath` use `path`, `host` uses `host`, `port` uses `integer`, and ref fields use a bounded
`token` or `enum`. Nested executables and control-plane paths must remain static. Relative path
results are resolved against that shell segment's action working directory; `~` and `~/...`
results are resolved against the user home directory. Ordinary workspace, secret, outside-path,
and high-stakes policy runs afterward.

Example:

```json
{
  "id": "write-target",
  "matcher": {
    "argv": [
      { "kind": "literal", "value": "write" },
      { "kind": "path", "name": "target" }
    ]
  },
  "contract": {
    "processOperation": "inspect",
    "effects": [
      {
        "tag": "fs.write",
        "action": "fs.write",
        "resource": { "kind": "path", "path": "${target}" }
      }
    ]
  },
  "assertion": "complete-upper-bound",
  "inference": {
    "method": "manual",
    "generatedAt": "2026-09-19T00:00:00.000Z",
    "generatorVersion": "operator",
    "evidence": [],
    "warnings": []
  }
}
```

## Failure and frontend behavior

Only the exact generic `process.grammar_unknown` pair from a complete frontend segment is eligible.
Built-in decoders always win. Missing, malformed, stale, untrusted, ambiguous, unmatched,
deadline-exceeded, parser-partial, or comparator-disagreement cases retain the original
indeterminate effect.

Trusted rules are active by their presence; there is no configuration switch. Legacy frontend
lowering consumes them directly. Until the separately pinned mvdan artifact is shipped, mvdan mode
remains fail-closed and shadow mode never relabels legacy output as an mvdan candidate. `show`,
`validate`, `explain`, and `doctor` expose bounded trust, identity, match, or fallback status.

If you cannot assert a reusable complete upper bound, leave `indeterminate` in the candidate and
use a one-shot approval or independently verified contained execution instead.
