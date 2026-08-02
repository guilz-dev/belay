# trustedWorkspaceRoots design

## 背景

Cursor の `plan` 編集は、実体としては `Write` / `StrReplace` / `Delete` などの file-mutation tool として belay に入ります。

現行コードでは、通常の L3 判定では repo 外でも「ローカルで復元可能な文書」であれば通す設計です。実際に以下の意図がコードとドキュメントにあります。

- `src/core/classify-tool.ts`
  - repo 外ファイル編集は Tier1 で「local recoverable」なら `allow_flagged`
- `src/__tests__/classify-tool.test.ts`
  - `~/.cursor/plans/foo.plan.md` への write は allow するテストがある
- `README.md` / `docs/CONCEPT.md`
  - IDE plan files は default L3 では allow する前提

一方で、`sandbox.enabled === true` かつ `sandbox.runtime !== "none"` のときは、`src/core/gate-engine.ts` の fs boundary が優先されます。

- `collectOutsideRepoPaths*` で repo 外 path を抽出
- `applySandboxFsScopeBoundary()` が `outside_repo_mutation` / `outside_repo_redirect` に強制変換
- `approved_once` は `shouldSkipBrokerApprovedOnce()` により無効化される
- 現行の `--scope path` は `src/core/capability-approval.ts` 上、実質 outside-repo shell 起点の承認文脈で設計されている

このため、Cursor plan のような「危険ではないが git 管理外のローカル文書」は、sandbox 有効時だけ UX が崩れます。

## 問題の本質

問題は「repo 外 path をすべて deny している」ことではなく、次の 2 つが分離されていないことです。

1. 単なる OS 境界の例外
2. git 管理外だが、ユーザーが workspace として信頼してよいローカル root

現行の fs-scope allowlist は 1 のための仕組みです。今回ほしいのは 2 です。

`~/.cursor/plans` のような場所は、`/tmp` や任意の外部ディレクトリと同じ「outside-repo path」ではあるものの、ユーザー体験上は repo 内ファイルに近い扱いにしたいです。

## 要求の整理

- 編集が止まったとき、その対象が git 管理外のローカルディレクトリなら「信頼済みディレクトリに追加するか」を確認できること
- 追加されたディレクトリ配下は、以後 repo-local と同等の扱いにすること
- ただし以下は緩めないこと
  - control plane 保護
  - `.env` や `~/.ssh/authorized_keys` などの高リスク path 保護
  - 別の git repository を暗黙に同一 workspace 扱いすること

## 命名

### 推奨名

内部名・設定名は `trustedWorkspaceRoots` を推奨します。

### 理由

- `trustedDirectory` だと単一ディレクトリに見えるが、実体は複数 root の集合
- `trustedDirectories` だと「任意の許可済み外部パス」に寄りすぎ、今回の「repo 相当として扱う root」という意味が弱い
- 既存コードは `repoRoot` / `protectedArtifactRoots` / `controlPlaneDir` のように root 指向で整理されている
- 「git 管理外だが workspace として信頼する」という意味を最も誤解なく表せる

### 用語

- UI 文言: `Trusted workspace root`
- TypeScript / JSON key: `trustedWorkspaceRoots`
- 永続化ファイル名: `trusted-workspace-roots.json`

## 現行コードベースに対する適切な設計

### 1. 新しい概念: trusted workspace root

`repoRoot` はそのまま維持しつつ、追加の local root を持てるようにします。

- primary root: 現在の `repoRoot`
- secondary roots: `trustedWorkspaceRoots`

判定上は、対象 path が `repoRoot` または `trustedWorkspaceRoots` のいずれかに含まれていれば `workspace-local` とみなします。

ただし公開上の verdict 語彙は極力増やさず、既存の `repo_local` 相当の扱いを再利用します。監査・信号だけで `trusted_workspace_root` を区別します。

これは現行コードへの影響を最小化できます。

### 2. trustedWorkspaceRoots は config ではなく state として持つ

初期実装では repo 設定ではなく state file に持つべきです。

理由:

- 追加契機が runtime 上のユーザー確認である
- 絶対 path を repo の設定ファイルに混ぜると共有に向かない
- 既存の `pending-approvals.json` / `approved-approvals.json` / `fs-scope-allowlist.json` と同じ運用に乗せられる
- `controlPlane.enabled` 時は `belayStateDir()` によって自然に user-wide に共有できる

保存先:

- `path.join(belayStateDir(config, repoLocalStateDir), "trusted-workspace-roots.json")`

想定 schema:

```json
{
  "version": 1,
  "roots": [
    {
      "path": "/Users/kaz/.cursor/plans",
      "approvedAt": "2026-06-17T00:00:00.000Z",
      "approvalId": "belay_abc123",
      "source": "approval"
    }
  ]
}
```

## なぜ fs-scope allowlist に一本化しないか

既存の `fs-scope-allowlist.json` は「outside-repo でも sandbox 境界を越えてよい path prefix」です。

これは以下の点で今回の要求とズレます。

- path exception であって workspace semantic ではない
- `src/core/capability-approval.ts` の説明も shell 寄り
- 判定結果は `capability_fs_hint` のままで、repo-local 相当にはならない
- UX 上「plan 用の信頼済み領域」として説明しづらい

したがって、

- `fs-scope allowlist`: OS 境界例外
- `trustedWorkspaceRoots`: repo-local semantic の追加 root

として分けるのが適切です。

## runtime 判定の変更方針

### 1. path helper の一般化

現在は `relativeWithinRepo(repoRoot, targetPath)` に repo 1 本で依存しています。
これを直接置き換えるのではなく、新しい helper を追加します。

候補:

- `resolveWorkspaceRootMatch(primaryRoot, trustedRoots, targetPath)`
- `pathWithinWorkspaceRoots(primaryRoot, trustedRoots, targetPath)`
- `relativeWithinWorkspace(primaryRoot, trustedRoots, targetPath)`

返り値のイメージ:

```ts
type WorkspaceRootMatch =
  | { kind: 'repo'; root: string; relativePath: string }
  | { kind: 'trusted'; root: string; relativePath: string }
  | null
```

### 2. tool 判定

`src/core/classify-tool.ts` の変更方針:

- `relativeWithinRepo(...) === null` の分岐を `resolveWorkspaceRootMatch(...) === null` に置換
- `kind: "trusted"` であっても `sensitivePaths` は relative path ベースで評価する
- `protectedArtifactRoots` は従来通り最優先で deny
- allow 時は signal に `trusted_workspace_root` を追加

これにより `~/.cursor/plans/foo.plan.md` は、信頼済み root 登録後は repo-local の file mutation と同じ流れに入れます。

### 3. shell 判定

`src/core/capability/paths.ts` と `src/core/verdict/containment.ts` も同じ helper を参照するようにします。

結果:

- shell redirect / copy / mv が trusted root 配下なら `outside_repo_*` 扱いしない
- 既存の Tier0/Tier1 判定資産をほぼそのまま使える

### 4. sandbox boundary

`src/core/gate-engine.ts` の `applySandboxFsScopeBoundary()` が outside-repo list を見ています。
ここで trusted root 配下を outside-repo list から除外すれば、sandbox 有効時でも plan 編集を止めなくて済みます。

重要なのは、boundary を無効にするのではなく「その path は boundary 内の trusted workspace である」と再定義することです。

## 「git 管理外なら確認する」の具体化

trusted root の提案は、常に出すのではなく以下の条件に限定すべきです。

1. action が local file mutation である
2. path は `repoRoot` の外側である
3. path は `trustedWorkspaceRoots` に未登録である
4. path は high-stakes ではない
5. path の親ディレクトリが git repository ではない

5 が重要です。

別の git repo を「trusted workspace root」として吸収すると、repository boundary を壊します。ユーザー要求も「git 管理外の場合」に限定されているため、別 repo は対象外にするのが正しいです。

### git 管理外の判定

現行コードベースに合わせ、初期実装は `.git` marker の ancestor walk で十分です。

理由:

- `findRepoRoot()` も marker walk ベース
- runtime 毎に `git rev-parse` を起動しないで済む
- bare/worktree の厳密性より、低コストで安定した UX を優先できる

必要なら後続で `git rev-parse --show-toplevel` ベースに差し替え可能です。

## trusted root 候補の導出

初期実装では「単一 file target の親ディレクトリ」を候補にするのが最も安全です。

例:

- `~/.cursor/plans/foo.plan.md` -> candidate root: `~/.cursor/plans`
- `/Users/kaz/tmp/design-notes/plan.md` -> candidate root: `/Users/kaz/tmp/design-notes`

やらないこと:

- `$HOME` のような広すぎる root の自動提案
- multi-target `apply_patch` からの共通祖先自動推定
- 別 repo の top-level 自動提案

これにより信頼範囲の過大化を防げます。

## approval UX の設計

### 現状の問題

現在の prompt 承認は `approvalCommandMatch()` が

```text
/belay-approve <approval-id>
```

しか受け取れません。

今回ほしいのは one-shot approval ではなく、`trustedWorkspaceRoots` 追加の確認です。従って prompt 解析を少し拡張する必要があります。

### 推奨 UX

block 時のメッセージを、通常の approval ではなく次のように出し分けます。

```text
Belay blocked this edit because it writes outside the repository sandbox.
This target is a local non-git directory.
If you trust this workspace root, approve:
/belay-approve <approval-id> --scope workspace-root --path /Users/.../.cursor/plans
```

CLI 側も同じ surface に揃えます。

```bash
belay approve <approval-id> --scope workspace-root --path /Users/.../.cursor/plans
```

### なぜ新しい専用コマンドではなく `approve --scope workspace-root` か

- 既存の `domain` / `path` scope と並ぶため理解しやすい
- CLI surface の追加が最小
- `recordCapabilityApproval()` の拡張で収まる

## approval record の拡張

現行の `ApprovalRecord` だけでは「この outside-repo deny は trusted root 追加の候補を持つ」ことが表現しづらいです。

そのため、次のどちらかの拡張が必要です。

### 推奨案

`ApprovalRecord` に optional な hint を追加する。

```ts
interface ApprovalScopeHint {
  scope: 'workspace-root'
  path: string
}
```

```ts
interface ApprovalRecord {
  ...
  scopeHint?: ApprovalScopeHint
}
```

こうしておくと、

- prompt / CLI の両方で同じ pending approval を解釈できる
- `belay explain` でも何を提案している block か表示できる
- message を summary 文字列から逆算しなくて済む

## record 処理の設計

`src/core/capability-approval.ts` は現在 path scope を outside-repo shell 前提で扱っています。
ここは以下のように役割を分けるとよいです。

- `recordCapabilityApprovalOnce(...)`
- `recordFsScopeApproval(...)`
- `recordTrustedWorkspaceRootApproval(...)`

少なくとも概念上は分離したほうがよいです。

理由:

- `fs-scope allowlist` と `trustedWorkspaceRoots` は意味が違う
- 後者は allowlist ではなく semantic root
- バリデーション条件も違う

`recordTrustedWorkspaceRootApproval()` の成立条件:

- pending approval が存在する
- reason が `outside_repo_mutation` または `outside_repo_redirect`
- `scopeHint.scope === "workspace-root"` を持つ
- `scopePath` が hint と一致する
- 指定 path が git 管理外
- 指定 path が protected root と衝突しない

## trusted root 登録後の扱い

登録後は「repo と同等の扱い」に寄せますが、完全に同じではありません。

### 同等にするもの

- outside-repo boundary から除外
- file mutation tool を repo-local 相当として classify
- shell redirect / copy 等も repo-local 相当として classify

### 同等にしないもの

- transactional git worktree
- git restore ベースの recoverability 説明
- `.git` 保護の対象判定

非 git root なので、transactional 実行や git rollback までは提供できません。ここは明示的に非目標とすべきです。

## 影響範囲

主要変更点は以下です。

- `src/core/path-utils.ts`
  - workspace root 判定 helper 追加
- `src/core/capability/paths.ts`
  - outside-repo 抽出に trusted roots を反映
- `src/core/verdict/containment.ts`
  - location / high-stakes 判定に trusted roots を反映
- `src/core/classify-tool.ts`
  - trusted root 配下を repo-local 相当で処理
- `src/core/gate-engine.ts`
  - sandbox boundary の outside-repo 判定に trusted roots を反映
- `src/core/approval.ts`
  - prompt command parser を `--scope workspace-root --path ...` まで解釈
- `src/core/capability-approval.ts`
  - trusted workspace root 追加処理
- `src/commands/approve.ts`
  - `workspace-root` scope を追加
- `src/services/sandbox-service.ts`
  - trusted root store の load/save helper 追加
- `src/core/types.ts`
  - approval hint 型の追加

## テスト方針

最低限、次を追加するべきです。

1. `classify-tool.test.ts`
   - trusted root 配下の plan file write が sandbox 有効時でも allow される
2. `capability-gate-runtime.test.ts`
   - blocked tool edit -> trusted root 承認 -> retry で allow
3. `capability-approval.test.ts`
   - `--scope workspace-root` が `trusted-workspace-roots.json` に保存される
4. `containment.test.ts`
   - trusted root 配下は repo-local 相当、ただし signal に `trusted_workspace_root`
5. 高リスク保護テスト
   - trusted root 配下でも `.env` や `authorized_keys` は deny のまま
6. 別 git repo 除外テスト
   - sibling repo / nested repo は trusted root 候補にできない

## 段階導入

### Phase 1

- `trustedWorkspaceRoots` store 追加
- CLI: `approve --scope workspace-root --path ...`
- runtime 判定に trusted roots を反映

### Phase 2

- prompt parser 拡張
- deny message の改善
- `belay explain` / `status` で trusted root 情報を見える化

### Phase 3

- `belay config trust list|remove` などの明示管理 surface
- 監査レポートに trusted root ヒット数を追加

## 推奨判断

この要求に対しては、`trustedWorkspaceRoots` を新設し、`fs-scope allowlist` とは分離する設計が最も適切です。

理由は明確です。

- 現行コードの責務分離に沿う
- Cursor plan 編集の UX 問題を最小変更で解消できる
- sandbox 境界を無効化せず、明示的に「この local root は workspace 内」と定義できる
- 高リスク path と control plane の保護を維持できる
- 別 git repo を誤って trust しない制約を素直に入れられる

結論として、`trusted_directory` 相当の正式名称は `trustedWorkspaceRoots`、永続化は `trusted-workspace-roots.json`、承認 surface は `belay approve <id> --scope workspace-root --path <dir>` がよいです。
