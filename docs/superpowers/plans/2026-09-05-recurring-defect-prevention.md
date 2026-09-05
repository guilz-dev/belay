# Recurring Defect Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 直近の再発不具合を、マージ直前の統合保証、repository config の信頼固定、通知経路の縮権、Cursor 未知ツールの fail-closed、実 dogfood release gate の5層で再発しにくくする。

**Architecture:** 最初に GitHub Ruleset と merge queue を有効化し、以後の変更を「最新 `main` と統合した必須CI」の下で行う。プロダクト側は、raw repository config の明示的な trust record をユーザー管理領域に保存して gate 起動時に照合し、その上で通知・未知ツール・dogfood readiness を独立した境界として強化する。通常の `belay doctor` は助言を維持し、リリースを止める判定は `belay dogfood --check --since <ISO>` に分離する。

**Tech Stack:** TypeScript 5.9, Node.js 24, pnpm 10.29.3, Vitest 3, Biome, GitHub Actions, GitHub Rulesets / merge queue

**Spec:** `docs/investigations/2026-09-04-recurring-defects-and-prevention.md`

**Security input:** `docs/security-review-2026-08-30.md`（H-1〜H-4）

## Global Constraints

- Shell authorization authority は EffectPlan のみ。command allowlist を追加しない（ADR-004 / ADR-005）。
- Cursor の shell classification は `beforeShellExecution` の1回だけとし、`preToolUse` では Shell を評価・監査しない。
- Repository config の trust record は repo 内にも、repo config が指定できる `controlPlane.configDir` にも保存しない。常に `defaultControlPlaneDir()` 配下を使う。
- Trust mismatch、trust record 破損、raw config parse failure は gate で fail-closed にする。`doctor` と `config trust` は修復手順を表示する。
- Webhook に approval token を含めない。`notifications.commandHook` に approval token を環境変数で渡さない。
- `doctor` の全 warning を非ゼロ終了へ変更しない。リリース用の blocking check は dogfood subcommand に分離する。
- `fix` ラベル、PRタイトル、変更ファイル名、テスト差分の有無だけを理由に CI を失敗させる heuristic は追加しない。
- Ubuntu と macOS の既存CIを維持し、Docker boundary job も required check に含める。
- 各挙動変更は red-green-refactor で実装し、Task 単位でコミット・レビューする。

---

## File Structure

### Create

- `docs/adr/ADR-009-single-cursor-shell-gate.md` — shell classification の単一評価点を固定する。
- `docs/adr/ADR-010-repository-config-trust.md` — repository config trust record と fail-closed 契約を固定する。
- `docs/ops/merge-safety.md` — Ruleset、required checks、merge queue、break-glass 手順の運用記録。
- `src/core/repo-config-trust.ts` — raw repo config fingerprint、trust record path、read/write/verify を担当する。
- `src/__tests__/repo-config-trust.test.ts` — trust record の unit / filesystem tests。
- `src/__tests__/notify.test.ts` — webhook と command hook の縮権テスト。
- `src/__tests__/adapter-unmapped-tool-invariants.test.ts` — adapter 間の未知ツール契約を固定する。
- `src/core/dogfood-environment.ts` — linked worktree の dogfood skew 検出を `doctor` と release check で共有する。
- `src/commands/dogfood-check.ts` — 指定期間の dogfood release readiness を純粋に集計する。
- `scripts/pre-release-dogfood-check.sh` — ローカル dogfood target に blocking check を実行する薄いラッパー。

### Modify

- `.github/workflows/ci.yml` — `merge_group` で既存3 jobを起動する。
- `docs/CONTEXT.md` — config trust と single shell gate を normative invariant に追加する。
- `docs/adr/ADR-008-cursor-hook-source-precedence.md` — source ownership と shell classification cardinality の境界を明確にする。
- `src/config-io.ts` — trusted config write と layered config diagnostics を接続する。
- `src/adapters/shared/gate-runtime.ts` — raw config trust を layer merge より先に検証する。
- `src/core/config-layers.ts` — trust 検証後の layer merge だけを担当することを明文化する。
- `src/commands/config.ts` / `src/cli.ts` / `src/types.ts` — `belay config trust` と `belay dogfood --check --since` を公開する。
- `src/installer.ts` / `src/installer/scope-config.ts` / `src/commands/dogfood.ts` / `src/commands/judge.ts` / `src/commands/doctor.ts` — Belay 自身が config を正常更新した直後に trust record を更新する。
- `src/core/notify.ts` / `src/core/egress-approval.ts` / `src/commands/recovery-checkpoints.ts` / `src/core/recovery/operator-guidance.ts` — notification token と実行境界を縮める。
- `src/defaults.ts` / `src/adapters/cursor/runtime-entry.ts` / `src/adapters/cursor/hooks.ts` — unknown tool を gate へ到達させつつ Shell を `preToolUse` で再評価しない。
- `src/__tests__/config-layers.test.ts` / `src/__tests__/hooks-runtime.test.ts` / `src/__tests__/cursor-hooks.test.ts` / `src/__tests__/installer-scope.test.ts` / `src/__tests__/doctor.test.ts` / `src/__tests__/dogfood.test.ts` —新しい契約を固定する。
- `scripts/pre-release-check.sh` / `docs/ops/releasing.md` / `docs/ops/dogfood-install-targets.md` — release check の実行順を明記する。
- `docs/investigations/2026-09-04-recurring-defects-and-prevention.md` — 実施状況、優先度、KPIを実装結果に合わせる。

---

### Task 0: Baseline と作業分割を固定する

**Files:**
- Read: `docs/CONTEXT.md`
- Read: `docs/adr/ADR-004-effectplan-shell-authority.md`
- Read: `docs/adr/ADR-005-command-allowlist-prohibition.md`
- Read: `docs/adr/ADR-007-global-hook-workspace-resolution.md`
- Read: `docs/adr/ADR-008-cursor-hook-source-precedence.md`
- Read: `docs/security-review-2026-08-30.md`

**Interfaces:**
- Consumes: 現行 `main` と上記 normative docs。
- Produces: 以後の各PRが比較する green baseline と、PR順序 `merge-safety → ADRs → trust → notifications → unknown tools → dogfood check → closeout`。

- [ ] **Step 1: 最新 `main` を取得し、別 worktree を作る**

実行時は `superpowers:using-git-worktrees` に従い、既存worktreeと同名branchがないことを確認してから作成する。

Run:

```bash
git fetch origin
git worktree add ../belay-recurring-defect-prevention -b feat/recurring-defect-prevention origin/main
```

Expected: 新 worktree が `origin/main` と同じ commit から開始する。

- [ ] **Step 2: baseline quality gates を実行する**

Run:

```bash
pnpm lint
pnpm typecheck
pnpm test:stable
pnpm corpus
pnpm build
```

Expected: 全コマンド exit 0。失敗がある場合は本計画の変更と混ぜず、baseline defect として別修正する。

- [ ] **Step 3: PR分割を固定する**

Create one PR per task group:

```text
PR-A: Task 1
PR-B: Task 2
PR-C: Tasks 3-4
PR-D: Task 5
PR-E: Task 6
PR-F: Task 7
PR-G: Task 8
```

Expected: PR-C 以降は新しい merge queue を通す。PR-C は ADR-010 と trust 実装を同じレビュー単位にし、ADRだけ採択されて enforcement が未実装の期間を作らない。

---

### Task 1: CI を merge queue 対応にし、Ruleset を実効化する

**Files:**
- Modify: `.github/workflows/ci.yml:3-8`
- Create: `docs/ops/merge-safety.md`

**Interfaces:**
- Consumes: job names `verify`, `verify-docker`, `verify-macos`。
- Produces: `pull_request` と `merge_group` の双方で同名checkを報告するCI、および最新 `main` 上で直列検証する merge policy。

- [ ] **Step 1: `merge_group` trigger を追加する**

Edit `.github/workflows/ci.yml`:

```yaml
on:
  push:
    branches:
      - main
  pull_request:
  merge_group:
```

- [ ] **Step 2: workflow差分を静的確認する**

Run:

```bash
git diff --check
rg -n "pull_request|merge_group|verify-docker|verify-macos" .github/workflows/ci.yml
```

Expected: `merge_group` が `pull_request` と同じ3 jobを起動し、job名が変わっていない。

- [ ] **Step 3: 運用文書を書く**

`docs/ops/merge-safety.md` に次を明記する。

```text
- Required checks: verify, verify-docker, verify-macos
- Strict/up-to-date: enabled
- Merge queue: required
- Build concurrency: 1
- Maximum PRs to merge: 1
- Only merge non-failing PRs: enabled
- Check timeout: 30 minutes
- OrganizationAdmin always-bypass: removed
- Emergency bypass: incident reasonをPR timelineとpostmortemに記録し、main CI確認までrelease禁止
```

- [ ] **Step 4: PR-A を通常手順でmergeする**

Run before merge:

```bash
pnpm lint
pnpm typecheck
pnpm test:stable
pnpm corpus
```

Expected: PR checks が green。これは `merge_group` 有効化前に必要な bootstrap merge である。

- [ ] **Step 5: GitHub Rulesetを更新する**

Repository Settings → Rules → Rulesets → `require-review` で、Task 1 Step 3 の設定を適用する。既存の PR requirement と force-push/deletion protection は維持する。

- [ ] **Step 6: Ruleset を read-only API で検証する**

Run:

```bash
gh api repos/guilz-dev/belay/rulesets
gh api repos/guilz-dev/belay/rulesets/17656073
```

Expected: active rules に `required_status_checks` と `merge_queue` があり、3 job が列挙され、`OrganizationAdmin` の `bypass_mode: always` が存在しない。

- [ ] **Step 7: 最初の実変更で merge queue smoke test を行う**

PR-B（Task 2）を最初のqueue対象にする。Actionsで event=`merge_group` の run が作られ、3 required checks が green になった後だけ merge されることを確認する。検証専用の無意味な差分は作らない。

---

### Task 2: Single Cursor shell gate を ADR と domain invariant にする

**Files:**
- Create: `docs/adr/ADR-009-single-cursor-shell-gate.md`
- Modify: `docs/adr/ADR-008-cursor-hook-source-precedence.md:88-97`
- Modify: `docs/CONTEXT.md`
- Test: `src/__tests__/cursor-hooks.test.ts`
- Test: `src/__tests__/hooks-runtime.test.ts`
- Test: `src/__tests__/cursor-hook-precedence.integration.test.ts`

**Interfaces:**
- Consumes: `getManagedHookEntries()`, `handleShellGateHook()`, `handleToolGateHook()`。
- Produces: 「source owner selection」と「shell classification cardinality」を分離した normative contract。

- [ ] **Step 1: ADR-009を書く**

ADRのDecisionを次で固定する。

```text
1. Cursor shell classification の唯一の authority point は beforeShellExecution。
2. managed hooks は matcher=Shell の preToolUse entry を生成しない。
3. unfiltered preToolUse が将来導入されても tool_name=Shell は neutral allow とし、policy evaluation・approval state・audit appendを行わない。
4. upgrade/uninstall は legacy Belay preToolUse:Shell entryだけをexact-matchで除去し、第三者hookを保持する。
5. ADR-008 は source間ownerを選ぶ規則であり、異なるeventをcollapseする規則ではない。
```

- [ ] **Step 2: ADR-008 Limits と CONTEXT を同期する**

ADR-008の `beforeShellExecution` / `preToolUse: Shell` 例に「legacyまたは第三者hookの説明であり、Belay managed shell gateではない」を追記する。`docs/CONTEXT.md` に single shell classification invariant を追加する。

- [ ] **Step 3: 既存contract testsを実行する**

Run:

```bash
pnpm exec vitest run \
  src/__tests__/cursor-hooks.test.ts \
  src/__tests__/hooks-runtime.test.ts \
  src/__tests__/cursor-hook-precedence.integration.test.ts
```

Expected: fresh install / upgrade / one-audit-event の既存テストが全てpassする。

- [ ] **Step 4: Commit**

```bash
git add docs/adr/ADR-009-single-cursor-shell-gate.md docs/adr/ADR-008-cursor-hook-source-precedence.md docs/CONTEXT.md
git commit -m "docs: codify the single Cursor shell gate"
```

---

### Task 3: Repository config trust boundary をADR化する

**Files:**
- Create: `docs/adr/ADR-010-repository-config-trust.md`
- Modify: `docs/CONTEXT.md`
- Modify: `SECURITY.md`

**Interfaces:**
- Consumes: `defaultControlPlaneDir()`, `canonicalPath()`, `canonicalStringify()`, `hashValue()`。
- Produces: Task 4が実装する `RepoConfigTrustRecordV1` と gate fail-closed contract。

- [ ] **Step 1: ADR-010にthreat boundaryを書く**

次を明記する。

```text
- Repository fileは、Belay CLIで明示的にtrustされるまでpolicy authorityを持たない。
- Cursor workspace trustはhost側の前提だが、Belay config trustの代替にはしない。
- 同一OS userがdefault control-planeを書き換えられる環境は保証外。separate-user isolationがstrong boundary。
- Team configはuser-managed input、repo configはworkspace-managed inputとして区別する。
- Project hook/runtime自体を悪意あるtrusted workspaceが置換する攻撃はintegrity/isolationの別境界であり、本ADRはconfig authorityだけを閉じる。
```

- [ ] **Step 2: record schema と path derivation を固定する**

ADRに次のschemaを記載する。

```ts
interface RepoConfigTrustRecordV1 {
  schemaVersion: 1
  repoRoot: string
  adapter: 'cursor' | 'claude' | 'codex'
  repoConfigFingerprint: string
  trustedAt: string
}
```

Path:

```text
<defaultControlPlaneDir>/config-trust/<sha256(canonicalRepoRoot + "\0" + adapter)>.json
```

Fingerprint:

```text
sha256(canonicalStringify(parsed raw repo config))
```

- [ ] **Step 3: lifecycleを固定する**

```text
- init / upgrade / dogfood / config set|unset|judge / doctor --fix が正常にconfigを書いた直後はrecordをatomic updateする。
- 手動編集後はgate deny。`belay config trust` が現在内容を表示し、明示実行時だけrecordを更新する。
- missing / malformed / repoRoot mismatch / adapter mismatch / fingerprint mismatch は全てuntrusted。
- `belay doctor` はuntrustedをissueとして報告しexit 1。
- trust recordは0o600、親directoryは0o700。
```

- [ ] **Step 4: domain docsを同期する**

`docs/CONTEXT.md` に config authority invariant、`SECURITY.md` に保証範囲と recovery command を追加する。

- [ ] **Step 5: Commit**

```bash
git add docs/adr/ADR-010-repository-config-trust.md docs/CONTEXT.md SECURITY.md
git commit -m "docs: define repository config trust boundary"
```

---

### Task 4: Repository config trust record をgate前段へ実装する

**Files:**
- Create: `src/core/repo-config-trust.ts`
- Create: `src/__tests__/repo-config-trust.test.ts`
- Modify: `src/config-io.ts`
- Modify: `src/adapters/shared/gate-runtime.ts:329-347`
- Modify: `src/commands/config.ts`
- Modify: `src/cli.ts`
- Modify: `src/types.ts`
- Modify: `src/installer.ts`
- Modify: `src/installer/scope-config.ts`
- Modify: `src/commands/dogfood.ts`
- Modify: `src/commands/judge.ts`
- Modify: `src/commands/doctor.ts`
- Test: `src/__tests__/config-layers.test.ts`
- Test: `src/__tests__/hooks-runtime.test.ts`
- Test: `src/__tests__/doctor.test.ts`

**Interfaces:**
- Consumes: ADR-010 record schema。
- Produces:

```ts
export type RepoConfigTrustStatus =
  | { trusted: true; recordPath: string; fingerprint: string }
  | { trusted: false; recordPath: string; reason: 'missing' | 'malformed' | 'identity_mismatch' | 'fingerprint_mismatch' }

export function repoConfigFingerprint(rawConfig: unknown): string
export function repoConfigTrustPath(repoRoot: string, adapter: AdapterName): string
export async function inspectRepoConfigTrust(repoRoot: string, adapter: AdapterName, rawConfig: unknown): Promise<RepoConfigTrustStatus>
export async function trustRepoConfig(repoRoot: string, adapter: AdapterName, rawConfig: unknown): Promise<RepoConfigTrustRecordV1>
export async function assertRepoConfigTrusted(repoRoot: string, adapter: AdapterName, rawConfig: unknown): Promise<void>
```

- [ ] **Step 1: trust testsをREDにする**

Add tests covering:

```ts
it('writes a canonical identity record with 0600 permissions')
it('accepts the unchanged raw repo config')
it('rejects a manually edited repo config')
it('rejects malformed and identity-rebound records')
it('uses defaultControlPlaneDir even when repo config names another configDir')
it('treats symlink-equivalent repo roots as one identity')
```

Run:

```bash
pnpm exec vitest run src/__tests__/repo-config-trust.test.ts
```

Expected: FAIL because `repo-config-trust.ts` does not exist.

- [ ] **Step 2: trust storeを最小実装する**

Use `canonicalPath(repoRoot)`, `canonicalStringify(rawConfig)`, `hashValue()`, and an atomic `writeFile(temp, { mode: 0o600 }) → rename → chmod` sequence. Validate every parsed field and reject extra fields so a rebound record cannot be accepted accidentally.

- [ ] **Step 3: unit testsをGREENにする**

Run:

```bash
pnpm exec vitest run src/__tests__/repo-config-trust.test.ts
```

Expected: PASS.

- [ ] **Step 4: gate trust mismatch testをREDにする**

In `hooks-runtime.test.ts`, initialize a repo, modify `.cursor/belay.config.json` with `fs.writeFile` after initialization, then invoke shell and tool gates. Assert both return deny with:

```text
Repository config is not trusted. Review it, then run `belay config trust`.
```

Also assert no approval record is minted from the untrusted config.

- [ ] **Step 5: `resolveGateConfig`でlayer merge前に検証する**

Required order:

```ts
const rawRepoConfig = await deps.readConfig(ctx.configPath)
await assertRepoConfigTrusted(ctx.repoRoot, ctx.layout.name, rawRepoConfig)
return resolveLayeredConfig({ repoConfig: rawRepoConfig, ... }).config
```

Do not derive the trust path from `rawRepoConfig.controlPlane.configDir`.

- [ ] **Step 6: Belay-originated writesをatomic trust updateにする**

Add `writeTrustedConfigFile(repoRoot, config, adapter)` in `config-io.ts`. It must write config atomically, re-read the parsed file, then update the trust record. Replace production command call sites listed in the Files section; keep low-level `writeConfigFile` available for tests that intentionally create an untrusted edit.

- [ ] **Step 7: `belay config trust`を追加する**

Add `trust` to `BELAY_CONFIG_SUBCOMMANDS`. `runBelayConfig({ subcommand: 'trust' })` reads the raw config without gate enforcement, writes the trust record, refreshes integrity if pinned, and returns:

```text
Trusted repository config <fingerprint-prefix> for <canonical-repo-root>.
```

Reject `config trust` when the config JSON is malformed.

- [ ] **Step 8: doctor diagnosisを追加する**

`doctorProject()` calls `inspectRepoConfigTrust()` and pushes one issue for any untrusted status. `--fix` must not auto-trust arbitrary manual edits; its message points to `belay config trust`.

- [ ] **Step 9: focused testsをGREENにする**

Run:

```bash
pnpm exec vitest run \
  src/__tests__/repo-config-trust.test.ts \
  src/__tests__/config-layers.test.ts \
  src/__tests__/hooks-runtime.test.ts \
  src/__tests__/doctor.test.ts \
  src/__tests__/dogfood.test.ts
pnpm typecheck
```

Expected: PASS; config layer precedence tests remain unchanged after trust succeeds.

- [ ] **Step 10: Commit**

```bash
git add \
  src/core/repo-config-trust.ts \
  src/__tests__/repo-config-trust.test.ts \
  src/config-io.ts \
  src/adapters/shared/gate-runtime.ts \
  src/commands/config.ts \
  src/cli.ts \
  src/types.ts \
  src/installer.ts \
  src/installer/scope-config.ts \
  src/commands/dogfood.ts \
  src/commands/judge.ts \
  src/commands/doctor.ts \
  src/__tests__/config-layers.test.ts \
  src/__tests__/hooks-runtime.test.ts \
  src/__tests__/doctor.test.ts
git commit -m "feat: require explicit trust for repository config"
```

---

### Task 5: Notification paths から token と repo-controlled execution を除く

**Files:**
- Modify: `src/core/notify.ts`
- Modify: `src/adapters/shared/gate-runtime.ts`
- Modify: `src/core/egress-approval.ts`
- Modify: `src/commands/recovery-checkpoints.ts`
- Modify: `src/core/recovery/operator-guidance.ts`
- Create: `src/__tests__/notify.test.ts`
- Modify: `src/__tests__/config-layers.test.ts`
- Modify: `docs/adr/ADR-010-repository-config-trust.md`
- Modify: `SECURITY.md`

**Interfaces:**
- Consumes: trusted repository config from Task 4。
- Produces:

```ts
export interface NotifyDependencies {
  fetch: typeof globalThis.fetch
  execFile: (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => Promise<unknown>
}

export function notificationConfigIssues(config: DenyNotificationConfig, repoRoot: string): string[]
```

`DenyNotificationEvent` no longer contains `approvalToken`.

- [ ] **Step 1: notification testsをREDにする**

Cover these cases with injected dependencies:

```ts
it('never serializes an approval token to a webhook')
it('never exposes BELAY_APPROVAL_TOKEN to command hooks')
it('rejects non-HTTPS remote webhook URLs')
it('allows HTTP only for localhost, 127.0.0.1, and ::1')
it('rejects relative command hooks')
it('rejects command hooks located inside the repository')
it('keeps deny notification failure best-effort')
```

- [ ] **Step 2: dependency injection と validationを実装する**

Build webhook JSON from an explicit allowlist:

```ts
const payload = JSON.stringify({
  approvalId: event.approvalId,
  reason: event.reason,
  summary: event.summary,
  repoRoot: event.repoRoot,
  fingerprint: event.fingerprint,
})
```

Command env may include the five non-token `BELAY_*` fields above. Do not add `BELAY_APPROVAL_TOKEN`.

- [ ] **Step 3: call sitesからtokenを削除する**

Keep issuing the signed token for the local approval UX, but do not pass it into `notifyDeny()`. Update gate, egress approval, and recovery checkpoint call sites.

- [ ] **Step 4: doctorへconfiguration issuesを接続する**

Invalid webhook scheme、relative command hook、repo-contained command hook are `doctor` issues. Runtime notification remains best-effort and skips invalid destinations without weakening the original deny verdict.

- [ ] **Step 5: testsをGREENにする**

Run:

```bash
pnpm exec vitest run \
  src/__tests__/notify.test.ts \
  src/__tests__/config-layers.test.ts \
  src/__tests__/capability-gate-runtime.test.ts \
  src/__tests__/recovery-checkpoint.test.ts
pnpm typecheck
```

Expected: PASS and serialized webhook/command env contains no signed token.

- [ ] **Step 6: Commit**

```bash
git add \
  src/core/notify.ts \
  src/adapters/shared/gate-runtime.ts \
  src/core/egress-approval.ts \
  src/commands/recovery-checkpoints.ts \
  src/core/recovery/operator-guidance.ts \
  src/__tests__/notify.test.ts \
  src/__tests__/config-layers.test.ts \
  docs/adr/ADR-010-repository-config-trust.md \
  SECURITY.md
git commit -m "fix: remove approval authority from notifications"
```

---

### Task 6: Cursor unknown tools を実際の gate path で fail-closed にする

**Files:**
- Modify: `src/defaults.ts:67-145`
- Modify: `src/adapters/cursor/runtime-entry.ts:240-310`
- Modify: `src/adapters/cursor/hooks.ts`
- Modify: `src/__tests__/cursor-hooks.test.ts`
- Modify: `src/__tests__/hooks-runtime.test.ts`
- Modify: `src/__tests__/installer-scope.test.ts`
- Create: `src/__tests__/adapter-unmapped-tool-invariants.test.ts`
- Modify: `docs/adr/ADR-009-single-cursor-shell-gate.md`
- Modify: `docs/CONTEXT.md`

**Interfaces:**
- Consumes: `evaluateGatedAction(ctx, deps, { kind: 'tool', toolName, payload, sourceEvent })`。
- Produces: one managed `preToolUse` entry without matcher, Shell-neutral routing, unknown tool policy evaluation and audit.

- [ ] **Step 1: managed hook testsをREDにする**

Assert fresh install emits exactly one Belay-managed `preToolUse` definition without `matcher`, rather than separate `Task` / `Write` / `StrReplace` / `Delete` entries. Assert third-party matched hooks survive merge/upgrade/uninstall.

- [ ] **Step 2: single-shell invariant testsをREDにする**

Invoke the unfiltered `preToolUse` with `tool_name: 'Shell'`, then `beforeShellExecution`. Assert:

```text
preToolUse response = allow
preToolUse gate/audit records = 0
beforeShellExecution shell gate/audit records = 1
```

- [ ] **Step 3: unknown tool invariant testsをREDにする**

For `tool_name: 'FutureMutationTool'`:

```text
Cursor enforce => deny and one tool audit record
Cursor audit   => allow with wouldBlock evidence
Claude/Codex   => their existing unmapped-tool fail-closed result remains unchanged
```

- [ ] **Step 4: managed hook registrationをunfiltered entryへ置換する**

Reuse the existing `toolGate` command with no matcher. Exact-match migration must remove only prior Belay-managed matcher entries; unrelated user entries remain.

- [ ] **Step 5: runtime routingを実装する**

Required order in `handleToolGateHook()`:

```ts
if (toolName === 'Shell') return { permission: 'allow' }
if (isSubagentEvent(payload, eventName)) { /* existing subagent path */ }
if (isFileMutationTool(toolName)) { /* existing tool path */ }
if (toolName === 'Task') { /* existing Task path */ }
return gateVerdictToCursorResponse(await evaluateGatedAction(ctx, deps, {
  kind: 'tool', cwd, payload, toolName, sourceEvent: eventName,
}))
```

Do not add a command-name allowlist or direct unconditional deny; audit mode must preserve its advisory semantics.

- [ ] **Step 6: focused testsをGREENにする**

Run:

```bash
pnpm exec vitest run \
  src/__tests__/cursor-hooks.test.ts \
  src/__tests__/hooks-runtime.test.ts \
  src/__tests__/installer-scope.test.ts \
  src/__tests__/adapter-unmapped-tool-invariants.test.ts \
  src/__tests__/cursor-hook-precedence.integration.test.ts
pnpm corpus
```

Expected: unknown tools no longer silently bypass; shell gate count remains one.

- [ ] **Step 7: Commit**

```bash
git add \
  src/defaults.ts \
  src/adapters/cursor/runtime-entry.ts \
  src/adapters/cursor/hooks.ts \
  src/__tests__/cursor-hooks.test.ts \
  src/__tests__/hooks-runtime.test.ts \
  src/__tests__/installer-scope.test.ts \
  src/__tests__/adapter-unmapped-tool-invariants.test.ts \
  docs/adr/ADR-009-single-cursor-shell-gate.md \
  docs/CONTEXT.md
git commit -m "fix: gate unmapped Cursor tools without duplicating shell evaluation"
```

---

### Task 7: Blocking dogfood release check を通常doctorから分離する

**Files:**
- Create: `src/core/dogfood-environment.ts`
- Create: `src/commands/dogfood-check.ts`
- Create: `scripts/pre-release-dogfood-check.sh`
- Modify: `src/commands/doctor.ts:163-220,623-683`
- Modify: `src/commands/dogfood.ts`
- Modify: `src/cli.ts`
- Modify: `src/types.ts`
- Modify: `src/__tests__/doctor.test.ts`
- Modify: `src/__tests__/dogfood.test.ts`
- Modify: `docs/ops/releasing.md`
- Modify: `docs/ops/dogfood-install-targets.md`

**Interfaces:**
- Consumes: `loadAuditRecords()`, `resolveActiveAuditCohort()`, `matchesAuditCohort()`, `summarizeAuditVisibility()`。
- Produces:

```ts
export interface DogfoodCheckOptions {
  targetDir?: string
  adapter?: AdapterName
  since: string
}

export interface DogfoodCheckResult {
  ok: boolean
  repoRoot: string
  since: string
  gateEvents: number
  auditModeDenyCount: number
  hostDeniedAfterAllowCount: number
  shellPreToolUseCount: number
  mismatchedCohortCount: number
  environmentSkewCount: number
  failures: string[]
}

export async function checkDogfoodProject(options: DogfoodCheckOptions): Promise<DogfoodCheckResult>
```

- [ ] **Step 1: environment detectorをextractする**

Move `listLinkedWorktreePaths()` and `detectUndogfoodedLinkedWorktrees()` from `doctor.ts` to `src/core/dogfood-environment.ts`. Preserve current warning strings and doctor behavior exactly.

- [ ] **Step 2: extraction regression testsを実行する**

Run:

```bash
pnpm exec vitest run src/__tests__/doctor.test.ts
```

Expected: existing linked-worktree warning test passes unchanged.

- [ ] **Step 3: dogfood check testsをREDにする**

Add deterministic fixtures for each blocking condition:

```text
- invalid --since
- dogfood mode inactive
- zero gate events since cutoff
- audit mode permission=deny
- hostDeniedAfterAllowCount > 0
- shell event recorded as preToolUse
- gate event not matching active runtime/config cohort
- linked worktree missing dogfood config
- clean current cohort with zero failures
```

- [ ] **Step 4: check implementationをGREENにする**

有効なISO timestampを持つrecordだけをcutoffと比較し、期間内のcountを計算する。読み込んだrecordにtimestamp欠落・不正値が1件でもあれば、期間判定不能として `invalid_timestamp_record` をfailureへ追加する。

- [ ] **Step 5: CLIを追加する**

Support:

```bash
belay dogfood --check --since 2026-09-05T00:00:00Z [--target <dir>] [--adapter ...] [--json]
```

Rules:

```text
--check requires --since
--check conflicts with --enforce and --force
exit 0 only when result.ok is true
exit 1 for any readiness failure
```

- [ ] **Step 6: release wrapperを書く**

`scripts/pre-release-dogfood-check.sh` accepts exactly `<target-dir> <since-iso>`, runs `pnpm build`, then:

```bash
node dist/cli.js dogfood --check --target "$target_dir" --since "$since_iso"
```

It must not discover or mutate sibling repositories automatically.

- [ ] **Step 7: release docsを更新する**

Before tagging, require the command for every active local target listed in `dogfood-install-targets.md`. Record the cutoff timestamp and output in the release PR. Do not add this local-log check to public GitHub CI.

- [ ] **Step 8: focused testsをGREENにする**

Run:

```bash
pnpm exec vitest run src/__tests__/doctor.test.ts src/__tests__/dogfood.test.ts
pnpm typecheck
pnpm lint
```

- [ ] **Step 9: Commit**

```bash
git add \
  src/core/dogfood-environment.ts \
  src/commands/dogfood-check.ts \
  scripts/pre-release-dogfood-check.sh \
  src/commands/doctor.ts \
  src/commands/dogfood.ts \
  src/cli.ts \
  src/types.ts \
  src/__tests__/doctor.test.ts \
  src/__tests__/dogfood.test.ts \
  docs/ops/releasing.md \
  docs/ops/dogfood-install-targets.md
git commit -m "feat: add a blocking dogfood release check"
```

---

### Task 8: Investigation status とKPIを実装結果へ合わせる

**Files:**
- Modify: `docs/investigations/2026-09-04-recurring-defects-and-prevention.md:192-279`
- Modify: `.github/pull_request_template.md:22-30`

**Interfaces:**
- Consumes: Tasks 1-7 の merged PR URLs と verification results。
- Produces: 実装済みcontrolと、運用上測定可能な再発指標。

- [ ] **Step 1: statusを更新する**

Mark only controls with merged code/settings and observed smoke evidence as `実施済み`. Replace owner fields with the responsible surface, not a person:

```text
GitHub Ruleset
CI
Belay runtime
Release operator
```

- [ ] **Step 2: 効果の薄いheuristicを削除する**

Remove these proposed gates/KPIs:

```text
- hot-file専用vitest（full suite required checkで代替）
- genericな「両PR変更残存」自動検出（merge queue + invariant testsで代替）
- fix PRのtest差分必須
- restore/regress/lostというPRタイトル件数
- fix commit比率を品質目標として使うこと
- managed hooks全体のsnapshot（explicit behavioral assertionsを維持）
```

- [ ] **Step 3: KPIを置換する**

Use:

```text
- Ruleset bypass merge count: 0
- merge_group required-check failure count: trend and root cause
- mainへ到達したescaped defect数 / release: 0
- 同一invariantの再発数: 0
- open High security finding age: 0日を目標に即時triage
- hostDeniedAfterAllowCount in release window: 0
- audit-mode deny count in release window: 0
- mismatched active cohort count in release window: 0
- corpus must-ask misses: 0
```

- [ ] **Step 4: PR templateを短くする**

Replace manual combined-vitest block with:

```markdown
## Integration risk

- [ ] overlapping open/recent PRs identified
- [ ] behavior-level invariant added or named
- [ ] merge queue required checks passed on latest main
- [ ] break-glass bypass not used (or incident link supplied)
```

- [ ] **Step 5: Docs verification**

Run:

```bash
pnpm lint
rg -n "test差分が無ければ|fix コミット比率|restore.*regress.*lost" \
  docs/investigations/2026-09-04-recurring-defects-and-prevention.md \
  .github/pull_request_template.md
```

Expected: lint passes; removed heuristic language has zero matches.

- [ ] **Step 6: Commit**

```bash
git add docs/investigations/2026-09-04-recurring-defects-and-prevention.md .github/pull_request_template.md
git commit -m "docs: align recurrence controls with enforced gates"
```

---

## Final Verification

- [ ] Run complete local gates:

```bash
pnpm lint
pnpm typecheck
pnpm test:structural
pnpm test:stable
pnpm corpus
pnpm build
pnpm check:version
```

- [ ] Confirm the core security invariants directly:

```bash
pnpm exec vitest run \
  src/__tests__/repo-config-trust.test.ts \
  src/__tests__/notify.test.ts \
  src/__tests__/adapter-unmapped-tool-invariants.test.ts \
  src/__tests__/cursor-hooks.test.ts \
  src/__tests__/hooks-runtime.test.ts \
  src/__tests__/cursor-hook-precedence.integration.test.ts \
  src/__tests__/doctor.test.ts \
  src/__tests__/dogfood.test.ts
```

- [ ] Queue the final closeout PR and confirm event=`merge_group` reports `verify`, `verify-docker`, and `verify-macos` green.
- [ ] Run `scripts/pre-release-dogfood-check.sh <target> <cutoff>` for every active dogfood target before the next package tag.
- [ ] Confirm `gh api repos/guilz-dev/belay/rulesets/17656073` contains required checks and merge queue, with no always-bypass actor.

## Success Criteria

- [ ] No PR can merge without the three required checks passing against the latest queued `main` state.
- [ ] A manually modified repository config cannot influence gate policy until `belay config trust` succeeds.
- [ ] Config trust mismatch fails closed before policy evaluation, approval creation, notification, or audit mutation.
- [ ] Webhook and command-hook notifications never receive signed approval tokens.
- [ ] Cursor unknown tools reach policy evaluation; audit mode remains advisory and enforce mode fails closed.
- [ ] One Cursor shell action creates exactly one shell classification and one gate audit event.
- [ ] Release dogfood check fails for host denial, audit deny, legacy shell gate, cohort mismatch, or worktree config skew.
- [ ] The investigation reports enforced controls and outcome metrics rather than naming/file-diff heuristics.

## Explicitly Deferred

| Item | Reason |
|---|---|
| Automatic recursive config propagation | Policy files must not be copied to sibling worktrees without an explicit target and dry-run review. Add only if post-release metrics show repeated skew after Task 7. |
| Changing the default mode from `enforce` | Product semantics and first-run UX require a separate decision. The current incident is handled by explicit environment diagnosis and release checks. |
| Making every `doctor` warning exit non-zero | Existing advisory warnings include intentionally accepted best-effort states. Blocking semantics belong to `dogfood --check`. |
| Release cadence throttling | Merge serialization and required integration checks address the causal mechanism without imposing a time-based proxy. |
| Generic conflict-resolution detector | Git cannot infer semantic intent. Merge queue plus behavior-level invariants is the enforceable boundary. |
