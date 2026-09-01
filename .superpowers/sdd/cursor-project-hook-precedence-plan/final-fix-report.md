# Final whole-branch review fix report

Baseline for this pass: `caabb27` on `fix/cursor-project-hook-precedence`.

## Outcome

All seven numbered whole-branch findings, the shadowed-global doctor minor, and the final
Global-only sentinel follow-up are fixed. The changes preserve the public
`installScope: "project" | "global"` contract, policy and EffectPlan behavior, config/audit
schemas, exact managed-entry ownership proof, sibling/unknown-artifact preservation, and
Project-over-User routing semantics.

## RED / GREEN evidence

1. **Config routing and atomic publication**
   - RED: new missing/omitted/malformed/structurally-invalid/invalid-scope/unreadable routing cases
     produced six failures: omitted and broken present configs were neutral instead of selecting
     Project. The open-descriptor config test also observed replacement semantics missing from the
     truncate-in-place writer.
   - GREEN: only `ENOENT` is neutral; omitted or broken present config selects the matching Project
     origin and never the global origin. `writeConfigFile` serializes before a same-directory
     exclusive temporary write and atomic rename. Router/config focused coverage passed 42 tests.

2. **Scope transition ordering**
   - RED: a failed Global→Project init left `installScope: project`, and a failed
     Project→Global upgrade left `installScope: global`; both disabled the prior effective owner.
   - GREEN: runtime, dispatcher, runners, shims, hook settings, and requested skill artifacts stage
     before `applyInstallScope`. The target is published only after staging succeeds, then exact
     previous-owner cleanup runs. Tests execute the prior generated command after failure and get a
     real deny. The upgrade failure occurs after global runtime/hooks have already staged, proving
     partial target staging is still neutral while Project remains effective.
   - Existing Project-upgrade refresh of a proven global installation and exact selected-global
     cleanup tests remain green; sibling repositories and unknown hook/runtime/skill/command files
     remain untouched.

3. **Cursor host-level `failClosed`**
   - RED: five focused assertions showed missing `failClosed` metadata and no migration of exact
     managed entries with absent/false values.
   - GREEN: every current Cursor managed definition and serialized entry has `failClosed: true`;
     merge replaces exact old/false definitions while preserving custom entries. Process tests
     remove the selected runner, shim, and dispatcher, observe a non-zero command failure, and
     verify the serialized host flag. Doctor reports an exact managed entry that has not migrated
     to the host flag, even when integrity pinning is disabled.
   - Documentation distinguishes actionable pre-event protection from post-action events that
     cannot roll back completed effects and `sessionEnd`, whose response Cursor does not use.

4. **Durable canonical Project origin**
   - RED: after installing through a symlink and deleting the alias, the installed command returned
     neutral instead of the expected deny.
   - GREEN: Project shims embed `realpath(repoRoot)` at render/install time. The process test removes
     the alias, then invokes, doctors, upgrades through the real path, verifies one managed owner,
     invokes again, and observes exactly two audit records total.

5. **Global integrity boundary**
   - RED: global manifests contained only repository config; dispatcher/core/shim/runner tampering
     and a legacy config-only pin set all passed doctor.
   - GREEN: Project and global manifests cover config, hook settings, all shims, platform runners,
     core, and Cursor dispatcher. Global artifacts use stable `@global/…` keys resolved only from
     the required adapter artifact set rather than repository-relative traversal paths. Doctor
     requires the complete pin set and reports global tampering. Upgrade refreshes every pin.

6. **Dispatcher dependency surface**
   - RED: esbuild's metafile exposed 13 forbidden inputs, including the full Cursor layout and 12
     `src/core/*` config/audit/policy dependencies.
   - GREEN: routing path/root helpers moved to a Node-fs/path-only module. The metafile test bans
     `src/core/*`, audit modules, config I/O/defaults, and the full Cursor layout. The built
     dispatcher is 10,330 bytes versus the 746,172-byte Cursor core bundle; marker scans find none
     of the banned policy/config tokens. Non-owners remain routing-only and `core.mjs` stays a
     selected-owner dynamic import.

7. **Windows doctor runner selection**
   - RED: healthy simulated Windows Claude and Codex installs were diagnosed against Cursor's
     PowerShell runner. After selecting `.cmd`, Codex still failed because doctor compared an
     unescaped command with TOML source.
   - GREEN: Windows Cursor requires `belay-runner.ps1`; Claude/Codex require their installed
     `belay-runner.cmd`. Codex comparison uses the adapter's TOML-string representation. Both
     healthy Windows adapter tests have no doctor issues.

8. **Shadowed-global inspection diagnostics**
   - RED: malformed global hooks JSON, an unreadable hooks path, and an unreadable shim all rejected
     the `doctorProject` promise.
   - GREEN: doctor catches and reports each inspection failure. Detailed shim/dispatcher problems
   also make the shadowed global owner unsafe instead of being discarded; a healthy shadowed
   global installation remains an informational note.

9. **Global-only fail-closed sentinel for Project-selected config**
   - RED: five genuine Global-only process installs returned `allow` after their repository config
     was changed to omitted-scope, malformed, structurally invalid, invalid-scope, or unreadable.
     Four partial-owner routing cases also left the Global source neutral; matching Project routes
     ignored a missing dispatcher or managed hook settings. A non-executable POSIX runner was
     initially mistaken for a callable owner.
   - GREEN: when a present config resolves or fails safely to Project, the Global source now proves
     that the exact event/matcher has a current `failClosed: true` Project command, the selected
     platform runner is callable, the event shim embeds the matching canonical Project origin, and
     the dispatcher exists. If that launch chain is absent or partial, the Global source returns a
     structured sentinel denial without importing core. Process markers prove zero core imports
     and the pre-existing audit file remains empty for all five cases.
   - Missing config remains neutral and valid Global config still executes Global. A complete
     Project owner keeps Global neutral and executes once. Core is intentionally not part of the
     launch-chain proof: if only core is absent, the callable matching Project dispatcher remains
     sole owner and emits its existing incomplete-install denial. Nonmatching Project origins stay
     neutral.

## Self-review

| Finding | Final audit |
|---|---|
| Missing/omitted/broken config | Missing alone is neutral; every requested present-broken case is Project-routed; global cannot execute; atomic config rename removes the ordinary partial-write window. |
| Transition ordering | Both init and upgrade publish after target staging; real generated prior-owner commands prove continuity; exact cleanup behavior is unchanged. |
| Host failure floor | All managed Cursor events and migrations carry `failClosed: true`; process failure coverage includes runner, shim, dispatcher; docs do not claim post-action rollback. |
| Durable origin | Canonical identity is persisted at install, not recomputed from a dead lexical alias; invoke/doctor/upgrade remain single-owner. |
| Global integrity | Settings, shims, all generated platform runners, core, and dispatcher are pinned, required, upgraded, and tamper-tested; Project confinement is not weakened. |
| Lightweight dispatcher | Actual esbuild import graph excludes policy/audit/default/config modules; no broad source grep is used as the test oracle. |
| Windows doctor | Cursor PowerShell selection remains intact; Claude/Codex use `.cmd`; Codex TOML escaping is accounted for. |
| Shadow inspection | Malformed/unreadable settings and shims become issues, never uncaught exceptions; healthy shadow behavior is preserved. |
| Global sentinel | Project-selected config cannot create a Global-only allow gap: absent/partial matching Project launch chains trigger a routing-only Global denial; complete Project owners remain single-execution, and incomplete callable Project owners still deny themselves. |

No policy, EffectPlan, approval, config, or audit schema was widened. The only host-settings type
addition is Cursor's supported optional `HookEntry.failClosed`; current generated Cursor
definitions refine it to literal `true`. Integrity manifest version remains 1, with a scoped key
mapping for the newly required global files. No real Cursor settings or logs were read or written;
all process/install coverage uses temporary repository and HOME directories.

## Verification

- Focused runtime/installer/router/config/doctor set: 10 files, 156 tests passed.
- Follow-up Cursor router/dispatcher/process/installer set: 8 files, 117 tests passed; the
  executable-runner refinement then passed 32 router/bundle tests.
- Global integrity follow-up: 2 files, 8 selected tests passed.
- `pnpm test`: 179 files passed; 2,494 passed, 2 skipped (2,496 total), including a fresh build.
- `pnpm typecheck`: passed.
- `pnpm lint`: passed with no errors (the branch retains ten unrelated pre-existing
  non-null-assertion warnings and one unrelated informational lint diagnostic).
- `pnpm run build`: passed; Cursor, Claude, Codex runtime bundles and Cursor dispatcher built.
- `git diff --check`: passed.
