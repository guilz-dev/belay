# agent-belay CONCEPT v2.0 — belay redesign: the restorability floor

Status: **Current concept; prototype history retained for rationale**
Based on: working spike at `~/.belay-spike/` (`verdict.mjs` / `hook.mjs` / `warm.mjs`)
Intellectual lineage: the original design exploration with Opus (storyline), [`docs/adr/ADR-001-layered-enforcement.md`](./adr/ADR-001-layered-enforcement.md)
Positioning: the normalized-shell authority is now the canonical
`EffectPlan` → PolicyEngine projection defined by
[ADR-004](./adr/ADR-004-effectplan-shell-authority.md). Prototype-era Tier0/Tier1 notes
below are historical rationale, not a second runtime authority.

> Japanese translation: [`CONCEPT.ja.md`](./CONCEPT.ja.md). **This file is authoritative** if the two diverge.

---

## 1. What this is (the concept)

belay is a **restorability floor — a minefield line — for agents running in YOLO mode**.

It lets through ~98% of confirmations and stops only **the handful of operations that, if wrong, cannot be undone**.
It does not aim for completeness. Misses fall back to the YOLO baseline — no worse than that.
False positives are pushed as close to zero as possible.

The climbing belay metaphor itself — the climber moves freely (no fence constraining motion).
The rope catches only on a fall. Because a fall is survivable, they can climb boldly.

### One axis of judgment — restorability

The question is not “is this dangerous?” but only “**if this were a mistake, could it be undone?**”

- Merge on red tests / sloppy commits / delete files inside the repo → undoable → **allow**
- `drop db` / `git push --force` / production deploy / persistent secrets & agent config → not undoable → **block (hand to a human)**
- Repository/workspace-local reversible edits → **allow_flagged**
- Repo-outside edits → **ask**, unless the path is part of the same proven Git common-dir
  identity or an explicit trusted workspace root

This is the destination of storyline §212. “Is it dangerous?” lives only in subjective human judgment,
but “can it be undone?” is largely objective — decidable from the nature of the action and environment.

### Non-goals

- Containing adversarial agents (OS sandbox territory; ADR-001 L1 full version / future)
- A comprehensive safety boundary (correctly predicting every command is impossible in principle = Rice)
- Making static denylists / whitelists the safety boundary (lists break; they are a starting point, not the wall)
- **Command allowlists as remediation** — including legacy `overrides.allow` / `overrides.external`.
  If the fix is “add it to a list,” the fix is wrong. See
  [ADR-005](./adr/ADR-005-command-allowlist-prohibition.md).

---

## 2. Threat model / target user

- **Target: cooperative but overreaching agents.** No malice, but completion pressure or misunderstanding leads them toward irreversible operations like `drop db`.
- **Target user: developers running pre-production products in YOLO at their own discretion.** ~98% of confirmations are noise they do not want. But they want the irreversible handful stopped. Day-to-day production / multi-person workflows are out of scope — those need confirmation by design.
- Native confirmation is binary (confirm everything = 98% noise / YOLO = zero net). The **middle**
  (YOLO + thin catastrophe guard) is belay’s distinctive slot.

---

## 3. Architecture — one normalized effect authority

`verdict(command, cwd, repoRoot)` returns `allow` or `ask`.
Every normalized shell segment contributes requirements to one canonical `EffectPlan`.
Policy evaluates those effects without consulting runtime command allow/deny lists.

```
verdict(command, cwd, repoRoot):

  parse / recursively lower every shell segment
    → canonical EffectPlan
    → PolicyEngine over operation + resource + payload + evidence
    → strictest requirement wins

  payload-free network read / process inspect / ordinary fs read → allow
  repo/workspace-local reversible mutation                    → allow_flagged
  external mutation / explicit payload or secret send         → ask
  high-stakes / destructive Git / partial or indeterminate    → ask
```

Command names select grammar decoders only; they do not decide allow/ask. `git fetch` and
`git pull` lower to a payload-free network read plus reversible local updates and are
`allow_flagged`; `git push` is remote mutation and asks. Linked worktrees are local only
when their canonical Git common directory matches.

**Layer note (ADR-001):** L3+L4 is a cooperative policy/approval layer. **L1-full**
adds a separate OS boundary. Boundary resource scopes and exact grants are not shell
allowlists and do not replace the EffectPlan projection. See
[`docs/guarantee-table.md`](./guarantee-table.md).

### Why deterministic structure remains necessary

| Detector | Responsibility | Why (measured rationale) |
|---|---|---|
| **Semantic lowering** | Git/egress/process/launcher grammar and resources | LLM previously rationalized `git push --force`; documented operation semantics must be deterministic |
| **Effect policy** | operation/resource/payload/evidence disposition | One policy conjunction prevents command-name exceptions from becoming authority |
| **Indeterminate fallback** | unsupported or partial grammar | Known effects are retained and an explicit indeterminate requirement forces ask |

The LLM judge is asynchronous shadow evidence only. It cannot change the synchronous gate
decision.

### Historical Tier1 prompt lesson

Compound questions give the model room to rationalize (force push slipped through as “git is undoable; assume remote away”).
This motivated deterministic EffectPlan lowering. Any shadow judge still receives structured
facts rather than a vague danger score:

> Assess whether a mistaken run could be undone **locally** (filesystem/git snapshots, re-download, re-create).
> Flag `destroys_history_or_secrets` for `.git` deletion, credential paths, shell startup files, crontab/launchd, etc.
> Reading or querying an external system does NOT change local state. If unsure about recoverability, mark not recoverable.

Shadow output is audit-only. Legacy judge records remain readable for compatibility.

---

## 4. Historical prototype: why a local LLM was evaluated

- **Zero egress** — belay stops external effects; sending full command text to the cloud per verdict is self-defeating. Local keeps verdicts on-machine
- **Privacy** — shell commands carry secrets, paths, infra detail
- **Zero cost, no API key, Apache 2.0** — gemma4:e2b (effective 2B, ~1.7GB, on-device)
- **Latency** — warm ~1s, cold ~18s. Prewarm on `beforeSubmitPrompt` + `keep_alive` to stay warm. Tier1 only for the minority in the open region (git/fs instant via Tier0)

The judge is **separate** from the executing agent (no shared incentive). Measurement showed independent judges still rationalize if the question is vague — fix is not “different model” alone but **flat factual decomposition + deterministic structure**.

---

## 5. Operating modes and audit

- **audit mode:** compute the EffectPlan verdict, record it, and return `allow` (do not block).
  Collect real-distribution dogfood data risk-free
- **enforce mode:** when the floor says `ask`, show Cursor’s approval dialog
- Toggle: `~/.belay-spike/mode` with `enforce` / `audit` (config in production implementation)

### trace (ndjson, every verdict)

```json
{ "ts", "mode", "commandRedacted", "commandFingerprint", "cwd", "repoRoot",
  "would", "effectPlanHash", "effectPlanCompleteness", "reason" }
```

`would` is what the floor said (recorded even in audit). Foundation for victory condition stage 2 (real-distribution measurement) and calibrating claimed vs actual gaps (storyline’s “honest holes”).

### Approval loop (reused from existing belay)

`ask` → human `/belay-approve <id>` grants one-shot/resource-scoped authorization
(fingerprint, exact request/resource, TTL/use count, optional EffectPlan/request hashes).
Storyline’s layer where **humans accept final uncertainty**. Approval rests on **human knowledge** (this is the test DB, etc.) and **substrate declaration** (config) — not the model (lesson: asking the judge “is there a backup?” invites rationalization).

---

## 6. Context collection (hook responsibility)

Verdict needs the agent’s command `cwd` and `repoRoot`. Hooks are not gated by belay itself, so they gather context and pass it to verdict:

```
cwd      = payload.cwd → payload.workspace_roots[0] → process.cwd()   (priority chain)
repoRoot = walk up from cwd for .git, else cwd
```

Caveat — hook `process.cwd()` may **not match** the agent’s cwd (different process).
Cursor may send `cwd:""` on the sandbox path (measured). Then:
- absolute paths / `~` resolve without cwd
- relative FS mutations **default to ask** (conservative)
- record `cwdFromPayload` in trace to measure cwd supply reliability

---

## 7. Relationship to existing belay code

### Keep (assets)

- **Approval loop** (one-shot / TTL / `/belay-approve` / revoke)
- **trace / audit.ndjson** machinery
- **Hook installer** (`.cursor/hooks.json` merge, runner, node resolution)
- **Skill distribution** (broad entry points)

### Discard (what ADR-001 demoted)

- Static command-list classifiers (`READ_ONLY_COMMANDS` / `FLAGGED_COMMANDS` / `EXTERNAL_COMMANDS`) and v0.3–v0.9 hardening on top (fail-closed list defaults, control-plane hash pin, sandbox broker, four-dimensional judgment, etc.)
- Reason: predictive gate from command names; list gaps = safety gaps.
  This design splits prediction into **structurally certain determinism (Tier0)** and **non-enumerable semantics via local LLM (Tier1)**, taking lists off the safety boundary

### Core replacement

Replace paths calling `classifyShell` etc. with `verdict(command, cwd, repoRoot)`.
Hook I/O, approval, trace, installer ride unchanged.

---

## 8. Mapping to ADR-001 (L1–L4)

| Layer | ADR-001 | Where this design stands |
|---|---|---|
| L4 human approval | final backstop | **implemented (reused)** |
| L3 prediction | noise reduction | **rebuilt** = deterministic shell lowering + EffectPlan policy. LLM is shadow-only; runtime command lists are inert |
| L2 observation (substrate) | measured on snapshots | **not implemented (assumed)** ← §10 holes |
| L1 containment (egress) | deny-all boundary | not implemented (future) |

This design is the stage of “L3+L4 done right (deterministic effects + exact approval).”
“Is it restorable?” is answered **assuming** L2 substrate (git+fs snapshots) exists — that is the next layer.

---

## 9. Historical prototype measurement record

- `permission:"ask"` shows Cursor’s confirmation dialog on real hardware (`sandbox:false` / `true` both)
- gemma4:e2b with operational “reversible” (= undoable via substrate; “backup exists” does not count) + flat factual question correctly marks `drop db` irreversible
- Compound “is it restorable?” **missed** force push as “git so undoable” (false negative)
  → moved git to Tier0; fixed
- 8-command spike 8/8; catastrophe-10 suite 10/10 ask (real Tier1 when warm + safe fallback)
- `aws ec2 describe` false positive removed by flat CHANGE? question
- latency warm ~1s / cold ~18s → mitigated by prewarm
- fixes **did not oscillate** (git to Tier0 landed in one shot) = sign structural decomposition is right

---

## 10. Historical prototype holes (superseded where noted)

| # | Hole | Severity | Current behavior |
|---|---|---|---|
| H1 | Tokenizer does not split **chains `a && b` / command substitution `$(...)` / subshells**. Hidden catastrophe (`ls && dropdb prod`) slips through | **high (false negative)** | Falls back to YOLO baseline only (no worse). **Top priority to close** |
| H2 | **cwd missing** on sandbox path → relative path containment fails | medium | defaults to ask (safe but may raise false positives) |
| H3 | **cold start** → first open-region command hits fallback ask | low | safe side; prewarm mitigates |
| H4 | **residual false negatives in open region** — 2B may allow unknown new external-mutation tools | medium (historical) | Superseded for shell authority: partial/unsupported EffectPlans ask; the LLM is shadow-only |
| H5 | **substrate not implemented (L2)** — “restorable” assumes git+fs snapshots exist but they do not. Tracked git is real; deleting untracked files leans on “regenerable” | medium | git worktree / fs snapshots would make this literally true |
| H6 | Tier1 = 2B can drift | low–medium | structural judgment offloaded to determinism; LLM alone only in open region |

**Overconfidence is the only real danger** — floor misses return to YOLO only (no worse), but pushing YOLO harder because “belay is there” and then missing things is worse. Hence honest documentation (storyline spirit).

---

## 11. Victory conditions (what “works in real use” means)

Asymmetric: false negative = infinite cost (but miss = YOLO baseline only), false positive = friction (too many → disable = zero net). Three stages:

1. **Zero false negatives on adversarial corpus (CI hard gate)** — bypass (chain/substitution/wrapper/interpreter/path trick) + catastrophe + mundane. **Necessary but insufficient** (only tests known hard cases)
2. **Real-distribution dogfood** (weeks, real YOLO work) — zero regretted misses + false positives low enough not to disable.
   **Only way to test unknown unknowns**
3. **Revealed preference** — you keep using it voluntarily. Victory condition for a personal tool

Honest ceiling: zero false negatives is not provable in principle. Victory = “deterministic layer structurally sound + residual (H4) named, measured small, with backstop + misses only revert to YOLO + docs that prevent overconfidence.”

---

## 12. Historical build order

1. **Tier0 tokenizer hardening (H1)** — split on `&& || ; |` and newlines; detect `$(...)` / backticks / subshells. Verdict per segment; unparseable → ask. Closes the largest hole
2. **Adversarial corpus + eval harness** — hard gate false negatives = 0. Grow from real trace
3. **Continue audit dogfood** — measure real-distribution false positives; seed corpus
4. (later) **L2 substrate** (git worktree snapshot) to make “restorable” literally true
5. (superseded) a standing approval cache was considered; current policy instead fixes
   EffectPlan semantics or uses exact one-shot/resource-scoped grants

Each step is “usable the day it ships.” No steps that do not run; no optimizations nobody uses.

---

## Appendix: validated prototype

Working artifacts live at `~/.belay-spike/`:
- `verdict.mjs` — Tier0 + Tier1 + fallback (core of this design)
- `hook.mjs` — Cursor `beforeShellExecution` entry, context collection, trace, audit/enforce
- `warm.mjs` — `beforeSubmitPrompt` prewarm
- `trace.ndjson` — real-distribution record

Production implementation imports this prototype into belay’s structure (approval loop, installer, skills).
