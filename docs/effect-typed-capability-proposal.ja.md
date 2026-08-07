# Effect系言語の知見をBelayに転用する案 — 実現性と効果

関連: [autonomous-quality-sandbox-proposal.ja.md](./autonomous-quality-sandbox-proposal.ja.md)（危険操作を本番環境で実行させない自律品質ループ提案）

---

## TL;DR

- **現状メモ（2026-08, PR #42 以降）**: Step 1（実境界 / `BoundaryDriver`）は `container` と `host-integration` で実装済み。Step 2（capability token）は未着手・任意。grant 消費経路は [grant-consumption-paths.md](./grant-consumption-paths.md) を参照。
- **Koka / Flix / Unison / Mercury / Jacquard を実装言語として採用するのは非現実的**。Belayは「Node組み込みのみ・ゼロ依存CLI」という設計方針で、かつ agent が渡してくる shell command / tool payload は実行前には静的に分からない**実行時文字列**であり、そもそも静的effect型の対象にならない。
- ただし **Jacquard の設計思想（関数シグネチャに外界effectを列挙し、ランタイムは許可されていないeffectを拒否する）は、Belayの `gate-runtime` / `capability broker` がやろうとしていることとほぼ同型**。しかも Jacquard 自体が「AIが書き人間がレビューするコード」向けの研究言語であり、Belayの問題設定に驚くほど近い。
- **前提更新（2026-08）**: `runTransactionalExecution` は [`BoundaryDriver`](../../src/core/transactional/runner.ts) 経由で実行する。`container` driver 選択時は Docker 隔離、`host-integration`（L3 editor hook 向けデフォルト）のみ [`runShellCommand`](../../src/core/transactional/git-worktree.ts) でホスト直 `spawn` が残る。git worktree はファイル変更の観測隔離。本提案の capability token は**隔離そのものではなく**、Belay 自身の副作用コードの誤用防止ガードレール（§5, §6）。
- 実際に手を動かせる転用先は2つ：
  1. **A. Effectタグの型的リファイン** — `VerdictResult.effect` を現状の4値（`read_only`/`local_mutation`/`remote_mutation`/`unknown`）から、Jacquard的なリソース別effect語彙（fs-write / network-egress / process-exec / git-history-rewrite 等）に拡張し、`corpus/gates.ts` のhard-gateと `capability-approval` のスコープをこの語彙で駆動する。
  2. **B. Capabilityトークン（object-capability）パターン** — Belay自身の副作用コード（`git-worktree.ts` の exec、egress proxy起動、control-plane書き込み）に対し、**誤用防止のガード**として broker/gate-runtime 経由でのみ得られるtokenを要求する関数へ変える。ただしbranded型はTypeScript側では偽造可能であり、これは「セキュリティ境界」ではなく「うっかり直接呼び出しを型検査で検出するガードレール」である点を明記する。
- どちらもゼロ依存・TypeScriptの型システムのみで実装可能で、既存のNode CLIアーキテクチャを壊さない。ただし**実際のプロセス隔離（コンテナ/制限実行環境）は別途必要**であり、この提案はそれを代替しない。既存提案の Phase E0-E2（サンドボックス化された修正実行基盤）が実際に触ることになる `git-worktree.ts` / `broker.ts` を土台強化する形で接続できる。

---

## 1. 調査対象のeffect系言語と転用可能性

| 言語 | アプローチ | Belayとの関連 | 採用可否 |
|---|---|---|---|
| **Koka** (MS Research) | algebraic effects、effect型がシグネチャに現れる。実用重視の研究言語 | 「この関数はどのeffectを持つか」を型で表現する発想の源流 | 言語としては不採用。発想のみ転用 |
| **Flix** | `def main(): Unit \ { Http, Logger, IO }` のように必要effectを列挙 | まさにBelayの `GatedAction`/`GateVerdict` がやりたいことの静的版 | 同上 |
| **Unison** | effects on arrows、content-addressed code | content-addressingはBelayのfingerprint/corpus管理と親和性あるが別トピック | 不採用 |
| **Mercury** | 決定性・副作用の静的追跡 | 参考程度 | 不採用 |
| **Jacquard**（[jbwinters/jacquard-lang](https://github.com/jbwinters/jacquard-lang)） | 「ほとんどのコードがMLモデルによって書かれ、人間がレビューする」体制向けの言語。**全ての関数シグネチャが外界effect（network, files, clock, randomness）を列挙し、ランタイムはコマンドラインで許可されていないeffectを拒否する**。algebraic effect handlerがresumeを多重にサポートし、探索や厳密推論をライブラリコードとして書けるのが特徴。実装はOCaml製のchecker/interpreter + `.jac`/`.jqd`をCへコンパイルするコンパイラ。v0.1、研究プロトタイプで本番用途ではない | **設計思想がBelayのユースケースに直撃**（AI生成コード×人間レビュー×実行前effect拒否）。ただし実装はOCaml/C出力で、Node CLIへの組み込みは現実的でない | 言語としては不採用。**設計パターンとしては最重要参考** |

Jacquardの核心アイデアを分解すると2層ある：

1. **静的層**: 自分の書くコードの関数シグネチャにeffectを型として宣言する
2. **実行時層**: 実行時に、宣言されていない／許可されていないeffectをランタイムが拒否する

Belayに置き換えると、(1) はBelay自身の実装コード（TypeScript）に、(2) は agent が渡してくる未知のshell command / tool payloadに対応する。**(2) は原理的に静的型の対象にならない**（実行するまで何のコマンドか分からない）ため、ここは今まで通り `gate-engine.ts` の実行時分類器（heuristic + judge LLM）が担う。Jacquardの実行時effect拒否モデルに近いのは、むしろ既存の `evaluateGatedAction` → `GateVerdict.wouldBlock` のフローそのものである。

**転用の伸びしろがあるのは (1) の静的層**——つまりBelay自身の実装コードに対して、「このコードパスはfs-writeを行う／network-egressを行う」という宣言を型で強制することは、TypeScriptの範囲内で今すぐ着手できる。

---

## 2. なぜ「言語の採用」ではなく「発想の輸入」なのか

| 理由 | 詳細 |
|---|---|
| ゼロ依存CLI方針 | BelayはNode組み込みのみで動くCLI/TUIという既存方針がある。Koka/Flix/Unison/Mercury/JacquardはいずれもTypeScript/Node上で直接動かせず、別ランタイムのビルド・配布・デバッグ導線を追加で背負うことになる |
| Jacquardの成熟度 | v0.1・「研究プロトタイプ、本番言語ではない」と明言されている。依存先として不安定すぎる |
| 問題の本質がずれる | Belayが型付けたいのは「agentが生成した未知のshellコマンド」であり、これは実行前には構文木すら確定しない。静的effect型は「自分が書くコード」にしか効かない。Belayの核心課題（agentの出力を実行時に判定する）は言語を変えても解決しない |
| 移行コストと既存資産 | `gate-runtime.ts`（1084行）、`gate-engine.ts`、`corpus/gates.ts`、`capability/*` はTypeScriptで書かれた既存のテスト済み資産。書き直しは既存提案（自律品質ループ）そのものを止めるリスクがある |

結論として、**「effect系言語の採用」は却下し、「effectを型で閉じる」「capabilityをトークン化する」という設計パターンだけを既存TypeScriptコードに輸入する**のが最も実現性と効果のバランスが良い。

---

## 3. 発見: Belayはすでにeffect-axis的な設計の芽を持っている

調査の過程で、`src/core/verdict/types.ts` に以下がすでに存在することを確認した：

```ts
export type VerdictPermission = 'allow' | 'ask'
export type VerdictLocation  = 'repo_local' | 'repo_outside' | 'external' | 'mixed' | 'unknown'
export type VerdictOpacity   = 'transparent' | 'recursive' | 'opaque' | 'unparseable'
export type VerdictEffect    = 'read_only' | 'local_mutation' | 'remote_mutation' | 'unknown'
export type VerdictConfidence =
  | 'deterministic' | 'llm' | 'assumed_repo_local' | 'verified_substrate'
```

これは事実上「多軸の実行時effect推論結果」であり、Flix/Koka的な effect row の**判定結果版**にすでに近い。ただし：

- `effect` 軸は4値のみで粒度が粗く、「何に対する」mutationかを区別しない（fs書き込みなのかnetwork送信なのかgit historyの書き換えなのかが潰れている）
- `src/core/types.ts` の `VerdictAxes.effect` はDTO側で単なる `string` として緩んでいる（`ClassifyResult.axes` 経由でhookレスポンスに乗る時点で型の閉じが失われる）
- この軸は「agentのコマンドを判定した結果」にのみ使われており、**Belay自身の内部コード（broker, git-worktree, egress proxy）の副作用には一切紐づいていない**

つまり「判定エンジンの出力」と「Belay自身の実装が実際に起こす副作用」が型的に無関係。ここを繋ぐのが以下2案。

---

## 4. 案A: Effectタグのリファイン（判定エンジン側）

### やること

`VerdictEffect` を単一enumから、Jacquard的なリソース別タグの集合に拡張する。

```ts
// src/core/verdict/types.ts
export type EffectTag =
  | 'fs_write_in_repo'
  | 'fs_write_outside_repo'
  | 'fs_read_outside_repo'
  | 'process_exec_external'
  | 'network_egress'
  | 'git_history_rewrite'
  | 'secrets_read'
  | 'control_plane_write'
  | 'read_only'
  | 'indeterminate'   // 分類器がeffectを確定できなかった場合に必須（既存 'unknown' を置換）

export interface VerdictResult {
  // ...既存フィールド
  /**
   * 正規化・重複排除・ソート済みの配列としてDTO化する（JSON化を前提にSetは使わない）。
   * 不変条件: 'read_only' は他のタグと排他（read_onlyならこの1要素のみ）。
   * 不変条件: 'indeterminate' も他のタグと排他（解析不能ならこの1要素のみ、暗黙の 'unknown' 扱いを禁止）。
   */
  effectTags: readonly EffectTag[]   // 既存の effect: VerdictEffect を段階的に置換
}

export function normalizeEffectTags(tags: Iterable<EffectTag>): readonly EffectTag[] {
  const set = new Set(tags)
  if (set.has('read_only') && set.size > 1) {
    throw new Error('read_only must not co-occur with other effect tags')
  }
  if (set.has('indeterminate') && set.size > 1) {
    throw new Error('indeterminate must not co-occur with other effect tags')
  }
  return [...set].sort()
}
```

`adapter.ts` 側（[adapter.ts:152](../src/core/verdict/adapter.ts#L152)）は `axes.effect: result.effect` を素通しで返しているため、`effectTags` 導入時も `readonly EffectTag[]`（配列）のままDTOへ渡す。`Set` を直接返すと `JSON.stringify` で `{}` になり外部hookプロトコルが壊れるため、Setは内部計算にのみ使い、公開型・DTOは常に正規化済み配列にする。

- `corpus/gates.ts` の `isMustAskMiss` / `isProvablyBenignBlock` は現状 `HookVerdict` のみを見ているが、`effectTags` が入ることで「`network_egress` を含むケースは must-ask 固定」のようなタグ駆動のhard-gateを追加できる（現在バラバラに存在する `egressEnabled` / `brokerFsScope` / `trustedWorkspaceRoots` などの個別boolean設定を、タグに対する一貫したポリシーとして統合できる）
- **effectTagはapprovalのスコープそのものにはしない。** `ApprovalRecord`（`fingerprint` / `cwd` / `toolName` / `payloadHash` / `scopeHint`）はすでにコマンド単位・入力ハッシュ単位で承認を束縛している。「`network_egress` を含む」は"must-askに固定する分類上の理由"であって、"何を承認したか"の代わりにはならない。もし `effectTags` を承認まわりに持ち込むなら、既存の `ApprovalRecord` に**追加のフィールド**として乗せる：`effectTags`（この承認がカバーする効果種別、監査用）、`resourceScope`（対象ホスト/パスなど、tagごとに意味が異なる）、`inputHash`（`payloadHash` を流用）、`expiresAt`（既存）、`maxUses`（新規、再実行回数の上限）。**「`network_egress` というtagだけを渡せば任意の外部送信が許可される」設計は最小権限に反するため明確に非採用とする。**

### 効果

- 既存提案の risk table にある「audit モードと enforce 混同 → 誤った安心感」を、設定フラグの組み合わせ爆発ではなくタグの型で閉じることで構造的に減らせる
- 将来 corpus に新しいカテゴリ（例: `git_history_rewrite` の危険操作）を足すとき、既存の4値enumを壊さず拡張できる

### コスト

- 中。`effect: VerdictEffect` を参照する既存コード（`verdict.ts` の分岐が20箇所以上）を段階移行する必要がある。`effect` を残しつつ `effectTags` を並走させ、grepで洗い出した参照箇所を1PRずつ移すのが安全

---

## 5. 案B: Capabilityトークン（object-capability）パターン（Belay自身の副作用コード側）

これが**Jacquardの「ランタイムが許可されていないeffectを拒否する」から着想を得た誤用防止パターン**。ただしレビュー指摘の通り、当初案は「token = サンドボックス実行の保証」であるかのように書いており、これは誤りだった。以下、前提を訂正した上で再設計する。

### 現状の事実（訂正版の問題設定）

- `runTransactionalExecution`（[runner.ts:19-48](../src/core/transactional/runner.ts#L19)）は git worktree のsnapshot作成→`runShellCommand`実行→diff評価→適用、という流れで、**worktreeによるファイル変更の隔離**は行っている
- しかし `runShellCommand`（[git-worktree.ts:96](../src/core/transactional/git-worktree.ts#L96)）自体は `spawn(command, { cwd, shell: true, stdio: 'ignore', env: process.env })` で**ホストプロセスとして直接実行**しており、コンテナ・制限ユーザー・ネットワーク遮断などの**プロセスレベルの隔離は一切ない**。ホストの環境変数をフルに継承し、任意のshell構文が使える
- `broker.ts` の `isCapabilityBrokerDemotionActive` は `gate-runtime.ts:220,688` と `classify-for-report.ts` / `sandbox-service.ts` の**分類・ステータス表示にのみ**使われており、`gate-runtime.ts:470` → `runTransactionalExecution` → `runShellCommand` の実行経路には**配線されていない**。つまり「brokerチェックを飛ばす」という表現自体が誤りで、現状はそもそも**チェックする経路が存在しない**
- したがって「サンドボックス外の破壊的操作 0件」（既存提案 §9）を満たすには、まず `runShellCommand` を実際に隔離された環境（コンテナ／制限ユーザー／ネットワーク遮断済み実行環境）で動かす**実境界の実装**が要る。これは既存提案 §12 の欠落要素1「サンドボックス化された修正実行基盤」そのものであり、capability tokenでは代替できない

### tokenで達成できること・できないこと

| できること | できないこと |
|---|---|
| 「このコードパスは、`gate-runtime` の eligibility チェック（`isTransactionalEligible` 等）を経由して呼ばれた」という**呼び出し順序の型的な可視化** | 実際のプロセス／ネットワーク隔離（それは別途コンテナ等の実装が必要） |
| 直接 `runShellCommand(command, cwd, timeoutMs)` を新しいコードパスから呼んでしまう**うっかりミスを型検査で検出**する開発時ガード | 悪意あるコード、または `as any` / `as SandboxExecCapability` によるtype assertionを使った意図的な迂回を防ぐこと（TypeScriptの型はコンパイル時に消去されるため） |
| token発行元をモジュール非公開にし、実行時にも発行済みtokenかどうかを検証することで、単純なcast偽造よりは検出力を上げる | 同一プロセス内での完全な権限分離（Node.jsにはプロセス内メモリ分離がないため、真の権限分離にはプロセス／コンテナ境界が必須） |

**結論: tokenは「セキュリティ境界」ではなく「開発時の誤用防止ガードレール」である。** 実境界（コンテナ等）ができた後に、そこを通ったことを示す印としてtokenを使うのが正しい順序であり、token単体を先に作っても §9 の指標は達成できない。

### やること（訂正版）

1. **まず実境界を作る（前提）**: `runShellCommand` の実行を、`config.sandbox.runtime`（`broker.ts` が既に読んでいる設定）に応じて実際に隔離環境へ委譲する。これは本提案のスコープ外（既存提案のPhase E0-E2側の課題）だが、tokenパターンが意味を持つための前提条件として明記する
2. **token は「実境界を通った」ことの型的な印にする**。branded型に加え、モジュール非公開の `WeakSet` で発行済みインスタンスを記録し、`runShellCommand` 側で実行時にも検証することで、単純な `as` castより一段強いガードにする（それでも同一プロセス内のcapability patternである以上、悪意あるコードは`tokens.ts`を直接importして同じ発行関数を呼べてしまう——これは受け入れる。目的は事故防止であって攻撃者対策ではない）

```ts
// src/core/capability/tokens.ts
declare const brand: unique symbol
export type CapabilityToken<Tag extends string> = { readonly [brand]: Tag }
export type SandboxExecCapability = CapabilityToken<'sandbox_exec'>

// 発行済みtokenの実体を記録する非公開レジストリ（型の外側での偽造を実行時にも検出するため）
const issued = new WeakSet<object>()

/**
 * 呼び出し前提: 実境界（コンテナ等）への委譲が実装されていること。
 * それまでは「eligibility チェックを経由したか」の印としてのみ機能する。
 */
export function grantSandboxExecCapability(
  config: BelayConfigV3,
): SandboxExecCapability | null {
  if (!isCapabilityBrokerDemotionActive(config)) return null
  const token = {} as SandboxExecCapability
  issued.add(token)
  return token
}

export function isIssuedSandboxExecCapability(token: SandboxExecCapability): boolean {
  return issued.has(token)
}
```

```ts
// src/core/transactional/git-worktree.ts
export function runShellCommand(
  cap: SandboxExecCapability,
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<ShellRunResult> {
  if (!isIssuedSandboxExecCapability(cap)) {
    throw new Error('runShellCommand called without a capability issued by the broker')
  }
  // 既存実装（ここに実境界への委譲を追加するのが本来の主課題）
}
```

対象にすべき関数（`docs/autonomous-quality-sandbox-proposal.ja.md` §11 の接続点表と対応）：

| 関数/箇所 | 必要token | 実境界の有無（現状） |
|---|---|---|
| `git-worktree.ts` の `runShellCommand` | `SandboxExecCapability` | **なし**（ホスト直接実行） |
| `git-worktree.ts` の `applyWorktreeChanges` | `SandboxExecCapability` | worktree隔離のみ（プロセス隔離なし） |
| egress proxy起動処理 | `EgressCapability` | 別途確認要 |
| control-plane設定ファイルへの書き込み（`resolveControlPlaneDir` 配下） | `ControlPlaneWriteCapability` | 該当なし（ファイル書き込みのみ） |

### 効果（訂正版）

- 直接exec呼び出しの**事故的な追加**を型検査＋実行時レジストリで検出できる（意図的な迂回への耐性はない、と明記した上で）
- 「どのコードパスがどのcapabilityを要求するか」が関数シグネチャに現れるため、コードレビュー時に見るべき箇所が明確になる
- 「サンドボックス外の破壊的操作 0件」の達成には**実境界の実装が必須**であり、本パターンはそれを可視化・接続するための補助であって代替ではない、という位置づけを明記する

### コスト

- 小〜中。既存の `broker.ts`（48行）に発行関数を数個追加し、`git-worktree.ts` の数関数のシグネチャを変更するだけ。呼び出し元は `gate-runtime.ts` 側の限られた箇所のみ

---

## 6. 段階的実装計画

既存提案の「10. 推奨する最初の一歩」と同じ投資対効果順で並べる。

| フェーズ | 内容 | 触るファイル | 効果 | コスト |
|---|---|---|---|---|
| **Step 0**（レビューを受けて追加・最優先） | **token型を書く前に**、現状のBelayの各実行経路が「どのruntime境界で強制されているか／されていないか」を表にして明文化する。少なくとも `gate-runtime.evaluateGatedAction` → `runTransactionalExecution` → `runShellCommand` はプロセス隔離なしでホスト直接実行、という事実（本ドキュメント§5で確認済み）を起点に、他の副作用経路（egress proxy起動、control-plane書き込み、通常の（非transactional）shell実行パス）も同様に洗い出す | 新規ドキュメント（例: `docs/execution-boundary-map.ja.md`） | 「型で保証したつもりが実は何も保証していない」設計ミスを事前に防ぐ。実境界の実装が必要な箇所を特定できる | 小 |
| **Step 1** | Step 0で「実境界なし」と判明した経路（`runShellCommand` 等）について、`config.sandbox.runtime` に応じた実隔離（コンテナ／制限ユーザー等）への委譲を設計・実装する。**これが§9の成功指標達成に直接効く本丸**であり、既存提案 §12 の欠落要素1と同一 | `git-worktree.ts`, `capability/broker.ts`, sandbox runtime連携部 | 「サンドボックス外の破壊的操作 0件」を実際に満たす | 大 |
| **Step 2** | Step 1で実境界ができた経路にのみ、案Bのtoken基盤（`capability/tokens.ts`）を適用し、「実境界を通ったことの型的な印」として機能させる | `capability/tokens.ts`（新規）, `git-worktree.ts` | 実境界のうっかりバイパスを型検査＋実行時レジストリで検出 | 小〜中 |
| **Step 3** | 案Aの `EffectTag` 型を `verdict/types.ts` に追加し、既存の `effect: VerdictEffect` と並走させる（破壊的変更なし）。`normalizeEffectTags` で排他制約を強制 | `verdict/types.ts`, `verdict/verdict.ts` | 新しいeffect語彙を段階導入する土台 | 中 |
| **Step 4** | `corpus/gates.ts` のhard-gateに `effectTags` ベースの判定を追加（`network_egress` を含むケースは must-ask 固定、等）。承認自体のスコープは既存の `ApprovalRecord.fingerprint`/`payloadHash` を維持し、`effectTags` はあくまで分類・監査用の追加軸とする | `corpus/gates.ts`, `capability-approval.ts` | 個別boolean設定の組み合わせ爆発を、タグ単位の一貫ポリシーに置換（最小権限は崩さない） | 中 |
| **Step 5**（任意） | `VerdictAxes.effect: string` を `readonly EffectTag[]` に置換し、DTO層まで型を閉じる | `core/types.ts`, `verdict/adapter.ts`, hookレスポンス整形箇所 | フルスタックでeffectの型が閉じる | 大（外部hookプロトコルとの互換性要検討） |

**Step 0・3は既存コードを壊さない付加（ドキュメント／並走型）のみなので即着手可能。Step 1・2の順序は厳守する**——token（Step 2）を実境界（Step 1）より先に作ると、レビューで指摘された「保証していないものを保証したかのように見せる」問題を再現する。

---

## 7. 非ゴール

- Koka/Flix/Unison/Mercury/Jacquardのいずれも実装言語として採用しない
- agentが渡すshellコマンド／tool payloadを静的型検査の対象にする試み（原理的に不可能——実行時文字列である）
- 既存の `HookVerdict` / `GateVerdict` 契約（外部hookプロトコル、`GATE_CONTRACT_VERSION`）を破壊的変更する試み。Step 5以外は既存型に**追加**するだけで完結させる
- **capability tokenをセキュリティ境界として扱うこと。** branded型はTypeScriptのコンパイル時にのみ存在し、`as`によるcastで偽造できる。tokenは「事故防止のガードレール」であり、悪意あるコードや意図的な迂回を防ぐものではない
- **実境界（コンテナ等のプロセス隔離）を実装する前にtokenだけを導入し、「型があるから安全」と主張すること**。§9「サンドボックス外の破壊的操作 0件」はtokenでは達成できず、Step 1（実境界の実装）が前提
- `network_egress` のようなeffectタグ単独でapprovalのスコープとすること。approvalは常に既存の `fingerprint`/`payloadHash` などリソース・入力に紐づいた最小権限の粒度を維持する

---

## 8. 推奨する最初の一歩

1. **（Step 0）** `gate-runtime.evaluateGatedAction` → `runTransactionalExecution` → `runShellCommand` を含む全副作用経路について、「実際にどのruntime境界で強制されているか」を一覧化するドキュメントを書く。`runShellCommand` がホスト直接実行である事実（本提案§5で確認済み）を起点に、egress proxy起動・control-plane書き込みなど他経路も同様に確認する
2. 一覧化の結果、実境界が無い経路のうち最も優先度が高いもの（おそらく `runShellCommand`）について、`config.sandbox.runtime` に応じた実隔離への委譲を設計する（既存提案 §12 の欠落要素1と合流させる）
3. 実境界ができた経路にのみ、`src/core/capability/tokens.ts` のtoken基盤を適用する。branded型＋非公開`WeakSet`による発行済み検証を最小構成で実装し、既存の transactional実行系テストが通ることを確認する
4. 並行して（Step 0-3と独立に進められる）`verdict/types.ts` に `EffectTag` 型と `normalizeEffectTags` を追加。既存 `effect` フィールドとは独立に足すだけなので無リスク

**tokenの実装（1手目）から着手しないこと。** 実境界のない箇所にtokenだけ導入すると、「型があるから安全」という誤った安心感を生む——これは既存提案の risk table が名指しで警戒している失敗パターンそのものである。
