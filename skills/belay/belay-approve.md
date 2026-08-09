Run after belay denies a high-risk action and returns an approval ID.

```text
/belay-approve <approval-id>
```

With default `approval.flow: one_step`, the editor hook atomically claims the one-shot grant and
immediately replays the exact denied shell action through the configured boundary driver. No
follow-up prompt is required. Failed or timed-out replay requires fresh approval. Tool and subagent
approvals still require a manual retry of the original action unchanged.

An instruction may follow the approval line in the same prompt. Belay runs the approved shell action
first and continues the remaining prompt only after replay succeeds.

For CLI approval, replay remains explicit:

```bash
belay approve <approval-id> --replay
```

CLI replay claims the one-shot grant before execution. Failure or timeout requires fresh approval.

Restore legacy two-step UX in `belay.config.json`:

```json
{ "approval": { "flow": "two_step" } }
```
