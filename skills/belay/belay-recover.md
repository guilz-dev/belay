Advisory recovery guidance for a recent blocked or destructive action (does not run commands).

```bash
belay recover
```

To target a specific command:

```bash
belay recover --command "rm important.ts"
```

Review each suggested step before running — recovery commands pass through belay hooks.
