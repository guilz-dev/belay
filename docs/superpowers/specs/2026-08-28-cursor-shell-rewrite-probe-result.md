# Cursor Shell rewrite probe result

- Status: **PENDING** — no live Cursor Agent run has been performed for this worktree.
- Planned invocation: `cursor-agent --print --output-format stream-json --trust --workspace <private temporary workspace> <controlled prompt>`.
- Planned evidence: private temporary workspace only; raw transcripts and hook inputs/outputs must not be committed.
- Planned digest: raw-evidence manifest SHA-256, not a hash of the entire mutable evidence directory.
- User-level `.cursor/hooks.json`: a live run records only presence and SHA-256; it does not modify, disable, or copy the file contents.

The Task 1 harness records evidence for Cases A–E. A reviewer must inspect the marker files and raw events before Task 4 makes the sole terminal `GO`, `NO-GO`, or `BLOCKED` decision.
