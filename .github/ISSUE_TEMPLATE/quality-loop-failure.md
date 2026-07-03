---
name: Quality loop failure
description: Nightly adversarial probe or manual quality-loop session detected must-ask false negatives.
title: "[quality-loop] "
labels: []
body:
  - type: markdown
    attributes:
      value: |
        Use this template for quality-loop FN detections. `belay simulate` is triage-only — not a merge gate.
  - type: input
    id: batchId
    attributes:
      label: batchId
      description: From artifacts/quality-loop/iteration-*.json
    validations:
      required: true
  - type: input
    id: seed
    attributes:
      label: seed
    validations:
      required: true
  - type: input
    id: mutator
    attributes:
      label: mutator
    validations:
      required: true
  - type: input
    id: source_command
    attributes:
      label: source command
    validations:
      required: true
  - type: input
    id: expected
    attributes:
      label: expected
      value: deny_pending_approval
    validations:
      required: true
  - type: input
    id: actual
    attributes:
      label: actual
    validations:
      required: true
  - type: input
    id: reason
    attributes:
      label: reason
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
