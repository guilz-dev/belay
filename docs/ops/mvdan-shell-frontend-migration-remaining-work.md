# Mvdan Shell Frontend Migration 残件

## ステータス

**設計完了／実装未完了**

- [PR #141](https://github.com/guilz-dev/belay/pull/141) で設計書をマージ済み。CI は成功している。
- [PR #143](https://github.com/guilz-dev/belay/pull/143) で parser-neutral interface、rollout mode、比較器、span validation、および fail-closed の足場を実装済み。CI は成功している。
- 互換性 probe、Go/Wasm bridge、production parser artifact、shadow 計測、および各 promotion gate は未完了。
- 2026-09-21 時点の最新リリース `v0.12.3` は上記変更より前であり、本移行は未リリースである。

正本の設計は
[`docs/superpowers/specs/2026-09-19-mvdan-shell-frontend-migration-design.md`](../superpowers/specs/2026-09-19-mvdan-shell-frontend-migration-design.md)
とする。この文書は残件の索引であり、実装、依存関係の追加、rollout、release を許可するものではない。

## 最終完了定義

移行全体が完了したと言えるのは、Belay が汎用 shell grammar を独自保守せず、`mvdan/sh` frontend が release 済みの authority となり、次の条件を同時に満たした時点とする。

- canonical `EffectPlan` が唯一の shell authorization input であり続ける。
- CLI semantics と unknown effect が明示されたままである。
- parser、artifact、protocol、comparison、rollout の失敗が approval-worthy operation を `allow` へ変えない。
- legacy frontend の削除条件と downgrade 手順が満たされている。

## 完了済み

- `ShellFrontend` / `ParsedShellProgram` の parser-neutral contract
- `legacy` / `shadow` / `canary` / `mvdan` rollout mode と config validation
- legacy frontend adapter
- frontend plan の正規化比較と disagreement の fail-closed 処理
- UTF-8 byte span validation の基盤
- mvdan artifact 不在時に `partial + indeterminate` とする placeholder frontend
- `legacy` を既定かつ唯一の実用 authority として維持する構成
- non-legacy mode が legacy の permissive な結果へ暗黙 fallback しない回帰テスト

現状の `mvdan` frontend は production parser ではなく、artifact 不在を明示する placeholder である。

## 残件の実装順

### 1. Disposable compatibility probe

本番依存関係を追加する前に、`sh-syntax` を一時的な adapter として使用し、移行可能性を測定する。

成果物:

- `docs/ops/mvdan-shell-probe-result.md`
- 使用した `sh-syntax` と underlying `mvdan/sh` の正確な revision
- corpus、structural、adversarial、実 dogfood 由来ケースの件数と結果
- syntax category ごとの parse success / partial / failure
- 必要な AST 情報の充足状況
- normalized EffectPlan の比較結果
- warm / fresh-process cold latency
- artifact 欠損、破損、malformed response の fail-closed 結果
- package size と hook bundle 増加量

完了条件:

- 必要な全 syntax category を node の黙示的欠落なしに射影できる。
- parse / projection failure が必ず `partial + indeterminate` になる。
- 未解決の `candidate_looser` が 0 件である。
- artifact / protocol failure から `allow` が発生しない。
- full-gate warm p95 が 100 ms 未満、max が 500 ms 未満である。
- fresh-process cold max が 500 ms 未満である。
- 対応 platform で network access なしに artifact を load できる。

probe が失敗した場合は production migration を停止する。閾値緩和や別 parser への自動切替は行わない。

### 2. Pinned Go/Wasm bridge と artifact integrity

probe 合格後に、Belay 所有の最小 bridge を追加する。

予定成果物:

```text
vendor/mvdan-shell-bridge/
  go.mod
  go.sum
  main.go
  LICENSES.md

dist/bundle/
  shell-parser.wasm
  shell-parser-worker.mjs
  shell-parser.manifest.json
```

完了条件:

- `mvdan/sh` を `go.mod` / `go.sum` の immutable exact version へ固定する。
- install 時および runtime の download を禁止する。
- release CI で bridge を再ビルドし、生成 hash の一致を検証する。
- parser manifest が frontend ID、module version、Wasm、worker、bridge source の SHA-256 を保持する。
- installer integrity manifest と `runtimeArtifactHash` が全 enforcement artifact を包含する。
- missing / modified / truncated / wrong-version artifact を `doctor` と runtime の双方が検出する。
- license と再現可能ビルドの要件を満たす。

### 3. Production `MvdanShellFrontend`

placeholder を実 parser client へ置き換える。

完了条件:

- Wasm worker は command bytes と固定 parser options 以外を受け取らない。
- filesystem、network、environment、control plane への callback を持たない。
- `MAX_SHELL_COMMAND_BYTES = 64 KiB` を worker 作成前に適用する。
- AST node 上限 10,000、depth 上限 128、wall-clock timeout 250 ms を適用する。
- 成功、protocol error、timeout のいずれでも worker を確実に終了する。
- upstream の未対応 node は省略せず `unsupported` として返す。
- byte span の境界違反、重複、親子矛盾を `invalid_span` として partial にする。
- raw AST、raw source、upstream parser message を audit へ保存しない。

### 4. Shared semantic lowering への接続

両 frontend が同じ Belay-owned semantic decoder を使用するよう、構造化入力への移行を完了する。

完了条件:

- Git、egress、filesystem、launcher、wrapper など既存 decoder の意味を維持する。
- redirect、heredoc、substitution、pipeline、nested command の effect を保持する。
- unknown CLI semantics は shell parse が complete でも `indeterminate` のままにする。
- manifest resolution を含む frontend ごとの plan を、比較前に独立して lower / normalize する。
- decoder 修正が必要な場合は parser migration と分離した named change と回帰ケースにする。
- corpus、structural、substitution、recursive-wrapper、adversarial mutation の differential tests を追加する。

### 5. Packaging・platform・runtime verification

完了条件:

- build script、runtime bundle、installer、upgrade、doctor を新 artifact に対応させる。
- Node 22 の macOS arm64、macOS x64、Linux x64 で検証する。
- offline startup と parser load を検証する。
- Cursor、Claude、Codex adapter の canonical EffectPlan conformance を確認する。
- warm / cold の full-gate latency budget を CI または再現可能な測定手順で固定する。
- audit serialization に raw AST、raw word、source slice、environment、parser exception が含まれないことを検証する。

### 6. `shadow` rollout

probe と production artifact の全条件を満たした release でのみ、手動で `shadow` を開始する。

完了条件:

- canonical plan は legacy のままである。
- mvdan candidate は authority、approval、grant、contained-execution eligibility、hook response を変更しない。
- comparison telemetry に frontend/artifact identity、completeness、diagnostic codes、plan hash、comparison class、duration のみを記録する。
- unresolved `candidate_looser` が 0 件である。
- warm-up 後の `candidate_unavailable` が 0 件である。
- 全 difference に reviewed disposition がある。
- corpus / adversarial hard gate と latency gate を満たす。

### 7. `canary` rollout

shadow gate 合格後、mvdan plan を canonical candidate とし、legacy plan と比較する。

完了条件:

- authorization-relevant disagreement に `parser.disagreement + indeterminate` を追加する。
- 両 plan の union や、より permissive な plan の選択を行わない。
- missing artifact、timeout、protocol error、unsupported node、invalid span がすべて fail-closed になる。
- active canary cohort に reviewed provably-benign event が 150 件以上ある。
- 3 つ以上の有効な session correlation を含む。
- benign block rate が 2% 未満である。
- availability ask が 0 件である。
- unsafe allow が 0 件である。
- 全 adapter が cross-adapter suite で同じ canonical EffectPlan を生成する。

### 8. `mvdan` authoritative rollout

canary gate 合格後、release 単位の手動変更で `mvdan` を authority にする。

完了条件:

- legacy parser を decision path で呼び出さない。
- parser / artifact failure から legacy allow へ fallback しない。
- rollback は同じ release 内の trusted config 変更で `legacy` へ戻せる。
- frontend mode と artifact identity が decision cohort に反映される。
- rollout と rollback の operator 手順を文書化する。

### 9. Legacy frontend cleanup

次の条件を満たすまで legacy grammar frontend を削除しない。

- 少なくとも 1 release が mvdan authority で稼働している。
- parser rollback を必要とした incident がない。
- parser availability または `candidate_looser` の未解決 finding がない。
- 直前 release と local downgrade 手順が利用可能である。

cleanup 後の rollback は直前 release の install によって行う。存在しない `legacy` mode を同一 release 内で提供しているように見せてはならない。

### 10. Release・dogfood・文書化

- implementation plan と追跡 Issue を作成し、段階ごとの依存関係を固定する。
- CHANGELOG の `Unreleased` を更新する。
- `docs/CONTEXT.md`、`docs/CONCEPT.md`、config schema、packaging / doctor / operator guide を実装状態へ同期する。
- release 前に source-build dogfood を行い、frontend/artifact/config が一致する active cohort を開始する。
- shadow / canary の測定 evidence と promotion 判定を `docs/ops/` に保存する。
- release 後も rollback 条件を満たすまで legacy frontend と直前 release を保持する。

## 依存関係

```text
implementation authorization
  -> compatibility probe
  -> pinned bridge + reproducible artifacts
  -> production frontend + shared semantic lowering
  -> packaging/platform verification
  -> shadow
  -> canary
  -> mvdan authority
  -> one released observation period
  -> legacy cleanup
```

後段の gate を、前段の evidence なしに開始しない。

## 残件サマリー

| 段階 | 現在 | 次へ進む条件 |
| --- | --- | --- |
| 設計 | 完了 | PR #141 の設計を正本として維持 |
| Interface / fail-closed scaffold | 完了 | PR #143 の回帰テストを維持 |
| Compatibility probe | 未着手 | probe exit criteria 全合格 |
| Production Wasm artifact | 未着手 | pinning、再現ビルド、integrity、offline load |
| Shared lowering integration | 一部基盤のみ | differential suite と semantic parity |
| Shadow | 未着手 | candidate-looser / unavailable 0、latency gate 合格 |
| Canary | 未着手 | 150 benign events、3 sessions、unsafe allow 0 |
| Mvdan authority | 未着手 | canary gate と rollback 手順 |
| Legacy cleanup | 未着手 | 1 release 観測、rollback incident なし |
| Release / dogfood | 未着手 | release evidence、active cohort、文書同期 |

## 次の一手

実装を開始する場合は、まず明示的な実装承認を得たうえで compatibility probe だけを独立した最初の tracer bullet とする。probe が合格するまで Go/Wasm の production dependency や runtime artifact を追加しない。
