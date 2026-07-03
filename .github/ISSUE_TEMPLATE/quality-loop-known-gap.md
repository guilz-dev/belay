---
name: Quality loop known gap
description: Defer a recurring quality-loop failure when fix cost exceeds phase budget.
title: "[quality-loop-known-gap] "
labels: []
body:
  - type: markdown
    attributes:
      value: |
        Use when the same FN/FP pattern recurs and a full fix is deferred.
        `belay simulate` is triage-only — not a merge gate.
  - type: input
    id: batchId
    attributes:
      label: batchId
    validations:
      required: true
  - type: input
    id: seed
    attributes:
      label: seed
    validations:
      required: true
  - type: textarea
    id: failure_summary
    attributes:
      label: failure summary
      description: mutator, command, expected, actual, reason
    validations:
      required: true
  - type: textarea
    id: why_deferred
    attributes:
      label: why deferred
      description: Why is a full fix out of scope for this phase?
    validations:
      required: true
  - type: textarea
    id: risk
    attributes:
      label: risk
      description: What FN/FP risk remains while deferred?
    validations:
      required: true
  - type: input
    id: next_review_date
    attributes:
      label: next review date
      placeholder: YYYY-MM-DD
    validations:
      required: true
  - type: textarea
    id: reproduction
    attributes:
      label: reproduction steps
      value: |
        pnpm probe:adversarial --strict --seed <seed> --max-cases 200
    validations:
      required: true
