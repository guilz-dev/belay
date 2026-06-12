# agent-belay SPEC v1.2 — Full Belay(L1-full を一コマンドの距離にする)

> 前提: [`SPEC-v1.0.md`](./SPEC-v1.0.md)(保証の契約化)と
> [`SPEC-v1.1.md`](./SPEC-v1.1.md)(L1-partial の日常化)の全 WS が
> 出荷済みであること。特に依存するもの: claims registry +
> `verify:guarantees`(v1.0 WS-A)、`harden`(v1.0 R7 / v1.1 R5)、
> `SnapshotBackend` 抽象 + APFS clone + ベンチ(v1.1 WS-D)、
> metrics v3 の摩擦指標(v1.1 R9)、bundle 署名基盤(v1.1 WS-E)、
> SDK ギャップ総括(v1.1 R11)。
>
> Status: Draft — v1.1 タグ後にレビュー・着手。

## Summary

はしごは下から順に登らせてきた:

- v0.9 — L1-full の**機構**を出荷した(sandbox broker / isolation / signing)
- v1.0 — L1-full の**保証**をテストで裏づけた(claims registry)
- v1.1 — L1-partial(egress)を**日常**にした

しかし L1-full だけは依然「手で組み立てる構成」のままである。前提 4 つ
(sandbox runtime / egress / isolation / signing)のうち、ランタイムの
プロビジョニング — コンテナの network 設定、seatbelt プロファイル、
read-only マウント — は全部ユーザーの宿題になっている。**adversarial 耐性を
主張できる唯一の行が、一番セットアップが重い**。これが v1.2 が解く問題である。

投資先は 4 つ:

1. **WS-A — `agent-belay run`(L1-full ランチャー)**: 既存サンドボックス
   ランタイムのプロビジョニングを belay が代行し、エージェントを L1-full
   構成で起動するまでを 1 コマンドにする。サンドボックス自体は引き続き
   実装しない(ADR-001 Option B との分業は不変)
2. **WS-B — L2 の昇格と Linux パリティ**: overlayfs バックエンド(v1.1 で
   interface のみ切った繰り越し)、`backend: 'auto'` の既定化、そして
   v1.1 から計測してきた数値による **transactional の新規 init デフォルト化
   判定**(egress 昇格と同じ計測ゲート方式)
3. **WS-C — 鍵と状態のライフサイクル**: 署名鍵・bundle 鍵のローテーション
   (v1.1 でドキュメント手順止まりだった繰り越し)、監査ログのローテーション、
   マシン間の状態移行
4. **WS-D — エコシステム第 2 周**: v1.1 の SDK ギャップ総括の反映、
   conformance のバージョン固定と「belay compatible」基準の文書化

**semver 制約(全 WS 共通、v1.1 と同一)**: v1.2 は minor。既存 config の
挙動は変えない。デフォルト変更は新規 init テンプレートと `harden` 経由のみ。

v1.1 が「保証を増やさないリリース」だったのに対し、**v1.2 は claims を
増やす**: ランチャーが作る環境そのものが検証対象になる(WS-A R6)。

要件は R1〜R17、受け入れテストは T1〜T10。

---

## 終了条件 → 検証のマッピング

| v1.2 の終了条件 | 検証手段 | 担当 WS |
|---|---|---|
| L1-full が 1 コマンドで到達できる(macOS + Linux) | `run` の provision e2e + バイパス試行の失敗(T1–T3) | WS-A |
| ランチャー環境が guarantee table の主張を満たす | 新 claim `G-L1FULL-PROVISIONED` + `verify:guarantees`(T4) | WS-A |
| L2 が Linux でも実用速度 | overlayfs パリティ + ベンチ(T5) | WS-B |
| transactional の昇格が数値で判定される | 昇格基準の判定記録 + init スナップショット(T6) | WS-B |
| 鍵がローテーションできる(運用停止なし) | rotate → 旧鍵失効 → 検証継続の e2e(T7, T8) | WS-C |
| 監査と状態が長期運用に耐える | rotation / export / 移行の e2e(T9) | WS-C |
| conformance がバージョン固定で互換主張の基準になる | 外部アダプタの再検証 + バッジ基準文書(T10) | WS-D |

---

## WS-A — `agent-belay run`(L1-full ランチャー)

**現状:** `sandbox.enabled: true` は「外部ランタイムの中で動いている」
前提を broker が引き受けるだけで、その環境を**作る**のはユーザー。
`sandbox status` は前提の充足を報告できる(`l1FullActive`)が、充足させる
手段が手作業。

**方針:** プロビジョニングをランタイム別レシピとしてコード化し、
起動から検証までを 1 コマンドにする。belay はオーケストレータであって
サンドボックスではない、という線は越えない。

### R1 — `agent-belay run`(新コマンド)

```
agent-belay run [--runtime container|seatbelt|landlock]
                [--profile <name>] [--dry-run] [--keep] -- <agent-command>
```

実行シーケンス:

1. **前提確認**: config の L1-full 前提(signing / isolation 設定)を検査。
   不足は `harden` への誘導メッセージで fail(黙って弱い構成で起動しない —
   fail-closed)
2. **egress 起動**: プロキシ死活確認、必要なら起動(v1.1 R1 の再利用)
3. **プロビジョニング**: ランタイムレシピ(R2)に従いサンドボックスを構成
   — ネットワーク deny-all(プロキシへの経路のみ)、repo を rw、
   control plane を read-only、`HTTP_PROXY`/`HTTPS_PROXY` 注入
4. **起動前検証**: サンドボックス内からの自己診断プローブ(R4)を実行し、
   全項目 pass を確認してからエージェントコマンドを exec する。
   1 項目でも fail なら起動中止(`--dry-run` はここまでを実行して報告)
5. **終了時**: 実行サマリ(gate イベント数、egress 観測数、承認数)を表示。
   `--keep` がなければ一時リソース(コンテナ等)を破棄

### R2 — ランタイムレシピ

`src/core/sandbox/recipes/`(新規)にランタイム別モジュール:

| ランタイム | 対象 OS | 機構 |
|---|---|---|
| `container` | Linux / macOS | docker または podman を検出。`--network` はプロキシ専用の内部ネットワーク(プロキシコンテナ or host gateway への単一許可)。repo を bind mount(rw)、control plane dir を read-only mount |
| `seatbelt` | macOS | `sandbox-exec` プロファイルを生成: file-write は repo + 一時領域のみ、network outbound はプロキシの host:port のみ許可 |
| `landlock` | Linux | landlock ABI のラッパー実行体で FS スコープを制限。ネットワークは fallback として network namespace(`ip netns` / slirp)を併用 |

- レシピの出力は「実行コマンドライン + 一時ファイル群」の宣言的な
  `ProvisionPlan` とし、`--dry-run` はこれを表示する(ユーザーが belay の
  やることを事前に全部読める — 監査可能性)
- `cursor-sandbox` は IDE 側が provision するため `run` の対象外
  (`sandbox status` での検証のみ、従来どおり)
- 検出失敗(docker なし等)は代替ランタイムの提案つきエラー

### R3 — `harden --full`

`harden` の最終段として追加: signing + isolation(v1.0)+ egress
(v1.1)に加え、利用可能なランタイムを検出して `sandbox.enabled` /
`runtime` を設定し、`run` の使い方を表示する。これで `harden` 1 系統が
「デフォルト構成 → L1-full」の全はしごをカバーする。

### R4 — 自己診断プローブ

`run` の起動前検証(およびスタンドアロンの
`agent-belay sandbox probe [--json]`)。サンドボックス内から実際に試行する:

1. 直接外部接続(プロキシ迂回)→ **失敗すること**
2. プロキシ経由で未許可ドメイン → 463 + pending approval が生成されること
3. repo 外パスへの書き込み → **失敗すること**
4. control plane ファイルへの書き込み → **失敗すること**
5. `HTTP_PROXY` env の存在と到達性

プローブ結果は `sandbox-probe-last.json` に記録され、`doctor` /
`sandbox status` が参照する(OQ3 スパイクと同じパターン)。

### R5 — `l1FullActive` の格上げ

現状の `l1FullActive` は **config の宣言**を検査している。v1.2 で
「宣言 + 直近プローブ pass」の 2 段階に分け、表示を分離する:

- `l1FullConfigured` — 前提 4 つの設定が揃っている(従来の判定)
- `l1FullVerified` — 加えて直近のプローブ(R4)が全項目 pass

guarantee table の「What is never guaranteed」にあった
「config が約束してもランタイムが強制していない場合」を、検出可能な状態に
変える。既存 API の `l1FullActive` は `l1FullConfigured` の別名として維持
(minor 互換)。

### R6 — claims の追加

claims registry(v1.0 R1)に追加し、`verify:guarantees` の対象にする:

- `G-L1FULL-PROVISIONED`(guaranteed / adversarial):
  「`run` が provision した環境では、プローブ全項目が pass し、
  バイパス試行(直接続・repo 外書き込み・control-plane 改竄)が失敗する」
  — verifiedBy: T2/T3 の e2e
- `G-L1FULL-DNS-CONTAINED`(guaranteed / adversarial、**container/
  seatbelt レシピのみ**): 「network deny-all 下では DNS を含む直接の
  外部経路が存在しない」— v0.7 以来 "never guaranteed" だった covert
  channel のうち、**ランタイムが網羅できる範囲だけ**を構成限定で主張に
  変える。プロキシ経由の漏出(許可済みドメインへの encode)は引き続き
  非保証として明記

**受け入れ:**
- T1: `run --dry-run` が各ランタイムで ProvisionPlan を出力し、
  前提不足時は harden 誘導つきで fail する
- T2: container レシピ e2e(Linux CI)— `run` 内から R4 プローブ全 pass、
  バイパス 3 種が失敗、`--keep` なしでリソースが残らない
- T3: seatbelt レシピ e2e(macOS CI)— 同上
- T4: `pnpm verify:guarantees` が新 claim を含めて green。
  `l1FullVerified` がプローブ失効(古い probe 結果)で false に落ちる

---

## WS-B — L2 の昇格と Linux パリティ

**現状(v1.1 出荷後):** `SnapshotBackend` 抽象 + worktree / apfs-clone。
`backend` default は `'worktree'`。transactional は opt-in のまま。
metrics v3 が摩擦指標を、ベンチが速度を計測している。

### R7 — overlayfs バックエンド(v1.1 繰り越し)

- `id: 'overlayfs'` の `SnapshotBackend` 実装。優先順: user namespace +
  unprivileged overlay(カーネル ≥5.11)→ 不可なら `available() === false`
  (root 要求や fuse-overlayfs フォールバックは**しない** — 静かに権限を
  要求する経路を作らない)
- diff 観測は upperdir の走査(既存 `diff-evaluator.ts` のカテゴリ判定を
  共用 — バックエンド非依存原則の維持)
- v1.1 のパリティテスト(T9 相当)に overlayfs を追加(Linux CI)

### R8 — `backend: 'auto'` の既定化(新規 init のみ)

- 新規 init テンプレートの `policy.transactional.backend` を `'auto'` に
  変更(既存 config は `'worktree'` のまま不変)
- `'auto'` の選択順: apfs-clone(macOS / APFS)→ overlayfs(Linux /
  対応カーネル)→ worktree。選択結果は `explain` / 監査レコードに
  `snapshotBackend` として記録
- 昇格条件: パリティテストが当該バックエンドで 2 マイナーリリース連続
  green であること(v1.1 で apfs-clone は 1 リリース分の実績がある)

### R9 — transactional のデフォルト昇格(計測ゲート付き)

v1.1 R5(egress 昇格)と同じ方式。`harden --transactional` を追加し、
新規 init テンプレートでの `policy.transactional.enabled: true` は
以下の数値判定で決める:

**昇格基準**(v1.1 から蓄積した metrics v3 + corpus):

1. 最適化バックエンド環境で、transactional 発動時のレイテンシ p90 が
   **2 秒未満**(ベンチ + dogfood 実測)
2. 「予測 vs 実測の乖離率」(v0.8 で導入した corpus 指標)が、
   transactional 有効時の誤 deny 削減として**統計的に正方向**であること
3. `transactional_observed_risk` の false positive(安全な diff の誤
   エスカレート)が運用上無視できる水準(週あたり数件以下)

満たさなければ v1.2 では `harden --transactional` 止まりで出荷し、判定
結果と数値を ROADMAP に記録する(v1.1 の egress 昇格と同じ「見送り可」
原則)。

**受け入れ:**
- T5: overlayfs パリティテスト(worktree / apfs-clone / overlayfs で
  ObservedDiff カテゴリと verdict が完全一致)+ ベンチ数値の記録
- T6: 昇格実施時: init スナップショットにテンプレート変更が現れ、既存
  config のロード結果が不変。見送り時: 判定記録が ROADMAP に存在する

---

## WS-C — 鍵と状態のライフサイクル

**現状:** 署名鍵(v0.6)・bundle 鍵(v1.1)は生成後ローテーション手段が
ない(v1.1 はドキュメント手順のみと明記して繰り越した)。監査 NDJSON は
無限に伸びる。マシンを替えると control plane の状態(allowlist、承認
キャッシュ)を持ち出す公式手段がない。

### R10 — 鍵ローテーション

```
agent-belay key rotate [--json]
agent-belay key status
```

- 新鍵ペアを生成し、旧公開鍵を `retiredKeys`(検証専用・期限つき)へ移す。
  承認トークンは TTL が短い(既定 15 分)ため、**移行猶予 = 最長 TTL** で
  旧鍵検証を打ち切る — 二重有効期間を最小化
- bundle 鍵: rotate 後、`bundle export` は新鍵で署名。受け手側の
  `bundle trust` は複数鍵のピンをサポート(v1.1 R17 の拡張)し、
  `bundle trust --retire <keyId>` で旧鍵を失効できる
- 鍵ファイルの権限検査(0600、所有者)を `doctor` に追加。isolation
  有効時は鍵が agent から読めないことをプローブ(WS-A R4)の項目に追加

### R11 — 監査ログのローテーションと保持

config `audit` セクションに追加(全て optional、既定は現状維持 = 無制限):

```json
{ "audit": { "rotate": { "maxSizeMb": 64, "keep": 8 } } }
```

- gate runtime が書き込み時にサイズ超過を検知して
  `audit.ndjson.1` … `.N` へローテーション(プロセス間の競合は
  rename の原子性に依拠し、失敗時は書き込み継続を優先 — 監査の欠落より
  肥大を許容)
- `audit query` / `summarize` / `metrics` はローテーション済みファイルを
  透過的に読む(`--since` がローテーション境界をまたげる)
- `agent-belay audit export --out <file> [--since <iso>] [--redact-extra]`:
  ローテーション分を含めて単一ファイルへ書き出し(外部 SIEM 等への
  持ち出し用。サーバー連携は作らない — ファイルで渡す)

### R12 — 状態のエクスポート / インポート(マシン移行)

```
agent-belay state export --out belay-state.tar.gz [--include-keys]
agent-belay state import <file> [--dry-run]
```

- 対象: control plane の allowlist 群(egress / fs-scope)、bundle の
  trust 設定、config のユーザーレイヤ。**秘密鍵は既定で除外**
  (`--include-keys` で明示時のみ、警告つき)
- import は doctor 検査を内部実行し、isolation 設定と矛盾する状態
  (旧マシンの uid 前提など)を検出して修正案を出す
- 承認キャッシュ(approved-approvals)は**移行対象外** — one-shot
  セマンティクスの侵食を防ぐ(移行されるのは「育ったリスト」だけ)

**受け入れ:**
- T7: rotate e2e — rotate → 旧鍵で署名されたトークンが猶予内は valid /
  猶予後は invalid、新鍵トークンが常に valid。bundle の複数鍵ピンと
  `--retire`
- T8: isolation 有効時に agent 側から鍵が読めないことのプローブ項目追加分
- T9: rotation / export / state import の e2e(`--since` がローテーション
  境界をまたぐ query を含む)。`state export` 既定に秘密鍵が含まれない
  negative テスト

---

## WS-D — エコシステム第 2 周

**現状(v1.1 出荷後):** 外部アダプタ 1 本が SDK のみで動いている。
v1.1 R11 の「SDK 追加なしで書けたか」総括が ROADMAP にある。

### R13 — SDK ギャップの反映

- v1.1 総括で挙がった不足 API を adapter-sdk に追加(minor)。
  本 SPEC では中身を予断しない — 総括ドキュメントを正とする。
  各追加は `docs/adapter-sdk.md` の Changelog 節に経緯つきで記録(v1.1
  R11 の運用継続)

### R14 — conformance のバージョン固定

- `CONFORMANCE_VERSION`(integer)を導入し、`runAdapterConformance` の
  report に含める。シナリオ追加 = インクリメント
- 「belay compatible」を名乗る基準を `docs/adapter-sdk.md` に明文化:
  **公開済み最新 CONFORMANCE_VERSION でレポート pass**。アダプタ側
  README に貼れるバッジ文言(テキスト基準のみ。バッジサービスは作らない)

### R15 — 外部アダプタの追従検証

- 本体 CI の tarball e2e(v1.1 R10)を、外部アダプタの**公開済み最新版**
  に対して定期実行(リリース前チェックリスト項目に追加)。SDK の minor
  追加が外部アダプタを壊していないことの実証 = semver 約束の継続的検証

**受け入れ:**
- T10: CONFORMANCE_VERSION が report に出る。旧バージョンの conformance
  で pass し最新で fail するアダプタを人工的に作り、互換主張の基準が
  バージョンで判別できることをテスト

---

## 横断 — ドキュメントと保証の更新

### R16 — guarantee table の改訂

- `G-L1FULL-PROVISIONED` / `G-L1FULL-DNS-CONTAINED`(R6)を claims に追加
  し、生成された guarantee table に反映
- 「What is never guaranteed」から DNS 項目を**構成限定で**移動し、
  残る covert channel(許可済みドメインへの encode 漏出、タイミング系)を
  明記し直す — 主張を増やすときほど、増えない部分を明確にする
- SECURITY.md の threat model に `run` ランチャーの信頼前提
  (docker/podman デーモン、sandbox-exec の正しさ)を追記

### R17 — README / MIGRATION

- README の「Enabling the layers」L1-full 節を `run` ベースに書き換え
  (手動レシピは docs へ降格)
- `docs/MIGRATION-v1.md` に v1.1 → v1.2 節を追加: `harden --full` /
  `run` の導入手順、鍵ローテーションの推奨周期(目安 90 日、強制しない)

---

## 実装順序(PR 分割)

1. **PR-1 (WS-A 基盤)**: ProvisionPlan 型 + レシピ抽象 + `run --dry-run`
   (R1 の 1–3 を plan 表示まで)+ プローブ(R4)
2. **PR-2 (WS-A container)**: container レシピ実走 + T2 e2e(Linux CI)
3. **PR-3 (WS-A seatbelt + 格上げ)**: seatbelt レシピ + T3(macOS CI)、
   `l1FullVerified`(R5)、claims 追加(R6)、`harden --full`(R3)
4. **PR-4 (WS-B)**: overlayfs バックエンド + パリティ(R7)、
   `auto` 既定化(R8)
5. **PR-5 (WS-C)**: 鍵ローテーション(R10)→ 監査ローテーション(R11)→
   state export/import(R12)
6. **PR-6 (WS-D)**: SDK ギャップ反映 + CONFORMANCE_VERSION(R13, R14)、
   外部アダプタ追従検証の CI 組み込み(R15)
7. **PR-7 (昇格判定 + 仕上げ)**: transactional 昇格判定(R9)、
   guarantee table / SECURITY / README / MIGRATION 改訂(R16, R17)、
   リリースチェックリスト実走

landlock レシピは container/seatbelt の 2 本が安定してからの追補
(v1.2 内の stretch、間に合わなければ v1.3 へ — `run` の価値は 2 ランタイム
で立つ)。

## 非目標(v1.2 でやらないこと)

- サンドボックスランタイムの自作(レシピは既存ランタイムの設定生成のみ)
- Windows のサンドボックスレシピ(WSL2 経由の container 利用は docs で
  案内するに留める。Windows の保証行は引き続き L3+L4 のみ)
- プロキシ経由の covert channel(許可済みドメインへの encode 漏出)の防止
  — 検出研究は v1.3 候補。保証としては明示的に非対象のまま
- 中央鍵管理・KMS 連携(鍵はローカルファイル + ローテーションまで)
- 監査の外部送信機能(export はファイルまで。SIEM 連携はユーザー側)
- L3 分類器への再投資(不変)

## リスク と 対応

| リスク | 影響 | 対応 |
|---|---|---|
| レシピがランタイムのバージョン差で壊れる(docker / sandbox-exec の仕様変更) | `run` の信頼性低下 | プローブ(R4)を起動時必須にしているため「壊れたまま弱い構成で動く」ことはない(fail-closed)。CI でランタイムのバージョンマトリクスを最小 2 系列 |
| seatbelt(`sandbox-exec`)の非公開仕様依存 | macOS 更新で破損 | プロファイルは最小権限の静的生成に限定し、macOS CI を必須チェック化。破損時は `run` がエラー + container 代替を提案 |
| DNS 封じ込め claim の過大主張 | 信頼毀損(v1.0 で築いた誠実さの逆行) | claim をレシピ限定 + プローブ実証つきに限定(R6)。許可済みドメイン経由の漏出を同じ節で非保証と明記 |
| overlayfs の権限要件が環境依存 | Linux で `auto` が期待倒れ | unprivileged 不可なら静かに worktree へ(選択結果を explain に常時表示、黙らない) |
| 鍵ローテーションの猶予設計ミス | 旧鍵トークンの失効漏れ / 全承認の即死 | 猶予 = 最長 TTL に固定(設定可能にしない)。rotate の e2e に境界時刻テスト |
| `run` がエージェント側の起動方法と噛み合わない(IDE 内蔵エージェント) | 利用者が CLI エージェントに限定される | 対象を CLI 起動エージェントと明記。IDE 内蔵は `cursor-sandbox` 経路(IDE が provision)を維持し、`sandbox status` の検証で同等性を担保 |

## 終了条件(再掲・検証可能形)

v1.2 タグを打てる条件:

1. T1–T10 が CI で green(Linux: container + overlayfs、macOS: seatbelt +
   apfs-clone のマトリクス)
2. `agent-belay run -- <cmd>` が macOS / Linux で L1-full 環境を provision
   し、プローブ全 pass からのみエージェントを起動する
3. `G-L1FULL-PROVISIONED` / `G-L1FULL-DNS-CONTAINED` が claims registry に
   入り、`verify:guarantees` が通る。非保証として残る covert channel が
   同時に明文化されている
4. `harden` 1 系統(`--egress` / `--transactional` / `--full`)で
   デフォルト構成から L1-full までの全段が移行できる
5. transactional の昇格判定が実施され、結果(採用 or 見送りと根拠数値)が
   ROADMAP に記録されている
6. 鍵ローテーション・監査ローテーション・state 移行が e2e で実証され、
   MIGRATION-v1.md に運用手順がある
