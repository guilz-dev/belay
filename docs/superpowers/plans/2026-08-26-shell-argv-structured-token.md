# Shell argv Structured Token Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve shell argv boundaries with structured tokens, interpreter-specific decoding, positional Docker Compose parsing, monotonic regression tests, and separated live-test gates while recording scanner unification as Markdown-canonical debt.

**Architecture:** Add a structured lexer beneath the existing `tokenizeShell(): string[]` facade, then route only recursive interpreter and Compose decoding through typed results. Existing structural, unparseable, redirect, and substitution scanners remain separate. Unknown grammar becomes an explicit indeterminate EffectPlan requirement.

**Tech Stack:** TypeScript 5.9, Node.js 24, pnpm 10.29.3, Vitest 3, Biome, GitHub Issues via `gh`

**Spec:** `docs/superpowers/specs/2026-08-26-shell-argv-structured-token-design.md`

## Global Constraints

- EffectPlan remains the sole authorization input for normalized shell actions (ADR-004).
- No command name, prefix, fingerprint, corpus entry, or option table becomes runtime authority (ADR-005).
- Unknown options, missing operands, dynamic scripts, incomplete lexing, and depth overflow fail closed.
- Existing scanners are not unified, replaced, or deleted.
- `tokenizeShell(input): string[]` remains source-compatible.
- Existing `eval` joining and fail-closed dynamic-evaluation behavior remains unchanged.
- Node major is `24`, matching CI.
- `docs/issues/0004-unify-shell-scanners.md` is the sole source of truth for scanner-unification debt.

---

### Task 1: Record scanner-unification debt and create its index Issue

**Files:**
- Create: `docs/issues/0004-unify-shell-scanners.md`

**Interfaces:**
- Consumes: ADR-004, ADR-005, approved design, existing scanner entry points.
- Produces: canonical debt Markdown and an index-only GitHub Issue URL.

- [ ] **Step 1: Create the canonical Markdown**

Write these sections with no duplicated GitHub specification: title, `種別: 技術的負債（今回は実装しない）`, `正本`, background, targets, start triggers, migration, non-goals, acceptance criteria, and related ADRs. The exact acceptance criteria are:

```markdown
- [ ] 1入力を1回解析した`ShellParseResult`から全consumerが判定を得る。
- [ ] malformed、quote、escape、substitution、operator境界の解釈が一意である。
- [ ] EffectPlan decision-diffでASKからALLOWへの差分がない。
- [ ] dynamic／unknown入力はindeterminateを維持する。
- [ ] 旧scanner削除前に新旧shadow corpusの差分がレビュー済みである。
- [ ] ADR-004／ADR-005の権威境界を維持する。
```

The targets are `shell-tokenizer.ts`, `parser.ts` structural splitting, `shell-unparseable.ts`, `shell-substitution.ts`, and their EffectPlan consumers. Start only after another scanner interpretation bug, a syntax change requiring at least three scanners, or recurring structured-lexer decision diffs.

- [ ] **Step 2: Validate the source-of-truth contract**

Run:

```bash
git diff --check -- docs/issues/0004-unify-shell-scanners.md
rg -n "唯一の仕様正本|今回は実装しない|ASKからALLOW" docs/issues/0004-unify-shell-scanners.md
```

Expected: exit 0 and all three phrases are present.

- [ ] **Step 3: Check for a duplicate Issue, then create only an index when absent**

```bash
gh issue list --repo guilz-dev/belay --state all --search '"Shell scanner" in:title' --json number,title,url
gh issue create --repo guilz-dev/belay \
  --title "[Task]: Shell scannerを単一解析結果へ段階統合する" \
  --label task \
  --body $'正本: `docs/issues/0004-unify-shell-scanners.md`\n\nこのIssueは索引のみです。仕様・スコープ・受け入れ基準はIssue本文へ複製せず、正本Markdownを先に更新してください。'
```

Expected: reuse an exact existing index or record the new URL. The Issue body has no acceptance checklist.

- [ ] **Step 4: Commit the canonical Markdown**

```bash
git add docs/issues/0004-unify-shell-scanners.md
git commit -m "docs: track shell scanner unification debt"
```

---

### Task 2: Add a structured lexer behind the compatibility facade

**Files:**
- Modify: `src/core/shell-tokenizer.ts`
- Modify: `src/__tests__/shell-tokenizer.test.ts`

**Interfaces:**
- Consumes: raw shell source.
- Produces: `lexShell(input): ShellLexResult`; preserves `tokenizeShell(input): string[]`.

- [ ] **Step 1: Write failing lexer tests**

Add behavioral tests for these literal expectations:

```ts
expect(tokenizeShell(`sh -c ''`)).toEqual(['sh', '-c', ''])
expect(tokenizeShell(`printf '%s' 'a\\b'`)).toEqual(['printf', '%s', 'a\\b'])
expect(tokenizeShell(String.raw`printf "%s" "a\qb\"c"`)).toEqual(['printf', '%s', 'a\\qb"c'])
expect(lexShell(`echo 'unterminated`).complete).toBe(false)
expect(lexShell(`echo trailing\\`).complete).toBe(false)
```

Also assert exact `raw`, `start`, `end`, and empty value for the third token of `sh -c ''`; assert single-quoted `$CMD` has no outer expansion part and double-quoted `$CMD` does.

Production mutations caught: dropping empty words, stripping single-quote backslashes, consuming non-portable double-quote escapes, and losing source spans.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm exec vitest run src/__tests__/shell-tokenizer.test.ts
```

Expected: FAIL because `lexShell` is absent and quoted-empty words are dropped.

- [ ] **Step 3: Implement the structured types and state machine**

Add these interfaces:

```ts
export type ShellQuoteMode = 'unquoted' | 'single' | 'double'
export interface ShellWordPart {
  value: string
  raw: string
  start: number
  end: number
  quote: ShellQuoteMode
  hasExpansion: boolean
}
export type ShellToken =
  | { kind: 'word'; value: string; raw: string; start: number; end: number; parts: ShellWordPart[] }
  | { kind: 'operator'; value: string; raw: string; start: number; end: number }
export interface ShellLexResult { tokens: ShellToken[]; complete: boolean }
```

Implement `lexShell` with explicit unquoted/single/double states. Open a word before either quote, emit it even when decoded value is empty, call `readShellOperator` only unquoted, retain raw spans, and mark unclosed quotes/trailing escape incomplete. Outside quotes, backslash quotes the next character. Inside single quotes it is literal. Inside double quotes it escapes only `$`, backtick, `"`, `\\`, and newline; otherwise preserve it. Mark `$` and backtick expansion only in unquoted/double parts.

Derive the old API exactly:

```ts
export function tokenizeShell(input: string): string[] {
  return lexShell(input).tokens.map((token) => token.value)
}
```

- [ ] **Step 4: Verify GREEN across tokenizer consumers**

```bash
pnpm exec vitest run \
  src/__tests__/shell-tokenizer.test.ts \
  src/__tests__/shell-unparseable.test.ts \
  src/__tests__/effect-ir/shell-lower.test.ts
```

Expected: PASS. Only quoted-empty and corrected backslash semantics may change expectations.

- [ ] **Step 5: Commit**

```bash
git add src/core/shell-tokenizer.ts src/__tests__/shell-tokenizer.test.ts
git commit -m "refactor: add structured shell lexer"
```

---

### Task 3: Decode interpreter argv by profile and position

**Files:**
- Create: `src/core/verdict/recursive-invocation.ts`
- Create: `src/__tests__/verdict/recursive-invocation.test.ts`
- Modify: `src/core/verdict/parser.ts`
- Modify: `src/__tests__/verdict/parser-docker-compose.test.ts`

**Interfaces:**
- Consumes: `readonly ShellToken[]` and transparent-wrapper output.
- Produces: `decodeRecursiveInvocation(tokens): RecursiveInvocation`; compatibility parser exports derive from it.

- [ ] **Step 1: Write failing argv tests**

Use table tests for `bash -ec 'set -e'`, `python -c 'print(1)'`, `node --eval='console.log(1)'`, and `ruby -e 'puts 1'`, expecting `{kind:'static', interpreter, script}`. Add:

```ts
it.each([
  `python script.py -c value`,
  `node app.js --eval value`,
  `ruby script.rb -e value`,
])('does not scan after a file operand: %s', (command) => {
  expect(decodeRecursiveInvocation(lexShell(command).tokens)).toEqual({ kind: 'none' })
})

it.each([`sh -c`, `python -c`, `node --eval`])(
  'fails closed for a missing script: %s',
  (command) => expect(decodeRecursiveInvocation(lexShell(command).tokens).kind).toBe('indeterminate'),
)

expect(decodeRecursiveInvocation(lexShell(`sh -c ''`).tokens)).toMatchObject({ kind: 'static', script: '' })
expect(decodeRecursiveInvocation(lexShell(`sh -c "$CMD"`).tokens).kind).toBe('dynamic')
```

Production mutations caught: shared flag sets, global `findIndex`, missing operand fallthrough, and empty-script collapse.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm exec vitest run src/__tests__/verdict/recursive-invocation.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement typed profiles**

Use exactly:

```ts
export type RecursiveInvocation =
  | { kind: 'static'; interpreter: string; script: string }
  | { kind: 'dynamic'; interpreter: string; signal: 'shell.script_expanded' }
  | { kind: 'none' }
  | { kind: 'indeterminate'; interpreter: string; signal: 'shell.interpreter_argv_incomplete' | 'shell.interpreter_option_unknown' }
```

Profiles: shell family accepts `-c` and short groups made only from `c`, `l`, `e`, `x`, and `u` when the group contains `c`; Python accepts `-c`; Node accepts `-e`, `--eval`, and `--eval=SCRIPT`; Ruby/Perl/osascript accept `-e`. Stop at `--` or the first positional/file operand. Any other pre-positional option returns `indeterminate`; this intentionally prefers a false BLOCK over guessing whether an option consumes an operand. Missing script operands also return `indeterminate`.

- [ ] **Step 4: Replace shared flag scans with compatibility adapters**

Remove `SCRIPT_FLAGS`. Keep `extractRecursiveScript`, `isDynamicRecursiveEvaluation`, and `isBareInterpreter`, but derive them from typed results. The EffectPlan path will use structured tokens directly; the string adapter must never manufacture proof that expansion is static.

- [ ] **Step 5: Verify GREEN and commit**

```bash
pnpm exec vitest run \
  src/__tests__/verdict/recursive-invocation.test.ts \
  src/__tests__/verdict/parser-docker-compose.test.ts
git add src/core/verdict/recursive-invocation.ts src/core/verdict/parser.ts \
  src/__tests__/verdict/recursive-invocation.test.ts src/__tests__/verdict/parser-docker-compose.test.ts
git commit -m "fix: decode recursive interpreter argv by position"
```

---

### Task 4: Parse Docker Compose run boundaries positionally

**Files:**
- Create: `src/core/verdict/docker-compose-run.ts`
- Create: `src/__tests__/verdict/docker-compose-run.test.ts`
- Modify: `src/core/verdict/parser.ts`

**Interfaces:**
- Consumes: structured shell tokens and `decodeRecursiveInvocation`.
- Produces: `decodeDockerComposeRun(tokens): DockerComposeRunInvocation`; existing string extractor remains an adapter.

- [ ] **Step 1: Write failing boundary tests**

Assert this full supported form:

```ts
expect(decodeDockerComposeRun(lexShell(
  `docker compose -f compose.yml run --rm -e RAILS_ENV=test app sh -lc 'bundle exec rspec'`,
).tokens)).toMatchObject({ kind: 'recursive', service: 'app', script: 'bundle exec rspec' })
```

Assert `none` for option values, service names, and command arguments that merely contain shell-like text:

```ts
it.each([
  `docker compose run --name sh app bundle exec rspec`,
  `docker compose run app printf '%s' 'sh -c value'`,
  `docker compose run sh-service bundle exec rspec sh -c value`,
])('does not scan the Compose tail: %s', (command) => {
  expect(decodeDockerComposeRun(lexShell(command).tokens).kind).toBe('none')
})
```

Assert `indeterminate` for `docker compose --future value run app sh -c ok`, `docker compose run --entrypoint`, and `docker compose run --rm`.

Production mutations caught: `tokens.includes('run')`, tail-wide shell scans, option-value confusion, and missing service/option operands.

- [ ] **Step 2: Run and verify RED**

```bash
pnpm exec vitest run src/__tests__/verdict/docker-compose-run.test.ts
```

Expected: FAIL because the decoder does not exist.

- [ ] **Step 3: Implement option arity and positional parsing**

Use `Map<string, 0 | 1>` tables. Global arity-1 options are `--ansi`, `--env-file`, `-f/--file`, `--parallel`, `--profile`, `--progress`, `--project-directory`, and `-p/--project-name`; global flags are `--all-resources`, `--compatibility`, and `--dry-run`. Run value options are `--cap-add`, `--cap-drop`, `--entrypoint`, `-e/--env`, `--env-from-file`, `-l/--label`, `--name`, `-p/--publish`, `--pull`, `-u/--user`, `-v/--volume`, and `-w/--workdir`. Run flags are `--build`, `-d/--detach`, `-i/--interactive`, `--no-deps`, `-T/--no-tty`, `-q/--quiet`, `--quiet-build`, `--quiet-pull`, `--remove-orphans`, `--rm`, `-P/--service-ports`, and `--use-aliases`.

Parse `--option=value` only for arity-1 long options. Unknown options or missing values return `indeterminate`. After `run`, the first positional word is service and exactly the next word is command. Pass only command and its args to the interpreter decoder.

Use:

```ts
export type DockerComposeRunInvocation =
  | { kind: 'recursive'; service: string; interpreter: string; script: string }
  | { kind: 'dynamic'; service: string; signal: string }
  | { kind: 'none' }
  | { kind: 'indeterminate'; signal: 'shell.compose_argv_indeterminate' }
```

- [ ] **Step 4: Preserve compatibility, verify GREEN, and commit**

Implement `extractDockerComposeRunScript(string[])` as a non-authoritative adapter returning only non-empty static scripts.

```bash
pnpm exec vitest run \
  src/__tests__/verdict/docker-compose-run.test.ts \
  src/__tests__/verdict/parser-docker-compose.test.ts
git add src/core/verdict/docker-compose-run.ts src/core/verdict/parser.ts \
  src/__tests__/verdict/docker-compose-run.test.ts src/__tests__/verdict/parser-docker-compose.test.ts
git commit -m "fix: parse docker compose run argv boundaries"
```

---

### Task 5: Connect typed results to EffectPlan and prove monotonicity

**Files:**
- Modify: `src/core/effect-ir/shell-lower.ts`
- Modify: `src/__tests__/effect-ir/shell-lower.test.ts`
- Create: `src/__tests__/effect-ir/recursive-wrapper-monotonic.test.ts`

**Interfaces:**
- Consumes: `lexShell`, recursive decoder, Compose decoder.
- Produces: nested effects for static scripts and indeterminate requirements for dynamic/incomplete argv.

- [ ] **Step 1: Write failing EffectPlan tests**

For `sh -c ''`, assert complete analysis with no `shell.interpreter_argv_incomplete`. For `sh -c`, `python -c`, unknown Compose options, and missing Compose service, assert partial analysis and an `indeterminate` requirement by traversing the real EffectNode tree.

Production mutations caught: treating empty and missing scripts alike, or silently falling through malformed argv.

- [ ] **Step 2: Write the failing monotonic wrapper matrix**

Use literal base commands `git status`, `git push origin main`, and `rm -rf ../.git`. Generate base, single `sh -c`, double `sh -c`, and Compose `sh -c` forms. Rank verdicts `allow < allow_flagged < deny_pending_approval` and assert every wrapper is at least as strict as its base. Also assert static supported wrappers remain complete, while dynamic scripts remain partial.

Add explicit generated inputs at lowering depth 8/9 and wrapper-peel depth 32/33. Assert the first supported boundary retains nested effects and the next emits `shell.lower_depth_exceeded` or opaque indeterminate evidence.

- [ ] **Step 3: Run and verify RED**

```bash
pnpm exec vitest run \
  src/__tests__/effect-ir/shell-lower.test.ts \
  src/__tests__/effect-ir/recursive-wrapper-monotonic.test.ts
```

Expected: FAIL for typed malformed signals, empty script distinction, or monotonic cases that the old global scans misparse.

- [ ] **Step 4: Integrate exhaustive typed-result handling**

Lex once in `lowerSegment`. Keep string values for existing consumers and pass structured tokens only to the new decoders. Handle results as follows:

```ts
switch (recursive.kind) {
  case 'static': {
    requirements.push(
      processRequirement(recursive.interpreter, 'spawn', commandRedacted, [
        'shell.recursive_wrapper',
      ]),
    )
    if (recursive.script === '') {
      return shellSegment(commandRedacted, head, requirements, 'recursive', signals)
    }
    const nested = lowerTopLevelSegments(recursive.script, {
      ...context,
      command: recursive.script,
      env,
      depth: context.depth + 1,
    })
    for (const nestedSegment of nested) {
      requirements.push(
        ...nestedSegment.requirements.map((entry) =>
          withInnerProvenance(entry, recursive.script, head, commandRedacted),
        ),
      )
      for (const signal of nestedSegment.signals) signals.add(signal)
    }
    signals.add('shell.recursive_wrapper')
    return shellSegment(commandRedacted, head, requirements, 'recursive', signals)
  }
  case 'dynamic':
  case 'indeterminate': {
    requirements.push(
      processRequirement(recursive.interpreter, 'spawn', commandRedacted, [recursive.signal]),
      requirement('indeterminate', 'indeterminate', { kind: 'unknown' }, commandRedacted, [
        recursive.signal,
      ]),
    )
    signals.add(recursive.signal)
    return shellSegment(
      commandRedacted,
      head,
      requirements,
      joinEffectOpacity(opacity, 'opaque'),
      signals,
    )
  }
  case 'none':
    break
}
```

If lexing is incomplete, add `shell.grammar_incomplete`. Handle Compose `recursive`, `dynamic`, `indeterminate`, and `none` exhaustively; only `recursive` lowers a nested script. Preserve current depth increment, inner provenance, process spawn, and opacity behavior. Extract a shared nested-lowering helper only after tests are GREEN.

- [ ] **Step 5: Verify GREEN and commit**

```bash
pnpm exec vitest run \
  src/__tests__/shell-tokenizer.test.ts \
  src/__tests__/verdict/recursive-invocation.test.ts \
  src/__tests__/verdict/docker-compose-run.test.ts \
  src/__tests__/verdict/parser-docker-compose.test.ts \
  src/__tests__/effect-ir/shell-lower.test.ts \
  src/__tests__/effect-ir/recursive-wrapper-monotonic.test.ts
git add src/core/effect-ir/shell-lower.ts \
  src/__tests__/effect-ir/shell-lower.test.ts \
  src/__tests__/effect-ir/recursive-wrapper-monotonic.test.ts
git commit -m "fix: lower recursive argv with fail-closed boundaries"
```

---

### Task 6: Separate live tests and pin the runtime

**Files:**
- Create: `.node-version`
- Create: `vitest.live.config.ts`
- Modify: `.gitignore`
- Modify: `vitest.config.ts`
- Modify: `package.json`
- Modify: `src/__tests__/transactional-git-worktree.test.ts`

**Interfaces:**
- Consumes: existing `verify`, `verify-docker`, and local scripts.
- Produces: deterministic default suite, explicit Docker/LLM suites, Node 24 pin.

- [ ] **Step 1: Demonstrate current live-test collection**

```bash
pnpm exec vitest list | rg \
  'contained-execution-docker.integration|boundary-container-isolation|boundary-driver-container|judge-accuracy'
```

Expected: at least one live test appears, proving RED for the desired boundary.

- [ ] **Step 2: Add dedicated configuration and default exclusions**

Create `vitest.live.config.ts` with Node environment, existing setup file, and `testTimeout`/`hookTimeout` of `30_000`. Exclude these exact files from `vitest.config.ts`:

```ts
exclude: [
  'src/__tests__/capability/boundary-container-isolation.test.ts',
  'src/__tests__/capability/boundary-container-workspace-mount.test.ts',
  'src/__tests__/capability/boundary-driver-container.test.ts',
  'src/__tests__/contained-execution-docker.integration.test.ts',
  'src/__tests__/verdict/llm/judge-accuracy.test.ts',
],
```

Do not exclude fake-dependency `contained-execution-docker.test.ts`.

- [ ] **Step 3: Add explicit scripts**

Set `test:docker` to run the four excluded Docker files with `vitest.live.config.ts`, and add `test:llm` to run only `verdict/llm/judge-accuracy.test.ts` with that config. Both scripts build first.

- [ ] **Step 4: Pin and ignore local artifacts**

Create `.node-version` containing exactly `24`. Add `.pnpm-store/` beneath `# Dependencies` in `.gitignore`.

- [ ] **Step 5: Scope timeouts to real Git process tests**

In `transactional-git-worktree.test.ts`, define `GIT_PROCESS_TEST_TIMEOUT_MS = 15_000` and pass `{ timeout: GIT_PROCESS_TEST_TIMEOUT_MS }` only to async tests that initialize Git repositories or wait for process termination. Keep the unit global timeout unchanged.

- [ ] **Step 6: Verify collection and gates**

```bash
pnpm exec vitest list | rg \
  'contained-execution-docker.integration|boundary-container-isolation|boundary-driver-container|judge-accuracy'
test $? -eq 1
pnpm exec vitest list src/__tests__/contained-execution-docker.test.ts
pnpm exec vitest run src/__tests__/transactional-git-worktree.test.ts
pnpm test
pnpm test:docker
pnpm test:llm
```

Expected: default collection omits live tests and retains fake Docker unit tests. Default/Git gates pass. Dedicated suites pass with available substrates; otherwise their skip/failure is reported separately.

- [ ] **Step 7: Commit**

```bash
git add .node-version .gitignore vitest.config.ts vitest.live.config.ts package.json \
  src/__tests__/transactional-git-worktree.test.ts
git commit -m "test: separate live shell integration gates"
```

---

### Task 7: Run final safety verification

**Files:**
- Verify all Task 1–6 changes.

**Interfaces:**
- Consumes: implementation and Issue URL.
- Produces: fresh evidence for behavior, types, lint, build, authority, and scope.

- [ ] **Step 1: Run focused behavior tests**

```bash
pnpm exec vitest run \
  src/__tests__/shell-tokenizer.test.ts \
  src/__tests__/verdict/recursive-invocation.test.ts \
  src/__tests__/verdict/docker-compose-run.test.ts \
  src/__tests__/verdict/parser-docker-compose.test.ts \
  src/__tests__/effect-ir/shell-lower.test.ts \
  src/__tests__/effect-ir/recursive-wrapper-monotonic.test.ts
```

Expected: zero failed tests.

- [ ] **Step 2: Run repository gates**

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
git diff --check
```

Expected: all commands exit 0. Existing warnings are reported separately and must not originate in changed files.

- [ ] **Step 3: Verify source of truth and worktree scope**

```bash
rg -n "唯一の仕様正本|Issueは索引|ASKからALLOW" docs/issues/0004-unify-shell-scanners.md
gh issue list --repo guilz-dev/belay --state all \
  --search '"Shell scannerを単一解析結果へ段階統合する" in:title' \
  --json number,title,body,url
git status --short
```

Expected: Issue body is an index only; unrelated pre-existing untracked files remain untouched.

- [ ] **Step 4: Review the final diff against the approved spec**

Inspect only the files listed in Tasks 1–6. Confirm there is no scanner consolidation, command allowlist, or unrelated user-file change. If verification finds a defect, add a failing regression test before correcting production code; otherwise create no extra commit.
