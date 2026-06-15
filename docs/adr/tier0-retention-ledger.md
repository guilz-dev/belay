# Tier0 retention ledger (ADR-002 M3)

Each retained Tier0 rule has a one-line justification and paired MUST-ALLOW / MUST-ASK neighbors.

| rule | justification | must_allow_neighbor | must_ask_neighbor |
|---|---|---|---|
| `control_plane_mutation` | Mutating Belay hook/config/audit can disable the floor itself | control-plane read | `tee` into `.cursor/belay.config.json` |
| `tier0_external` | git push / npm publish irreversibly change remote state | `git status` | `git push --force` |
| egress destructive | Mutating/sending to external systems is remote-destructive | `curl https://example.com` (GET) | `curl -d payload` |
| prescan `destroys_history_or_secrets` | `.git` + destructive verb destroys history structurally | `git status` | `rm -rf .git` |
| prescan `sensitive_path_mutation` / `outside_repo_secret_credential_path` / `persistent_agent_path` | Redirect/write to in-repo sensitive files, repo-outside secrets/credentials, or agent startup files (`src/core/verdict/persistent-paths.ts`) | `cat .env` | `echo x >> .env`, `echo x >> ~/.env`, `echo x >> ~/.ssh/id_rsa`, `echo x >> ~/.zshrc`, `echo x >> ~/.ssh/authorized_keys` |
| `high_stakes_path` (action-aware) | Destructive mutation on `.git` / sensitive paths | `cat .env` | `rm -rf .git` |
| Tier1 `!local_recoverable` | Ambiguous or remote/destructive open-region semantics | `Write ~/.cursor/plans/foo.plan.md` | `Write ~/.ssh/authorized_keys` |

## MUST-ASK catalog (FN=0 — pair with MUST-ALLOW before removing broad outside-repo ask)

| case | why ask |
|---|---|
| `Write ~/.ssh/authorized_keys` | persistent access path |
| `echo x >> ~/.zshrc` / `~/.bashrc` | agent startup persistence |
| `Write ~/.config/...` (persistent config) | survives reboot |
| crontab / launchd persistence | survives reboot |
| repo-outside secret/credential paths (`~/.env`, `~/.env.local`, `~/.ssh/id_*`, `~/.npmrc`, `~/secret.pem`, etc.) | secret overwrite/exfil |
| `rm -rf .git` / `rm -rf ~` | catastrophic cores |

## MUST-ALLOW catalog (M2)

| case | why allow |
|---|---|
| `Write ~/.cursor/plans/foo.plan.md` | local IDE document, not catastrophic |
| `Write /tmp/benign.txt` | ephemeral local file |
| `cd /tmp && rm -rf foo` | /tmp deletion is recoverable / low stakes |
| control-plane read | no change |
