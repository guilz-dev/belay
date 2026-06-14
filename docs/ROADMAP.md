# Belay Roadmap

Status: **Directional** (themes and horizons, not committed dates)
Authoritative concept: [`CONCEPT.md`](./CONCEPT.md) · Architecture decision: [`adr/ADR-001-layered-enforcement.md`](./adr/ADR-001-layered-enforcement.md) · Conformance discipline: [`adr/ADR-002-concept-conformance.md`](./adr/ADR-002-concept-conformance.md)

> The near-term *execution order* lives in [`CONCEPT.md` §12](./CONCEPT.md),
> which deliberately commits only to "the next one." This document is the layer above that: the
> mission, the dials we turn to reach it, and the directional horizons. It does
> not promise version numbers or dates.

---

## Mission

**Free people from approvals they never needed, while keeping their agents safe.**

A developer running an agent in YOLO mode faces a binary choice today: confirm
everything (≈98% of it is noise) or confirm nothing (and hope). Belay's reason to
exist is the missing middle — **stay silent on everything reversible, stop only
the irreversible-and-catastrophic.** Every unit of progress on this roadmap is
measured against that one sentence.

Two failure modes, and they are not equal:

- **A missed catastrophe (false negative)** drops the user back to the YOLO
  baseline — but if they trusted Belay and pushed harder *because* it was there,
  the cost is unbounded. This is the line we never trade away.
- **An unnecessary approval (false positive)** is friction. Enough of it and the
  user disables the gate — at which point Belay's protection is zero. So a false
  positive is not just a UX papercut; it is a **concept violation** (ADR-002 M2).

The mission therefore has a hard invariant and a relentless optimization target:

> **Invariant:** never let an irreversible × catastrophic action through silently.
> **Target:** drive every *other* interruption toward zero.

---

## The two dials

Reaching the mission means turning two dials at once, without ever sacrificing the
invariant for either.

### Dial 1 — Precision (ask less, miss nothing)

Make the verdict sharper so the floor stops exactly the irreversible handful and
nothing else.

- Shrink **false positives**: reads, listings, payload-less GETs, and undoable
  local edits must pass silently. (`describe` / `list` / `get` classes; reversible
  repo mutations.)
- Shrink **false negatives** to a *named, measured, backstopped* residual — never
  to "we think it's fine." Chains, substitutions, wrappers, interpreters, and path
  tricks must not smuggle a catastrophe past the tokenizer.
- Make "reversible" **literally true** rather than assumed, by giving the judgment
  a real substrate to point at (snapshots), so more actions can be *proven*
  recoverable and therefore allowed.

### Dial 2 — Coverage (one floor, many channels)

Be present wherever an agent can take an irreversible action, across the products
people actually use — without the floor's behavior fragmenting per integration.

- More **runtimes/adapters** (Cursor, Claude Code today → Codex → a generic
  adapter SDK and MCP-level gating) so the same floor rides under many products.
- More **action channels** behind one shared classifier (shell, subagent, file
  mutation, tool-use, network egress) so coverage is uniform, not per-adapter.
- A **gate contract + conformance suite** so every channel and adapter is held to
  the same MUST-ASK / MUST-ALLOW behavior — breadth that does not dilute the
  guarantee.

The dials interact: every new channel (Dial 2) is a new surface that must meet the
precision bar (Dial 1) before it ships. Coverage without precision is just a
louder denylist.

---

## How we measure progress

Progress is not "features shipped" but movement on three numbers, in priority
order (the asymmetry from [`CONCEPT.md` §11](./CONCEPT.md)):

| Metric | Target | Gate |
|--------|--------|------|
| **False negatives** on the adversarial corpus | **0** | Hard CI gate. A regression blocks release. |
| **False positives** on the benign/recoverable corpus | **0** | Hard CI gate (ADR-002 M2 — equal to FN). |
| **Silent-pass rate** in real dogfood | trends to ~98% | Tracked; a drop is an early signal of fence-ification. |

Honest ceiling: zero false negatives is **not provable in principle** (Rice). A
horizon is "done" not when the number is proven perfect, but when the residual is
named, measured small, backstopped, and documented against overconfidence.

---

## Horizons

Directional, not dated. Each horizon is shippable the day its first step lands —
no steps that don't run, no optimization nobody uses.

### Horizon 0 — A floor you can trust (now)

*Make the single shared floor genuinely safe on the supported runtimes before
widening anything.*

- **Close the largest false-negative hole (H1):** tokenizer splits chains
  (`a && b`), pipes, sequences, command substitution `$(...)`, backticks, and
  subshells; verdict per segment; unparseable → ask.
- **Adversarial corpus + eval harness as a hard FN=0 CI gate**, grown from real
  traces (bypass + catastrophe + mundane).
- **MUST-ALLOW corpus as an equal hard gate** (ADR-002 M2): one benign ask fails CI.
- **Audit-mode dogfood** to seed both corpora from the real distribution.

*Exit:* adversarial FN=0 and benign FP=0 both enforced in CI; a dogfood stretch
with no regretted miss and few enough asks to keep enforce mode on.

### Horizon 1 — Precision you can feel (next)

*Turn Dial 1: convert "assumed reversible" into "proven reversible," and stop
re-asking what a human already blessed.*

- **L2 substrate (git-worktree / CoW snapshots)** so "restorable" is literally
  true, not assumed — the foundation that lets more actions be allowed safely.
- **Approval cache** so a first ask on a recurring describe-class action becomes a
  standing allow (first ask → register → pass through).
- **Tier1 judge improvements** — prompt/model calibration to erase residual
  read-class false positives without touching the FN line.
- **Latency budget** kept invisible (prewarm, keep-alive) so precision never costs
  perceptible delay.

*Exit:* measured silent-pass approaching ~98% with FP near zero and **no FN
regression**; the H4/H5 residuals from CONCEPT §10 measurably shrunk.

### Horizon 2 — Many channels, one floor (next/later)

*Turn Dial 2: be usable under the diverse products people work in, with uniform
behavior.*

- **Codex adapter to parity**, then a **generic adapter SDK** and **MCP-level
  gating** so third parties integrate without forking the floor.
- **Uniform channel coverage** (shell, subagent, file mutation, tool-use, egress)
  behind the one classifier.
- **Gate contract + per-adapter conformance suite** so every integration is held
  to the same MUST-ASK / MUST-ALLOW corpus.

*Exit:* multiple adapters pass an identical conformance suite via the shared gate
contract; adding a runtime does not change verdict behavior.

### Horizon 3 — Boundary, not just guardrail (vision)

*Where the floor stops being a prediction and becomes containment a user can put
their weight on (ADR-001 L1-full).*

- **L1 containment**: egress deny-all choke point + sandbox capability broker, so a
  miss in any list is *friction* (ask a human), not a breach.
- **L2 transactional everywhere** + **signed out-of-band approvals** + control-plane
  separation for the same-OS-user threat.
- **Per-layer guarantee table** in [`SECURITY.md`](../SECURITY.md): state honestly
  what each layer does and does not promise, including residual covert channels.

*Exit:* a documented, per-layer guarantee; the `l1-full-recommended` preset offers
a weight-bearing boundary, not a best-effort guess.

---

## Non-goals (carried from the concept)

These stay out of scope on purpose — chasing them would betray the mission by
turning the floor back into a fence:

- **Containing genuinely adversarial agents** by prediction. That is OS-sandbox
  territory; only the L1-full stack (Horizon 3) addresses it, and even then with
  named residual risk.
- **A comprehensive safety boundary from command text.** Predicting every command
  correctly is impossible in principle (Rice). We split prediction into
  deterministic structure (Tier0) + non-enumerable semantics (Tier1) and put a
  human at L4 — we do not pretend the list is the wall.
- **Stopping merely "dangerous-looking" but reversible work.** If it can be undone,
  it passes. Anything else is a denylist wearing Belay's name (ADR-002 §6).

---

## Mapping to ADR-001 layers

| Layer | Role | Roadmap home |
|-------|------|--------------|
| **L4** Human approval | final backstop for residual uncertainty | Done (reused); refined in H3 (OOB signed) |
| **L3** Prediction | noise reduction, not a boundary | Rebuilt as Tier0+Tier1 in H0; sharpened in H1 |
| **L2** Observation | judge on measured snapshots | H1 (substrate) → H3 (transactional everywhere) |
| **L1** Containment | deny-all egress/sandbox boundary | H3 |

Belay today is "L3+L4 done right." The roadmap is the disciplined walk from a
trustworthy *guardrail* (H0) to a measurably precise one (H1), spread across the
products people use (H2), and finally to a *boundary* the user can lean on (H3) —
without ever, at any horizon, letting an irreversible catastrophe through to buy
any of it.
