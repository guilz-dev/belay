# agent-belay SPEC v1.1 — Everyday Belay(強い構成を日常の既定路線にする)

> 前提: [`SPEC-v1.0.md`](./SPEC-v1.0.md) の全 WS が出荷済みであること。
> 特に依存するもの: claims registry(WS-A)、`harden`(R7)、
> `agent-belay/adapter-sdk` + プラグイン解決(WS-D)、`policy.rules` +
> `simulate --rules`(WS-E)、`RELEASE-POLICY.md`(WS-C)。
>
> Status: Draft — v1.0 タグ後にレビュー・着手。

## Summary

v1.0 は「強い構成が存在し、保証が正しい」ことを証明した。v1.1 は
**「強い構成が日常的に使われる」**ためのリリースである。新しい層は作らない。
投資先は 4 つ:

1. **WS-A — L1-partial(egress)の既定路線化**: デーモン運用の堅牢化、
   カバレッジ可視化、allowlist の手入れ機能。dogfood 計測を経て新規 init の
   デフォルトを egress 有効へ昇格する
2. **WS-B — 承認疲れの経済学**: 監査・承認履歴からルール候補を提案する
   `suggest`、承認時の情報密度向上(予測ラベルでなく観測事実を見せる)、
   摩擦の計測指標
3. **WS-C — エコシステムの実証**: 第三のアダプタを**外部パッケージ**として
   出荷し、SDK semver 約束とプラグイン解決を自分たちが外部開発者として検証する
4. **WS-D — プラットフォームパリティ**: L2 スナップショットバックエンドの
   抽象化と APFS clone 最適化(macOS 先行)、Windows 基線の CI 常設
5. **WS-E(小)— チーム配布**: 署名付き policy bundle の export / import。
   サーバーは作らない

**semver 制約(全 WS 共通)**: v1.1 は minor。既存 config の挙動は一切
変えない。デフォルト変更は「新規 init のテンプレート」と「`harden` による
明示的昇格」のみで行う(v1.0 の signing デフォルト化と同じパターン)。

要件は R1〜R20、受け入れテストは T1〜T11。

---

## 終了条件 → 検証のマッピング

| v1.1 の終了条件 | 検証手段 | 担当 WS |
|---|---|---|
| egress が「設定して忘れる」運用に耐える | 自動起動・回復・多 repo の e2e(T1–T3) | WS-A |
| 観測できていない通信がゼロかを運用者が知れる | カバレッジレポートのテスト(T4) | WS-A |
| 新規 init のデフォルトが egress 有効(計測条件を満たした場合) | 昇格基準(後述)の数値判定 + init スナップショット(T5) | WS-A |
| 承認摩擦が計測され、suggest で削減できる | `suggest` → `simulate` → 適用の e2e(T6, T7) | WS-B |
| 外部アダプタが SDK だけで動く | 外部パッケージの conformance + tarball インストール e2e(T8) | WS-C |
| L2 が macOS で実用速度になる | バックエンドパリティ + ベンチ記録(T9, T10) | WS-D |
| チームでポリシーを安全に配布できる | bundle 署名検証 e2e(T11) | WS-E |

---

## WS-A — L1-partial(egress)の既定路線化

**現状:** egress は `egress start` の手動起動。状態は repo の state dir に
`egress-proxy.pid` / `egress-proxy.json`(ステータス)/
`egress-allowlist.json`。ポートは固定デフォルト 17831。複数 repo の同時利用は
ポート衝突する。プロキシ死活はユーザー任せ(doctor が警告するのみ)。

### R1 — 自動起動とクラッシュ回復

- config に `egress.autoStart: boolean` を追加(**default `false`** —
  既存挙動を変えないため。新規 init テンプレートと `harden --egress` が
  `true` を書く)
- `autoStart: true` のとき、gate runtime
  ([`adapters/shared/gate-runtime.ts`](../src/adapters/shared/gate-runtime.ts))
  が gate イベント処理時にプロキシ死活を確認し、停止していれば
  detached プロセスとして再起動する(lazy start)。起動失敗は gate を
  ブロックしない — `egress_autostart_failed` を監査に記録し、L3 の外部
  ルールが demote されないフォールバック(v0.7 仕様)に自然に戻る
- stale pid 検出: `egress-proxy.pid` のプロセスが存在しない/別プロセスに
  再利用されている場合を判別し(pid + 起動時刻を `egress-proxy.json` に
  記録して照合)、安全に上書き起動する
- `egress stop --all` で当該ユーザーの全 repo のプロキシを停止

### R2 — 複数 repo とポート管理

- `egress.listenPort: 0` を正式サポート: エフェメラルポートで listen し、
  実ポートを `egress-proxy.json` に記録。`egress env` / gate runtime の
  env 注入は記録された実ポートを読む
- 新規 init テンプレートは `listenPort: 0` にする(固定 17831 は既存 config
  でのみ残存)。固定ポートが使用中の場合は起動エラーに「`listenPort: 0` への
  変更」を案内するメッセージを付す
- 同一 repo への二重 `egress start` は既存プロセスを検出して no-op(終了
  コード 0、status 表示)

### R3 — カバレッジ可視化(観測できていない通信を知る)

予測との突き合わせで「プロキシが見ていない外部通信の兆候」を報告する:

- gate runtime は egress 有効時、hook プロセスの環境変数に
  `HTTP_PROXY`/`HTTPS_PROXY` が注入済みかを gate イベントごとに記録する
  (`egressEnvPresent: boolean` を監査レコードに追加)
- プロキシは観測した接続(host, 時刻, fingerprint)を既存ステータスに加えて
  リングバッファ(`egress-observations.ndjson`、上限つきローテーション)へ
  記録する
- `agent-belay egress status --coverage`: 直近 N 時間の
  (a) `l3_external_hint` 付き gate イベント数、(b) 対応するプロキシ観測数、
  (c) env 未注入の gate イベント数 — を突き合わせ、
  「ヒントあり・観測なし」を **bypass 疑い**として列挙する
- `doctor`: egress 有効 + 直近の gate イベントで `egressEnvPresent: false`
  が続く場合に warn(env 注入が runtime に届いていない構成ミスの検出)
- 限界の明文化: これは検出であって防止ではない(防止は L1-full の領分)。
  guarantee table の claims に変更なし — カバレッジレポートは観測の観測

### R4 — allowlist の運用機能(育ったリストの手入れ)

`egress-allowlist.json` / `fs-scope-allowlist.json` のエントリに
メタデータを追加(後方互換: 旧形式エントリは無期限・lastUsedAt なしとして
読む):

```json
{
  "host": "api.github.com",
  "addedAt": "2026-07-01T00:00:00Z",
  "expiresAt": null,
  "lastUsedAt": "2026-07-10T12:34:56Z",
  "approvalId": "bly-…",
  "includeSubdomains": false
}
```

- `approve <id> --scope domain --ttl <duration>`(`7d` / `12h` 形式):
  期限付き恒久許可。期限切れエントリはプロキシ判定時に無視され、次回
  `prune` で削除
- `approve <id> --scope domain --include-subdomains`: `*.example.com`
  相当。**デフォルトは完全一致のまま**(ワイルドカードは明示時のみ)
- `lastUsedAt`: プロキシ/broker が許可判定のたびに更新(書き込み頻度対策
  として 10 分間隔のデバウンス)
- 新サブコマンド:
  - `agent-belay allowlist list [--scope domain|path] [--json]` —
    エントリ・期限・最終使用を表形式で
  - `agent-belay allowlist remove <host|path>`
  - `agent-belay allowlist prune [--unused-days <n>] [--expired] [--dry-run]`

### R5 — デフォルト昇格(計測ゲート付き)

- `harden` に `--egress` を追加: `egress.enabled: true` +
  `autoStart: true` + `listenPort: 0` を設定し、プロキシを起動して
  `egress env` の注入手順を表示する
- **新規 init テンプレートの egress 有効化**は、リリースサイクル後半に
  下記「昇格基準」の数値判定で決める(満たさなければ v1.1 では init
  デフォルト変更なしで出荷し、`harden --egress` までに留める):

**昇格基準**(`metrics` のローカル計測。メンテナ dogfood + 任意提供レポート):

1. egress 有効環境で、定常状態(初週を除く)の egress 起因承認が
   **セッションあたり中央値 1 件未満**
2. プロキシ起因の作業不能(crash/起動失敗で外部通信が止まる)が
   計測期間 4 週間で **0 件**(R1 の回復が機能している証跡)
3. bypass 疑いレポート(R3)の false positive が運用上無視できる水準
   (週あたり数件以下)であること

**受け入れ:**
- T1: autoStart e2e — プロキシ停止状態で gate イベント → 自動再起動 →
  接続が観測される。起動失敗時はフォールバック動作 + 監査記録
- T2: stale pid / 二重起動 / `stop --all` の各ケース
- T3: 2 repo 同時に `listenPort: 0` で起動し、それぞれの `egress env` が
  正しい実ポートを返す
- T4: 「ヒントあり・観測なし」を人工的に作り(env 注入を外した gate)、
  `status --coverage` が bypass 疑いとして報告する
- T5: init スナップショット — 昇格実施時はテンプレート変更がスナップショット
  に現れ、既存 config のロード結果が不変であることを回帰テストで固定

---

## WS-B — 承認疲れの経済学

**現状:** 承認は one-shot + scope 付き永続化のみ。どの承認が繰り返されて
いるか、どのルールを足せばノイズが減るかは人間が監査ログを読んで考える。

### R6 — `agent-belay suggest`(新コマンド)

```
agent-belay suggest [--window 30d] [--min-count 3] [--out <file>] [--json]
```

監査ログ + 承認履歴をマイニングして提案を生成する:

| パターン | 提案 |
|---|---|
| 同一 fingerprint の one-shot 承認が期間内 N 回以上 | `overrides.allow` エントリ、または `policy.rules` のユーザールール(commandKey が安定している場合) |
| 同一ドメインへの `--scope once` 承認が N 回以上 | `--scope domain`(必要なら `--ttl`)での再承認 |
| 同一 repo 外パス配下への path 承認が N 回以上 | 共通親ディレクトリの fs-scope エントリ(**ただし親昇格は提案しない** — v0.9 の親パス非昇格原則に従い、実際に承認された最深共通パスのみ) |
| `allow_flagged` が大量で監査ノイズ化しているキー | ルール化ではなく「無視してよい」旨の表示のみ(安全側) |

- 出力は `simulate --rules` 互換のルール JSON(+人間可読のサマリ)。
  **suggest は config を書き換えない** — 提案と適用を分離する
- 提案には根拠(該当監査イベント数、初出・最終時刻)を必ず添付

### R7 — 提案の適用フロー

```
agent-belay suggest --apply [--yes]
```

1. 提案を生成し、`simulate --rules` を内部実行して「過去の監査履歴に
   適用した場合の verdict 変化件数」を表示
2. `--yes` がなければ確認プロンプト(非対話環境では `--yes` 必須)
3. 適用先は repo レイヤの config(`overrides` / `policy.rules`)。
   protected レイヤ・nonOverridable には触れない(v1.0 R17 の帯域制限が
   そのまま効く)
4. 適用は監査ログに `suggest_applied` イベントとして記録(誰が・何を・
   根拠件数)

### R8 — 承認時の情報密度向上(観測事実を見せる)

deny メッセージと通知(`notifications.webhookUrl` / `commandHook`)に
観測事実を含める:

- **egress 起因**: 接続先 host:port、SNI/CONNECT で見えた範囲、
  直近の同一ドメイン承認履歴の有無
- **L2 起因**(`transactional_observed_risk`): 観測 diff の要約 —
  変更ファイル数、効果カテゴリ(repo 外 / 機密 / control-plane / 削除規模)、
  代表パス最大 5 件(redaction 適用後)
- **L3 起因**: 従来どおり予測ラベル + `[L3 prediction]` 層タグ(v1.0 R11)
- 実装位置: [`notify.ts`](../src/core/notify.ts) のペイロード組み立てと、
  gate deny 応答のメッセージ整形。監査レコード構造は追加フィールドのみ
  (minor)

### R9 — 摩擦の計測指標(metrics v3)

`agent-belay metrics` に追加:

- `approvalsPerSession`(セッション境界は既存の audit セッション概念に従う)
- `reApprovalRate` — 同一 fingerprint への one-shot 承認の再発率
- `timeToApproveP50/P90` — deny 発行から承認までの経過(放置→失効も計上)
- `suggestCoverage` — 現在の suggest 提案を全適用した場合に消える承認の割合

これらが WS-A R5 の昇格判定と、v1.2 以降の transactional 昇格判定の入力になる。

**受け入れ:**
- T6: 合成監査ログ(再承認 5 回 / ドメイン once 4 回 / path 3 回)から
  suggest が期待どおりの提案 + 根拠を出す。`--min-count` 境界のテスト
- T7: `suggest --apply` e2e — simulate の差分表示 → 適用 → 以後同一
  コマンドが allow になる → `suggest_applied` が監査に残る。
  protected レイヤを書き換えないことの negative テスト
- (R8 は T6/T7 内で deny メッセージのスナップショットとして検証)

---

## WS-C — エコシステムの実証(外部アダプタ)

**現状(v1.0 出荷後):** adapter-sdk と `agent-belay-adapter-<name>`
規約解決、`examples/adapter-minimal` が存在。ただし「本物の外部パッケージ」
はまだない。

### R10 — 外部リファレンスアダプタの出荷

- 別リポジトリ・別パッケージ `agent-belay-adapter-<runtime>` を 1 本公開
  する。対象 runtime は需要ベースで確定(候補: hook 機構を持つ他の CLI
  エージェント、または汎用 MCP ゲートウェイ)。選定は v1.1 着手時の
  issue 投票/問い合わせ実績で決め、本 SPEC は名前に依存しない
- 制約: import は `agent-belay/adapter-sdk` のみ(examples と同じ lint を
  当該リポジトリの CI に置く)。`runAdapterConformance` を CI で実行
- 本体リポジトリ側の作業: `init --adapter <external-name>` の解決 e2e を
  「パックした tarball を一時 `node_modules` に展開して解決させる」形で
  追加(npm レジストリに依存しない CI)

### R11 — SDK ギャップの還流

- 外部アダプタ開発で見つかった SDK の不足は、`docs/adapter-sdk.md` 末尾の
  Changelog 節に「発見の経緯 → 追加 API」の形で記録し、minor リリースで
  追加する(RELEASE-POLICY: 追加は minor)
- v1.1 終了時に「SDK 追加なしで書けたか / 何が足りなかったか」を
  ROADMAP に 1 節で総括(v1.2 の入力)

**受け入れ:**
- T8: tarball 解決 e2e — 外部アダプタ名で `init` → hooks 設置 → gate
  contract の入出力が conformance を通る。未知名のときの既知アダプタ一覧
  表示も検証

---

## WS-D — プラットフォームパリティ(L2 の実用速度)

**現状:** L2 バックエンドは
[`git-worktree.ts`](../src/core/transactional/git-worktree.ts) のみ。
大きめ repo では snapshot 構築コストが transactional 常用の障壁。

### R12 — `SnapshotBackend` 抽象

`src/core/transactional/backend.ts`(新規):

```ts
export interface SnapshotBackend {
  readonly id: 'worktree' | 'apfs-clone' | 'overlayfs'
  available(repoRoot: string): Promise<boolean>   // プラットフォーム・FS 検査
  create(repoRoot: string): Promise<Snapshot>     // 隔離作業領域
  observeDiff(snapshot: Snapshot): Promise<ObservedDiff>  // 既存 diff-evaluator 互換
  commit(snapshot: Snapshot): Promise<void>
  discard(snapshot: Snapshot): Promise<void>
}
```

- 既存の git-worktree 実装をこの interface に載せ替える(挙動不変、
  リファクタのみ)
- config: `policy.transactional.backend: 'worktree' | 'apfs-clone' | 'auto'`
  を追加、**default `'worktree'`**(既存挙動不変)。`'auto'` は
  `available()` が真の最速バックエンドを選ぶ opt-in

### R13 — APFS clone バックエンド(macOS 先行)

- `clonefile(2)`(`cp -c` 相当)による CoW スナップショット。APFS 以外の
  ボリュームでは `available() === false`
- diff 観測は clone 領域と元の比較(既存 `diff-evaluator.ts` のカテゴリ
  判定をそのまま使う — 効果カテゴリのロジックはバックエンド非依存に保つ)
- commit は「clone 上の変更を元へ反映」ではなく**従来どおり実コマンドの
  apply 戦略に従う**(v0.8 の二重実行防止セマンティクス
  `transactional_already_applied` を変えない)
- overlayfs(Linux)は本 SPEC ではスコープ外(stretch)。interface だけ
  先に切ってあるので v1.2 で追加可能

### R14 — バックエンドパリティとベンチ

- パリティテスト: 同一シナリオ集(安全な mutation / repo 外書き込み /
  大量削除 / タイムアウト / 非ゼロ exit)を利用可能な全バックエンドで実行し、
  **ObservedDiff のカテゴリ判定と最終 verdict が完全一致**することを assert
- `scripts/bench-transactional.mjs`: snapshot create→discard の所要時間を
  repo サイズ別(小 / node_modules 込み)に計測し、結果を JSON で記録。
  リリースノートに worktree 比の改善率を載せる(目標: macOS で create が
  **10 倍以上**高速。未達でも出荷は可、数値は正直に書く)

### R15 — Windows 基線

- CI に `windows-latest` ジョブを常設: unit テスト + `l3-l4-only`
  conformance プロファイル(L1/L2 の e2e は対象外 — 従来のパリティ原則)
- 発見されたパス正規化・シェル差異の修正は個別 bug fix として処理。
  guarantee table への影響なし(Windows は L3+L4 行のみ主張)

**受け入れ:**
- T9: パリティテストが worktree / apfs-clone(macOS CI)で green
- T10: ベンチスクリプトが数値を出力し、`docs/`(リリースノート素材)に
  記録される。Windows ジョブが必須チェック化

---

## WS-E — チーム配布(署名付き policy bundle)

**現状:** config は builtin → team → repo → protected のレイヤ解決
(v0.6)を持つが、team レイヤを安全に「配る」手段がない(ファイルを
コピーするだけ。改竄・出所の検証なし)。

### R16 — bundle 形式

`<name>.belay-bundle.json`:

```json
{
  "bundleVersion": 1,
  "createdAt": "…",
  "publicKeyId": "…",
  "payload": {
    "policy": { "rules": [ … ] },
    "overrides": { "allow": [ … ], "external": [ … ] },
    "classifier": { "sensitivePaths": [ … ] },
    "egressAllowlistSeed": [ { "host": "…", "includeSubdomains": false } ]
  },
  "signature": "…"
}
```

- payload に含められるのは上記 4 区画のみ(ホワイトリスト方式)。
  `mode` / `gates` / `sandbox` / `controlPlane` / `approvalSigning` は
  **含められない** — bundle で防御を弱める経路を構造的に塞ぐ
- 署名は v0.6 の鍵基盤(control-plane の署名鍵)を再利用

### R17 — CLI

```
agent-belay bundle export --out team.belay-bundle.json
agent-belay bundle trust <pubkey-file>        # 受け手側: 公開鍵をピン
agent-belay bundle import <file> [--dry-run]
agent-belay bundle status                     # 適用中 bundle と鍵の表示
```

- `import` は署名検証(ピン済み公開鍵のみ)→ payload バリデーション
  (`policy lint` 相当を内部実行)→ **team レイヤ**へ書き込み。
  未署名・未信頼鍵・検証失敗は拒否(fail-closed)
- レイヤ優先順位により repo / protected レイヤが常に team を上書きできる
  ことは既存セマンティクスのまま(bundle は「下敷き」にしかなれない)
- `egressAllowlistSeed` は import 時に allowlist へ
  `addedAt`/`approvalId: "bundle:<keyId>"` 付きで合流。`allowlist list` で
  出所が見える

**受け入れ:**
- T11: export → 別環境で trust → import → ルールが効く e2e。
  改竄 bundle / 未信頼鍵 / payload に `sandbox` を仕込んだケースの
  3 つの拒否 negative テスト

---

## 実装順序(PR 分割)

計測ゲート(R5)を後半に置くため、計測の前提になる WS-B を先行させる。

1. **PR-1 (WS-B 計測)**: metrics v3(R9)+ 承認時の観測事実表示(R8)。
   昇格判定とノイズ計測の土台を最初に敷く
2. **PR-2 (WS-A 運用)**: autoStart / stale pid / 多 repo ポート(R1, R2)
3. **PR-3 (WS-A 可視化 + allowlist)**: カバレッジ(R3)+ allowlist
   メタデータと `allowlist` サブコマンド(R4)。`harden --egress` もここ
4. **PR-4 (WS-B suggest)**: `suggest` / `suggest --apply`(R6, R7)
5. **PR-5 (WS-D)**: backend 抽象 + APFS clone + パリティ/ベンチ +
   Windows CI(R12–R15)
6. **PR-6 (WS-E)**: bundle(R16, R17)
7. **PR-7 (WS-C + 昇格判定)**: 外部アダプタ tarball e2e(R10)、SDK
   ギャップ総括(R11)、**R5 の昇格基準を計測値で判定**し、満たせば init
   テンプレート変更、満たさなければ判定結果を ROADMAP に記録して見送り

外部アダプタ本体(別リポジトリ)は PR-2〜6 と並行して進める。

## 非目標(v1.1 でやらないこと)

- 既存 config の挙動変更(全て新規 init テンプレート + `harden` 経由)
- SaaS / 中央管理サーバー(bundle はファイル配布で止める)
- overlayfs バックエンド(interface のみ。実装は v1.2 候補)
- transactional(L2)のデフォルト有効化(計測だけ始める。昇格は v1.2 以降)
- サンドボックスランタイムの自作・L3 分類器への再投資(従来どおり)
- DNS レベルのエグレス観測(bypass 疑いの「検出」までで止める。「防止」は
  L1-full の領分という整理を変えない)

## リスク と 対応

| リスク | 影響 | 対応 |
|---|---|---|
| autoStart が agent 環境で野良プロセスを増やす | プロセスリーク・ポート枯渇 | pid+起動時刻照合(R1)、`stop --all`、doctor のプロセス棚卸し表示 |
| カバレッジレポートの false positive | 「bypass 疑い」が狼少年化し無視される | ヒント→観測の突き合わせ窓を可変に、既知 FP パターン(localhost、プロキシ自身)を除外リスト化 |
| suggest が緩いルールを量産する | ノイズ削減と引き換えに L3 が空洞化 | 提案は最深・最小スコープのみ(親パス非昇格、ワイルドカード非提案)。適用前 simulate 必須 |
| APFS clone の edge case(シンボリックリンク、xattr) | diff 観測の不一致 | パリティテスト(T9)を必須チェック化。不一致が残る間は `auto` から除外 |
| 昇格基準が期間内に満たせない | init デフォルト変更が滑る | 仕様上「見送り可」を明記済み(PR-7)。`harden --egress` だけでも v1.1 の価値は立つ |
| bundle の鍵運用がチームに重い | 機能が使われない | `bundle trust` を 1 コマンドに保つ。鍵ローテーションは v1.1 ではドキュメント手順のみ |

## 終了条件(再掲・検証可能形)

v1.1 タグを打てる条件:

1. T1–T11 が CI で green(T9 の apfs-clone は macOS ジョブ、T10 の
   Windows ジョブを含む)
2. `harden --egress` で既存環境が L1-partial に 1 コマンドで移行できる
3. metrics v3 が摩擦指標(approvalsPerSession / reApprovalRate /
   suggestCoverage)を出力する
4. 外部アダプタパッケージが公開され、SDK のみで conformance を通過している
5. R5 の昇格判定が実施され、結果(採用 or 見送りと根拠数値)が
   ROADMAP に記録されている
6. guarantee table(claims registry)に変更がないこと、または変更が
   `verify:guarantees` を通っていること(v1.1 は保証を増やさない —
   増やすのは使われる頻度)
