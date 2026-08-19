Show belay install health, pending approvals, dogfood metrics, and audit visibility.

```bash
belay status
```

For audit-only summary: `belay report`. For recovery advice: `belay recover`.

For opt-in contained execution, report the configured and attested Docker capability separately
from L1-full. If the image, executable, Unix socket, daemon, or limits no longer match, suggest
`belay session start`. Do not run it implicitly. Contained guest output is always credential-
scrubbed and capped even when ordinary audit redaction switches are disabled.

If hooks are missing, suggest `npx @guilz-dev/belay init` and `belay doctor`.
