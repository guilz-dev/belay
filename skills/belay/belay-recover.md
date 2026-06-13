Advisory recovery guidance for a recent blocked or destructive action (does not run commands).

```bash
agent-belay recover
```

To target a specific command:

```bash
agent-belay recover --command "rm important.ts"
```

Review each suggested step before running — recovery commands pass through belay hooks.
