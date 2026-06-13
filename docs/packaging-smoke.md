# Packaging smoke (WS-Pkg / T28)

Partial checklist for R-X4 packaging validation.

## 5a — skills CLI + init

1. `npx skills add <repo> --skill belay -a cursor -y` → skill only
2. `agent-belay doctor` → skill-only advisory (T21)
3. `npx agent-belay init --adapter cursor --with-skill` → doctor floor green

## 5b/5c — native packaging (follow-up)

- `scripts/render-packaging.mjs` generates Claude plugin + Codex marketplace from shared hooks
- Generated install must match `init --adapter X` output (snapshot test)
- Plugin-only install reaches doctor green without init fallback

Status: render-packaging not yet automated in CI.
