# Dogfood harvest review — 2026-09-07 frozen batch

## Evidence boundary

- Baseline: `belay-2026-09-07`
- Inclusive cutoff: `2026-09-07T11:15:28.016Z` (audit record 4,376)
- Baseline active-cohort identity: runtime artifact `64bdae4b…e588cf9a`, decision config
  `8867a58f…b0ccc8`, boundary profile `l3-l4-only`
- Review runtime: source commit `6312a17`; `dist` rebuilt before export and reclassification
- Frozen export: 35 candidates and 3 availability items. Active-cohort accounting was 111 matching
  gate events and 648 nonmatching events; `--all-cohorts` retained mixed history for forensic review.
- Replay context: every candidate had at least one exact v1 shell `actionSnapshot` match and exactly
  one distinct saved action cwd, represented below as `REPO`

The export used `harvest list --until 2026-09-07T11:15:28.016Z --all-cohorts --json` against the
preserved audit log. Later audit rows are not part of this batch.

## Disposition summary

The persisted review ledger contains 35 unique `(fingerprint, shell, l3-l4-only)` keys:

| Ledger outcome | Count |
| --- | ---: |
| `accepted-benign` | 20 |
| `must-ask` | 7 |
| `provably-benign` | 4 |
| `reject` | 4 |

Five candidates now pass without a prompt. The three complete read-only Git delegates are marked
`stale-currently-allow` and persisted as `reject`, because they no longer belong in the remediation
queue. The two test-runner delegates are also marked `stale-currently-allow`, but remain
`accepted-benign` evidence because their complete plans intentionally project a flagged local
mutation. Neither group opens an EffectPlan implementation issue.

## Candidate review

`Effect evidence` summarizes every leaf requirement relevant to the disposition. Paths and command
bodies are represented by role, and executable heredoc/source bodies are never reproduced.

| Fingerprint | Redacted first line | Historical reason | Current reason | Semantic family | Effect evidence | Review outcome | Corpus action | Implementation issue |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `858ea56e9e9a38cb6dd8f484dce751516f244d847763f1b911a1cd1b074cab26` | `rtk git status --short` | `unknown_local_effect` | `read_only` | argv-delegated Git read | Complete/certain: `rtk` inspect, `git` inspect, repository `fs.read`; projection `allow` | `stale-currently-allow` (ledger: `reject`) | Add passing exact regression case | None; current plan is complete |
| `794b46c3d7c05b73031176ebf28e3b32ee7965ec0cf7677b73942e2a20b8a4ed` | `rtk git status --short --branch` | `unknown_local_effect` | `read_only` | argv-delegated Git read | Complete/certain: `rtk` inspect, `git` inspect, repository `fs.read`; projection `allow` | `stale-currently-allow` (ledger: `reject`) | Add passing exact regression case | None; current plan is complete |
| `379e832bdd360f98735799a99641d64c760b1b3baa94e7367868cbfa047d19e3` | `rtk vitest [test files]` | `unknown_local_effect` | `local_mutation` | argv-delegated test runner | Complete: `rtk` inspect plus known-local `vitest` spawn; projection `allow_flagged` | `accepted-benign`; `stale-currently-allow` | Add passing generic-path variant | None; current plan is complete |
| `de8428cc2916ab97a12f260783b9c1811536295772575e9a54326f010fddb798` | `rtk vitest [test file] -t "[test name]"` | `unknown_local_effect` | `local_mutation` | argv-delegated test runner | Complete: `rtk` inspect plus known-local `vitest` spawn; projection `allow_flagged` | `accepted-benign`; `stale-currently-allow` | Add passing generic-path variant | None; current plan is complete |
| `ad7ffc0ca2664f59884310eb9a190447fce5c18e20ef541d7d056f4b5eda2e91` | `[PR wrapper] --base main --title "[title]" --body [literal heredoc]` | `unknown_local_effect` | `unknown_local_effect` | PR creation wrapper | Partial/opaque: wrapper spawn plus command-substitution/body reads, writes, spawned tokens, and `indeterminate` | `must-ask` | Add passing normalized `gh pr create` sentinel; omit long body | None; external PR mutation must ask |
| `81029b0e0d1ea964bfc95b6f2e8ec64e27cd3d6bf0c7e2a027bc4049d0d73855` | `[push wrapper]` | `unknown_local_effect` | `unknown_local_effect` | push wrapper | Partial: wrapper spawn plus `indeterminate` | `must-ask` | Omit duplicate/path-specific wrapper; direct push sentinels cover the boundary | None; external push must ask |
| `b15f532b4f2043087dc24df247f70ea0f7d700e67b64678411c389308f572046` | `[push wrapper] -u origin HEAD` | `unknown_local_effect` | `unknown_local_effect` | push wrapper | Partial/opaque: delegated wrapper spawn plus `indeterminate` | `must-ask` | Add passing normalized `git push -u origin HEAD` sentinel | None; external push must ask |
| `e5e9830366e760a9f337adcd3049bdeec97dda99b6b3e9c4246d92953bc6aff3` | `cd REPO && [push wrapper] -u origin HEAD` | `unknown_local_effect` | `unknown_local_effect` | push wrapper | Partial/opaque: literal cwd transition, delegated wrapper spawn, and `indeterminate` | `must-ask` | Omit duplicate and maintainer-specific paths | None; external push must ask |
| `c9c201684c5e8cf268beed126c6e52ec34da713389ca7071444a2fbdf6c9ba5a` | `cd REPO && npm publish` | `external_effect` | `external_effect` | package publication | Complete: `npm` spawn plus external `network.connect(mutate)`; projection `deny_pending_approval` | `must-ask` | Add passing normalized `npm publish` sentinel | None; current denial is required |
| `762d829265eb091ea9ab4cbd6af39d8418ed71c402387f6a36d8a622be62211f` | `cd REPO && pnpm build 2>&1 [pipe] tail -5` | `unknown_local_effect` | `unknown_local_effect` | package build | Recursive/partial: package script resolves `rm` and generated `dist` write plus Node/TypeScript spawns and `indeterminate` | `accepted-benign` | Scratch only; tracked omission because current result is not the accepted verdict | None; generated-output mutation is soft evidence, never provably benign |
| `922cae8dcea0c4f1d78c46219b6a8be53d6d0ccddcc268b52434f204651cdac0` | `cd REPO && scripts/pre-release-check.sh` | `unknown_local_effect` | `unknown_local_effect` | release verification launcher | Partial: opaque launcher plus `indeterminate`; source review shows local version sync, tests/build, and package dry-run | `accepted-benign` | Scratch only; opaque exact launcher does not pass the accepted expectation | None; retain as reviewed soft evidence |
| `4df3c1d298dec460a59895abaf76a0343e3c8359a927634df014cbc3a2a4c8b2` | `cd [worktree] && make verify-parallel 2>&1 [pipe] tee [ci-log]` | `unknown_local_effect` | `unknown_local_effect` | parallel Make verification | Unparseable/partial: background recipes, dynamic PID waits, outside log write, protected-path signal, and `indeterminate`; contained execution is disabled | `accepted-benign` | Scratch only; personal log path removed and current accepted expectation does not pass | Task 9 must preserve ask for the unresolved background/PID plan |
| `1877dc847b7410ce02be40fae9ef5a21dccc043784f8c91ec2ed8a7bc506c9ab` | `git add [tracked files] && git commit [literal message heredoc]` | `unknown_local_effect` | `unknown_local_effect` | repository-local Git commit | Partial: tracked-file writes and local ref write are visible, but heredoc tokens add false spawns and `indeterminate` | `accepted-benign` | Scratch only; omit long message body and identity trailer | Task 9 heredoc boundary normalization |
| `270c8200bcc8548416f275ac30ed06455baddd834fc7df2cf950b9135f031f2e` | `node [belay CLI] doctor --target [other repo] 2>&1` | `unknown_local_effect` | `unknown_local_effect` | Node CLI diagnostic | Partial: Node spawn plus Node-grammar `indeterminate`; exact `doctor` invocation has no fix flag | `accepted-benign` | Scratch only; target and launcher path are context-specific and current expectation does not pass | None; reviewed diagnostic evidence only |
| `a81f80e77949dbd3b97437c5fffb4b208f1e24c329e60d11161bdc963c449a69` | `node [belay CLI] doctor ...; node [belay CLI] status ... [pipe] head -20` | `unknown_local_effect` | `unknown_local_effect` | Node CLI diagnostics | Partial: two Node spawns, `head` inspect, and Node-grammar `indeterminate` | `accepted-benign` | Scratch only; target paths are context-specific and current expectation does not pass | None; reviewed diagnostic evidence only |
| `f441c2e0663b9b2f29b7442774abad2281632d0e12ea78cc08dd428257366101` | `node scripts/build-runtime.mjs` | `unknown_local_effect` | `unknown_local_effect` | runtime builder | Partial: Node spawn plus Node-grammar `indeterminate`; source writes generated runtime output | `accepted-benign` | Scratch only; generated-output mutation is not provably benign and current expectation does not pass | None; retain as reviewed soft evidence |
| `b67b50d5e4554faf1ccf23d2f86fe6b6b48d272d7d1b57de7b226f796201a754` | `npm test -- [test file] -t "[test name]"` | `unknown_local_effect` | `unknown_local_effect` | package test | Recursive/partial: resolved build performs `rm` plus `dist` write before Node/TypeScript/Vitest spawns; `indeterminate` remains | `accepted-benign` | Scratch only; package test does not pass the accepted expectation | None; generated-output mutation stays soft evidence |
| `697ebc78825ea30d1574d0d39dcafe52035b02c24a8d7c21cd3b4ed1440a5c32` | `pnpm test -- [test files]` | `unknown_local_effect` | `unknown_local_effect` | package test | Recursive/partial: resolved build performs `rm` plus `dist` write before Node/TypeScript/Vitest spawns; `indeterminate` remains | `accepted-benign` | Scratch only; package test does not pass the accepted expectation | None; generated-output mutation stays soft evidence |
| `055ba5b61965a634aa16cab434478d4653caa3da36b1a91e121e0c98ee86ae9c` | `pnpm test -- [test files]` | `unknown_local_effect` | `unknown_local_effect` | package test | Recursive/partial: resolved build performs `rm` plus `dist` write before Node/TypeScript/Vitest spawns; `indeterminate` remains | `accepted-benign` | Scratch only; package test does not pass the accepted expectation | None; generated-output mutation stays soft evidence |
| `a370ecfe7efdb6c3339311a94ddf60052235d1c4e7d424cdc0a211fdd55d6232` | `pnpm test -- [test files]` | `unknown_local_effect` | `unknown_local_effect` | package test | Recursive/partial: resolved build performs `rm` plus `dist` write before Node/TypeScript/Vitest spawns; `indeterminate` remains | `accepted-benign` | Scratch only; package test does not pass the accepted expectation | None; generated-output mutation stays soft evidence |
| `6d7c6101411b80c0bf5a9ddb609ee39d629dcd8a3fead7ca4225aeb9244bd087` | `python3 - <<'PY' [source omitted]` | `unknown_local_effect` | `unknown_local_effect` | executable interpreter heredoc | Unparseable/partial: interpreter/body tokens yield reads, writes, many spawns, and `indeterminate`; the serialized snapshot also derives a different current fingerprint | `must-ask` | Add passing short generic executable-heredoc sentinel; omit captured body | Task 9 must preserve ask; record fingerprint drift as Task 10 replay-fidelity evidence |
| `d39b7d57bfa1dccfc7a4f0f0dcbe7e2ad7d8b6f41c3c92a81796a3496c963341` | `rtk git diff -- [tracked files]` | `unknown_local_effect` | `read_only` | argv-delegated Git read | Complete/certain: `rtk` inspect, `git` inspect, repository and file `fs.read`; projection `allow` | `stale-currently-allow` (ledger: `reject`) | Add passing generic-path regression case | None; current plan is complete |
| `158dba648b0b224f35020f631f50ec4e2af26f0ed082ac5b6fbc8a0f2badbf8f` | `rtk ls` | `unknown_local_effect` | `unknown_local_effect` | one-token read delegate | Partial: wrapper spawn plus `indeterminate`; one-token inner command is not lowered | `provably-benign` | Scratch only; defer tracked hard-gate case until it passes | Task 7 bounded one-token delegate lowering |
| `46992d5f6cea8c2a4e642b3624da55f7d1a3893a9a983a86e23bfb2516f8e5b3` | `cat [user hooks] [pipe] rtk rg -n "[hook names]"` | `unknown_local_effect` | `unknown_local_effect` | nested read delegate pipeline | Recursive/partial: `cat`/`rg` inspect and file read are visible, but pattern tokens become spawns and `indeterminate` | `provably-benign` | Scratch only; exact personal path omitted and hard-gate case deferred until passing | Task 7 bounded nested delegate lowering |
| `dcab3bbd37c43ee004c08e42d90f2f482ae50a834a4be6138fbd594f229b6b35` | `cat [user hooks] [pipe] rtk rg -n "[hook names]"` | `unknown_local_effect` | `unknown_local_effect` | nested read delegate pipeline | Recursive/partial: `cat`/`rg` inspect and file read are visible, but pattern tokens become spawns and `indeterminate` | `provably-benign` | Scratch only; exact personal path omitted and hard-gate case deferred until passing | Task 7 bounded nested delegate lowering |
| `4845906a8f3fdca1e7ecd66815c426c78919be7bda40f1e18cc10bc9b6e84dfb` | `git log ... && git merge-base origin/main HEAD && git diff --stat origin/main...HEAD && git diff origin/main...HEAD` | `unknown_local_effect` | `unknown_local_effect` | compound Git range read | Partial: Git inspect/read requirements are present, but the range is treated as a path and adds grammar `indeterminate` | `provably-benign` | Scratch only; defer tracked hard-gate case until it passes | Task 8 read-only revision/range operands |
| `0e7119f1d2b44ae0cb6d5f8990fbb744b45bbf8fd0cd7f858e4c8bed5bebea76` | `grep -l "[marker]" [user worktree glob] [pipe] head -5; rtk grep "[field]" [user path]` | `unknown_local_effect` | `unknown_local_effect` | contextual path diagnostic | Partial: `grep`/`head`/`rtk` inspect with known and unknown reads; glob/path uncertainty leaves `indeterminate` | `accepted-benign` | Scratch only; personal glob and context are not reusable corpus evidence | None; do not generalize a read-style prefix |
| `27d7f1abc5612ed9daa212e1cd18caecd7c30fd36a065663cc11aaef6ea3d364` | `ls/cat [config paths]; which belay; node [belay CLI] --version` | `unknown_local_effect` | `unknown_local_effect` | contextual path diagnostic | Partial: `ls`/`cat`/`which` reads plus Node spawn and unknown-path `indeterminate` | `accepted-benign` | Scratch only; multiple personal targets are omitted | None; reviewed context is not a structural allow rule |
| `ae1e23b6592459859ff1fdd9ca26802050ebc6f841f6b30bfc1633bbd68904b9` | `ls -la [project/runtime paths] ... [pipe] head -5` | `unknown_local_effect` | `unknown_local_effect` | contextual path diagnostic | Partial: `ls`/`head` inspect and known/unknown file reads; unresolved redirects leave `indeterminate` | `accepted-benign` | Scratch only; personal targets are omitted | None; reviewed context is not a structural allow rule |
| `f51bae49198ad5020491d4436a3c94d50d13e0d3117796186119ecf8a1b14826` | `ls -la [user project dir] [pipe] rtk rg '[worktree markers]'` | `unknown_local_effect` | `unknown_local_effect` | contextual delegated read | Recursive/partial: `ls`/`rg`/`rtk` reads are visible, but a pattern token becomes a spawn and leaves `indeterminate` | `accepted-benign` | Scratch only; personal target and project markers are omitted | None; not provably benign from the read prefix alone |
| `97447732c7c0376b2f969cb4fe4e0fc068ede3911ef9be5a828a7969c809939e` | `ls -la [trust dir] ...; for f in [trust glob]; do ... rtk read "$f"; done` | `unknown_local_effect` | `unknown_local_effect` | dynamic global-file diagnostic loop | Recursive/partial: loop/control tokens and dynamic reads become spawns; only some reads are known and `indeterminate` remains | `reject` | No corpus case; dynamic loop and global-file context are not reusable evidence | None; rejected rather than generalized |
| `ba00a190258f7e3f78f406294874ce7ac86f16f9aefc18274d0d608ccb055701` | `ls/rg/read [trust and hook paths] ...` | `unknown_local_effect` | `unknown_local_effect` | contextual delegated read | Recursive/partial: read commands plus known/unknown paths; wrapper and glob handling leave `indeterminate` | `accepted-benign` | Scratch only; personal paths and context are omitted | None; not provably benign from read-style prefixes |
| `509dcf750bbfba45c9d236a5e8c39f67f5fda34c2c1b5913b5a06afbed1abde7` | `ls [trust dir] [pipe] head -5; node -e "[source omitted]"` | `unknown_local_effect` | `unknown_local_effect` | dynamic Node evaluation | Recursive/partial: file read plus dynamic evaluation, writes, spawned body tokens, and `indeterminate` | `must-ask` | Add passing short generic `node -e` sentinel; omit captured source | None; arbitrary evaluated source must ask |
| `00363e0530c254e33d89a2bb6579db8d2d0d2c46fe33649b44c34c151e8ddcdc` | `npm test -- [test file]` | `unknown_local_effect` | `unknown_local_effect` | package test | Recursive/partial: resolved build performs `rm` plus `dist` write before Node/TypeScript/Vitest spawns; `indeterminate` remains | `accepted-benign` | Scratch only; package test does not pass the accepted expectation | None; generated-output mutation stays soft evidence |
| `235ed412412dbb4a54745c134065af83f30363b7034f25359478155b370ef09c` | `tail -20 "[home]/[tool log]"` | `unknown_local_effect` | `unknown_local_effect` | environment-derived log read | Partial: `tail` inspect plus unknown `fs.read`; unresolved environment path adds `indeterminate` | `accepted-benign` | Scratch only; personal log path is omitted and current expectation does not pass | None; reviewed context is not structural proof |

## Tracked corpus selection

The CLI review run used a disposable corpus copy under `/tmp`; none of its 31 exact command bodies
were copied wholesale. Ten normalized cases were then selected independently because they are
privacy-safe, structurally representative, and pass the current corpus evaluator:

- Three complete/certain `rtk git status/diff` read regressions (`provably-benign`).
- Two `rtk vitest` local-mutation variants with generic fixture paths (`accepted-benign`).
- Five safety sentinels for package publication, PR creation, push, executable Python heredoc, and
  `node -e` (`must-ask`).

Every selected case has `provenance.source: harvest`, source batch `belay-2026-09-07`, and its
original 64-hex fingerprint as `sourceCaseId`. Omitted cases fall into one of four groups: they are
currently mismatched soft evidence, they are intended hard-gate cases that Tasks 7–8 must first
make pass, they contain contextual/personal paths or long bodies, or an existing semantic sentinel
already covers the safety boundary.

## Persistence and authority checks

- Frozen `harvest list --all-cohorts` after persistence: 0 unreviewed candidates and the same 3
  availability items.
- Frozen `--all-cohorts --include-reviewed`: all 35 unique candidate fingerprints remain visible.
- Ledger v1: 35 records, 35 unique keys, boundary profile `l3-l4-only`; stored fields are limited to
  fingerprint, kind, boundary profile, outcome, short privacy-safe reason label, and review time.
- Reviews and corpus fixtures are evidence only. No command, prefix, executable, fingerprint, or
  corpus runtime allowlist was introduced.
