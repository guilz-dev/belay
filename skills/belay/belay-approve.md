Run after belay denies a high-risk action and returns an approval ID.

```bash
belay approve <approval-id>
```

Then retry the original action unchanged.

With default `approval.flow: one_step`, shell approvals return a replay hint from editor
hooks. Tool and subagent approvals still require a manual retry.

To run a denied shell command from the CLI after approval (explicit opt-in; do not also retry via hooks):

```bash
belay approve <approval-id> --replay
```

Successful CLI replay consumes the one-shot grant. On failure, the approval stays active for one hook retry.

Restore legacy two-step UX in `belay.config.json`:

```json
{ "approval": { "flow": "two_step" } }
```
