# ADR-002 — Concept conformance: every rule serves the restorability floor

Status: Accepted (binding operational discipline)
Date: 2026-06-13
Context: Triggered by the egress over-blocking (v2.1.3), to prevent the recurring
problem of code drifting away from the concept.

> English translation of [`ADR-002-concept-conformance.ja.md`](./ADR-002-concept-conformance.ja.md). The Japanese file is authoritative if the two diverge.

---

## 1. What happened (incident pattern)

belay's concept is the **restorability floor**:
> "If it can be undone, let it through. Stop only the **irreversible × catastrophic**.
> Stay silent on 98%. It is not a fence."

Despite that, **rules that contradict the concept had accumulated** in the code:

- `curl https://example.com` (a harmless GET) was set to ask — even though it
  changes nothing, sends nothing, and leaves nothing to undo.
- `aws s3 ls` / `gh pr list` / `kubectl get` were set to ask too — treating whole
  tools as external (a fence).
- These "stop a tool" (fence), they do not "stop an irreversible act" (floor).

And the responses kept sliding into **symptom patches** (v2.1.2 = false negative,
v2.1.3 = false positive) without asking "**why do we drift every time?**"

## 2. Root cause

1. **The concept is not enforced as a contract.** [CONCEPT.md](../CONCEPT.md) exists as prose,
   but there is **no mechanism to verify that the code's rules conform to it**.
2. **Tests only guard against FN.** The structural suite firmly holds "never miss
   a catastrophe (MUST-ASK)" but did not hold "**never stop the recoverable
   (MUST-ALLOW)**" as an equal → **fence-ification (false positives) is invisible
   to the tests.**
3. **Rules had no justification.** When `curl`/`aws` were added to
   `TIER0_EXTERNAL_KEYS`, nobody asked "is this irreversible × catastrophic?"
4. **Old rules were not audited at redefinition time.** When the v0.7 "egress
   choke point (fence)" was rebuilt into the v2.0 "restorability floor,"
   contradictory old rules were not pruned.
5. **Contributors (including AI) reasoned from symptoms.** They locally patched
   the bug in front of them instead of starting from the concept (in this very
   session the AI itself once tolerated a blanket egress ask for the same reason).

## 3. The single rule (invariant)

What belay builds is **this one decision rule**, and all code/specs serve it:

> **If this operation turned out to be a "mistake," can it be undone?**
> - Can be undone (or changes nothing) → **let it through.**
> - Cannot be undone **and** catastrophic → **ask.**
> - The judgment is ambiguous → Tier1 (fail-closed = ask).

A rule that stops something for any other reason is **by definition a fence, and
not belay.**

---

## 4. Preventive measures (binding)

### M1 — State the concept as a single decision rule and justify every Tier0 rule by it
- Place the §3 decision rule in [CONCEPT.md](../CONCEPT.md) as the **single source of truth**.
- Every Tier0 deterministic rule must be a consequence of that rule.

### M2 — Make MUST-ALLOW a hard gate, equal to MUST-ASK (most important)
- Promote the structural suite's `MUST-ALLOW` to a **hard CI gate** equal to the
  FN gate.
- If the benign/recoverable corpus (reads, listings, payload-less GETs,
  undoable local operations) is **asked even once, CI fails.** This makes
  fence-ification (false positives) as visible and unavoidable as FN.
- **Symmetry**: FN=0 (never miss a catastrophe) and FP→0 (never stop the
  recoverable) are **two wheels of the same axle.** belay's value is the
  **narrowness of what it stops**, so a FP is not merely a UX issue — it is a
  **concept violation.**

### M3 — Require a justification for every Tier0 rule
- Any new rule added to a Tier0 list/branch must **justify in one line "why it is
  irreversible × catastrophic"** (in a comment or the spec).
- A rule that cannot be justified does not belong in Tier0 (→ delete it, or
  delegate to Tier1 = fail-closed).
- Pair each Tier0 rule with a **MUST-ALLOW counter-example** (a nearby benign case
  showing it does not over-stop), added to the M2 corpus.

### M4 — A concept review gate on specs/PRs
- New requirements/rules must explicitly answer, at review:
  - [ ] Does this **stop a recoverable operation**? (If so, the design is wrong.)
  - [ ] Is the basis for stopping "**irreversible × catastrophic**"? (Not by tool
    name or category?)
  - [ ] Do ambiguous cases fall to Tier1 (fail-closed)?
  - [ ] Did you add tests to **both** MUST-ALLOW and MUST-ASK?

### M5 — Require a full rule audit when the concept is redefined
- When the concept/design is rebuilt (as in v0.7 → v2.0), **re-examine all
  existing rules under the new concept and prune contradictions** as a mandatory
  work item. The leftover egress rules this time were caused by the missing audit.

### M6 — Measure "it is not a fence"
- Surface and track the silent-pass rate / false-positive rate in dogfood.
  Periodically confirm the "98% silent" claim has not eroded in measurement (the
  egress over-asking should have been caught early here).

### M7 — Contributor discipline (including AI)
- Reason about a bug **from the concept, not from the symptom**. Articulate "which
  consequence of the concept is this fix" before writing it. A change that cannot
  be explained against the concept does not ship.

---

## 5. First application

- The **v2.1.3 egress over-block fix** is the first application of M2/M3. The
  three-way split (read → allow / mutate · exfil → ask / unknown → Tier1) plus
  the MUST-ALLOW/MUST-ASK paired test series *is* the discipline of this ADR.
- During implementation, **make M2 (the MUST-ALLOW hard gate) permanent in the
  structural suite**, so that every future Tier0 change passes through this
  two-wheel gate.

## 6. In one line

**What belay builds is "a floor that stops only the irreversible × catastrophic."
Stop anything else and it is not belay — it is a denylist.** Every rule, spec, and
fix must be explainable by that one sentence, or it does not ship.
