# init-wizard smoke (manual)

Routine smoke for `belay init-wizard` after install or wizard changes.

## Steps

1. In an empty git repo, run `npx @guilz-dev/belay init-wizard`
2. Choose adapter `cursor`, scope `project`, with skill `y`, dogfood `n`
3. Confirm `.cursor/belay.config.json`, hooks, runtime, and skill are created
4. Run `belay doctor` — expect green floor (no skill-only warning)
5. Run `belay status` — `Floor installed: yes`

## Fail signals

- Wizard exits without writing hooks
- Doctor reports skill-only after full wizard install
- Scope/global selection does not match chosen paths
