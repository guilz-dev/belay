# Dogfood 監査ログの問題分析と具体的な対応

- 作成日: 2026-08-22
- 対象リポジトリ: [dogfood 導入先一覧](./ops/dogfood-install-targets.ja.md)（本分析の主ログは `guilz-dev/belay` の `.cursor/belay/audit.ndjson`）
- 対象ログ: `.cursor/belay/audit.ndjson`
- 対象ランタイム: 主に `0.9.0`。ただしログには provenance のない旧イベントと
  `0.8.1` のイベントが混在する
- 本文書の範囲: 原因分析と実装方針。コード変更は含まない

## 1. 結論

現時点では dogfood の集計値を根拠に `mode: "enforce"` へ移行してはならない。
分類精度以前に、監査データの相関キーと時刻が書き込み時に破壊され、Cursor の shell
action が二重記録されているためである。

最優先で直すべき問題は次の 5 点である。

1. `timestamp`、fingerprint、承認相関を保つ field-aware な audit serialization
2. Cursor の `beforeShellExecution` / `preToolUse: Shell` 二重ゲートの解消
3. 再インストールのたびに変わらない content-addressed cohort identity
4. control-plane の「read」と「mutation」を分ける action-aware policy
5. full payload の常時保存をやめ、ローテーション可能な bounded audit storage にする

この修正後に新しい cohort を収集し、そのデータだけで EffectPlan の残差を評価する。
旧ログにある Judge 障害や `tier1_catastrophic` を、現行 classifier の問題として直接修正しては
ならない。現行の shell 判定は `src/core/verdict/verdict.ts` で EffectPlan を同期評価しており、
現在の 12 gate event には Judge fallback が 1 件もない。

## 2. 調査範囲と観測事実

追加探索（2026-08-22 時点）では `/Users/kaz/product` 配下の他リポに有効な監査ログは
scheduling-editor 等に限られ、**本書の定量分析**は `guilz-dev/belay` の
`.cursor/belay/audit.ndjson` のみを対象とした。導入先の正本一覧は
[dogfood 導入先](./ops/dogfood-install-targets.ja.md) を参照。

### 2.1 ログの物理状態

| 指標 | 実測値 |
|---|---:|
| レコード数 | 27,518 |
| ファイルサイズ | 124,564,422 bytes（約 118.8 MiB） |
| gate event | 9,810 |
| would-block | 4,019（40.97%） |
| availability を除いた would-block | 2,855（29.10%） |
| approval recorded | 19 |
| `timestamp` を持つレコード | 27,515 |
| 正しい ISO `timestamp` | **0** |
| `"<timestamp>"` に置換済み | **27,515** |
| fingerprint を持つ gate record | 9,810 |
| 正しい 64 hex fingerprint | **0** |
| `"<high-entropy>"` に置換済み | **9,810** |
| `approvalId` を持つレコード | 163 |
| `"<approval-id>"` に置換済み | 161 |

3 件の CLI event だけは `timestamp` ではなく `ts` を使い、ISO 時刻が残っている。この
schema の二重化も統一対象である。

### 2.2 ログ容量の内訳

| event | 件数 | bytes | 全体比 | 平均 bytes/record |
|---|---:|---:|---:|---:|
| `postToolUse` | 16,827 | 70,553,359 | 56.6% | 4,193 |
| `preToolUse` | 3,487 | 30,032,714 | 24.1% | 8,613 |
| `beforeShellExecution` | 6,257 | 23,199,074 | 18.6% | 3,708 |
| その他 | 947 | 779,275 | 0.6% | - |

`postToolUse` だけで過半数を占める。現在は
[`appendObservedAudit`](../src/adapters/shared/gate-runtime.ts) が host payload 全体を
`canonicalStringify()` して `summary` に格納するため、判定監査とは無関係な Read/Grep/Write
の詳細まで同じファイルへ蓄積される。

### 2.3 runtime cohort

| runtime build | gate event |
|---|---:|
| provenance なし | 8,545 |
| `0.8.1@2026-08-15T08:24:18.939Z` | 1,095 |
| `0.9.0@2026-08-20T07:17:04.722Z` | 158 |
| `0.9.0@2026-08-22T04:44:22.549Z` | 12 |

現行 cohort の 12 件は 6 種類の shell command が各 2 回ずつ記録されたもので、すべて
`unknown_local_effect` である。内容は監査解析用の複数行 Node/Python heredoc であり、任意コード
実行を含むため「無条件に read-only として許可する」対象ではない。

## 3. 根本原因と対応

### P0-1. Field-blind scrub が監査データ契約を破壊する

#### 原因

[`createDefaultGateRuntimeDeps().appendAudit()`](../src/adapters/shared/gate-runtime.ts) は
`timestamp` を生成したあと、record 全体へ `scrubValue()` を適用する。

`scrubValue()` は object の全 string field を再帰処理する。さらに
[`scrubString()`](../src/core/scrub.ts) は設定に関係なく ISO timestamp と UUID を置換し、
`maskHighEntropyStrings: true` の場合は 40 文字以上の fingerprint/hash も置換する。

一方、reader 側は次の値を生の相関キーとして使う。

- [`parseTimestamp()`](../src/core/audit-query.ts): 日付 filter、日次 bucket、approval latency
- [`buildApprovalRoundTrips()`](../src/core/audit-query.ts): `approvalId` と fingerprint
- [`computeRepeatedFingerprintAsks()`](../src/core/audit-analysis.ts): fingerprint ごとの反復摩擦

そのため現在の出力には次の既知の誤りがある。

- `gateEventsByDay` は空になる
- 4,019 ask が 1 個の fingerprint に衝突する
- approval round-trip が別 action 間で誤結合しうる
- `--since` / `--until` は既存 gate record に対して機能しない
- bypass detection の時間窓と fingerprint 比較が成立しない

runtime provenance が残っているのは、scrub 後に `Object.assign()` で再注入しているためである。
同じ方式が一部 metadata にだけ個別実装され、audit schema 全体の方針になっていない。

#### 対応

`scrubValue(record)` を直接 writer にかけるのをやめ、`src/core/audit-io.ts` に
field-aware な `serializeAuditRecordV3()` を置く。

保存契約は次のようにする。

| field | 保存方法 |
|---|---|
| `timestamp` | writer が最後に生成した ISO-8601 をそのまま保存 |
| `fingerprint`, `commandFingerprint` | `/^[a-f0-9]{64}$/` を満たす内部生成値だけ保存 |
| `effectIRHash`, `payloadHash`, `configFingerprint` | field ごとの形式検証後に保存 |
| `approvalId` | 従来どおり mask。生 ID は audit に保存しない |
| `approvalCorrelationId` | `sha256(approvalId)` の短縮値を全 ask/approve/execute event に保存 |
| `summary`, command, payload 内 string | 現行 scrub を適用 |
| runtime/build metadata | 形式検証後に保存 |

`approvalCorrelationId()` は gate runtime 内に既に存在するため、mismatch event 専用ではなく
通常の approval lifecycle にも使う。reader は correlation ID を優先し、旧レコードの
`"<approval-id>"`、`"<high-entropy>"`、`"<timestamp>"` を有効なキーとして扱わない。

`appendCliAuditEvent()` の `ts` は `timestamp` に統一し、gate/CLI/egress の writer を同じ
serializer に集約する。

#### 必須テスト

- 実際に一時 NDJSON へ書き、reader まで通す integration test
- timestamp が ISO で残り `--since` / daily bucket が動く
- 2 つの異なる fingerprint が衝突しない
- secret、Bearer token、raw approval ID は残らない
- ask → approval → approved-once が correlation ID で 1 本に結合する
- malformed/外部入力の hash field は保存せず scrub される
- `maskHighEntropyStrings: true` でも内部生成 fingerprint は維持される

### P0-2. Cursor shell gate が二重登録されている

#### 原因

[`getManagedHookEntries()`](../src/defaults.ts) は Cursor に次の両方を登録する。

1. `beforeShellExecution` → `belay-shell-gate`
2. `preToolUse` matcher `Shell` → `belay-tool-gate preToolUse`

さらに [`runToolGateHook()`](../src/adapters/cursor/runtime-entry.ts) は `toolName === "Shell"` を
`kind: "shell"` として再評価し、[`gateAuditEventName()`](../src/adapters/shared/gate-runtime.ts) は
由来に関係なく `kind: "shell"` を `beforeShellExecution` と記録する。

現行 cohort で各 command が正確に 2 件ずつ記録されることと一致する。全期間でも
「直前と event/kind/verdict/reason/summary/runtime/config が同一」のレコードが 3,898 件ある。
旧ログには真の反復実行も混ざるため全件を重複とは断定できないが、現行 12 件の二重化は再現済みで
ある。

#### 対応

- Cursor では `beforeShellExecution` を shell の唯一の gate にする
- `preToolUse` の `Shell` matcher を新規インストールから削除する
- upgrade 時は Belay 管理 command と matcher が完全一致する旧 entry だけを除去する
- user が追加した `preToolUse: Shell` hook は削除しない
- `doctor` は両方の Belay shell hook が存在する旧構成を warning にする
- adapter ごとの action に `sourceEvent` を持たせ、audit の `event` を kind から再推論しない

host の互換性上どうしても両 hook が必要なら、host の `tool_use_id` 等から
`gateInvocationId` を作り、短時間の重複評価を除外する。ただし第一選択は二重登録の解消である。

#### 必須テスト

- fresh Cursor install に `preToolUse: Shell` がない
- upgrade が旧 Belay entry だけを除去する
- 1 shell action につき classify/audit/pending-approval が各 1 回
- Claude/Codex の hook 構成に回帰がない
- installer の idempotency を維持する

### P0-3. cohort identity が install 時刻に依存する

#### 原因

[`renderRuntimeCore()`](../src/templates.ts) は runtime build stamp を
`${PACKAGE_VERSION}@${new Date().toISOString()}` で生成する。同じソースを再度 `upgrade` しただけでも
別 cohort になる。

さらに [`resolveActiveAuditCohort()`](../src/runtime-provenance.ts) は config object 全体を hash する。
通知先や audit 保存設定など判定に影響しない変更でも readiness cohort がリセットされる。

古い runtime を現在の安全性根拠から除外すること自体は正しい。問題は「同じ実装・同じ判定設定」も
毎回別物として扱うことである。

#### 対応

cohort identity を次の 3 軸へ分ける。

- `runtimeArtifactHash`: adapter runtime bundle の content hash
- `decisionConfigFingerprint`: EffectPlan/policy/gates/trusted-root/boundary に影響する設定だけの hash
- `boundaryProfile`: `l3-l4-only`、contained、L1-full 等の実 posture

package version と `installedAt` は表示用 metadata として残すが、同一性キーにはしない。
既存の full `configFingerprint` もフォレンジック用途には残せる。

`mode: audit|enforce` は判定結果の `wouldBlock` を変えないため decision fingerprint から分離し、
event field として保存する。ただし boundary や grant materialization を変える設定は必ず identity に
含める。

#### 必須テスト

- 同じ bundle を 2 回 upgrade しても cohort が継続する
- classifier/policy/boundary 設定変更では cohort が変わる
- notification、log path、表示設定の変更では decision cohort が変わらない
- adapter または runtime bundle の変更では cohort が変わる

### P0-4. control-plane read が mutation と同じ扱いになる

#### 原因

[`effectPathIsHighStakes()`](../src/core/capability/policy-engine.ts) は sensitive path、
protected artifact root、Git metadata を 1 つの boolean に畳む。`fs.read` と `fs.write` の双方が
この関数を呼ぶため、`.cursor/belay.config.json`、hook、audit log に対する `ls` / `stat` /
`head` / `cat` も `high_stakes_path` で ask になる。

これは [`tier0-retention-ledger.md`](./adr/tier0-retention-ledger.md) の
「control-plane read は MUST-ALLOW、mutation は MUST-ASK」と矛盾する。

#### 対応

path の性質と action を分離する。

- `isSecretOrCredentialPath(path)`: `secret.read` と write の双方を ask
- `isControlPlanePath(path)`: read は allow、write/delete は `control_plane.write` で ask
- `isGitMetadataPath(path)`: inspection/read は allow、destructive mutation は ask
- `isUserSensitiveConfiguredPath(path)`: 現行の明示ポリシーに従う

`fs.read` で protected root に入っただけでは ask にしない。secret/credential read は
`secret.read` requirement を必ず併記し、そこで ask にする。`fs.write` と
`control_plane.write` の既存 fail-closed は維持する。

#### MUST-ALLOW / MUST-ASK

MUST-ALLOW:

- `cat .cursor/belay.config.json`
- `stat .cursor/hooks/belay-runner`
- `head .cursor/belay/audit.ndjson`
- `git status`、read-only Git metadata inspection

MUST-ASK:

- `echo x >> .cursor/belay.config.json`
- `rm .cursor/hooks/belay-runner`
- `Write .cursor/belay/runtime/core.mjs`
- credential/secret の read または mutation
- destructive Git metadata mutation

MUST-ALLOW と MUST-ASK は同じテストファイルで対にし、read 緩和による偽陰性を防ぐ。

### P0-5. audit storage が unbounded で payload を過剰保存する

#### 原因

- gate writer は `writeFile(..., { flag: "a" })` だけで rotation/retention がない
- `metrics`、`report` は audit 全体を `readFile()` する
- `appendObservedAudit()` は post-tool payload 全体を string 化する
- `replayContext.payload` は scrub 済みでも tool input 全体を保存する
- scrub は既知の secret pattern を隠すが、ソースコード、文書本文、ユーザー入力等の機密性を
  保証しない

#### 対応

監査ログを「判定証拠」と「host 観測 telemetry」に分ける。

1. decision audit は gate/approval/recovery/boundary event を保存する
2. post-tool telemetry は既定で compact projection のみ保存する
3. full payload 診断は明示 opt-in、期限付き、別ファイルにする
4. size-based rotation と retention を追加する
5. reader は複数世代を streaming で読む

compact post-tool event に保存してよいのは、例えば次の metadata である。

- event、timestamp、tool name、success/failure、duration
- cwd の repo-relative 表現
- input/output の byte length と安全な correlation hash
- host が発行した event ID（形式検証済み）

Write の本文、Read の本文、prompt、tool output 全文は通常 audit に保存しない。

`actionSnapshot` は v2 の discriminated schema にし、classifier が必要とする最小入力だけ残す。

- shell: normalized command と cwd
- file mutation tool: tool name、path、operation。本文は保存しない
- patch: target path と add/update/delete の列。patch 本文は保存しない
- subagent: type と scrub 済み要約または hash

`replayContext.payload` の full object は廃止する。`simulate` は安全ゲートではないため、payload
全文の恒久保存よりデータ最小化を優先する。

初期既定値の例は `maxBytes: 32 MiB`、`maxFiles: 5` とし、実測後に調整する。複数 hook process の
同時 append/rotate があるため、atomic rename と repo-local lock を使い、rotation 中も 1 行単位の
NDJSON 完全性を保つ。

## 4. 現行 classifier について再現できたこと

旧ログ全体の reason 件数は、現行コードの品質指標としてそのまま使えない。現行 `dist` へ
`belay explain` を実行した結果は次のとおりである。

| command | 現行結果 | 判断 |
|---|---|---|
| `pnpm lint` | allow / `allow_flagged` | package script を `biome` まで解決済み |
| `pnpm typecheck` | allow / `allow_flagged` | `tsc --noEmit` を inspect と認識済み |
| `git status --porcelain` | allow | read-only Git grammar |
| `ruby -Itest test/*_test.rb` | allow / `allow_flagged` | minitest test runner grammar |
| `bundle exec rubocop <path>` | allow | linter inspect grammar |
| `make test-fast ARGS="spec/…"` | allow / `allow_flagged` | Make 変数展開 + docker-compose run 再帰 |
| `gh pr checks 73` | allow | payload-free network read |
| `make verify-parallel` | ask / `unknown_local_effect` | 現行でも再現する |
| Node/Python heredoc | ask / `unknown_local_effect` | 任意コードなので ask 自体は妥当 |

したがって「`pnpm lint` や `git status` が現在も catastrophic」という修正課題は立てない。
それらは主に provenance なし/旧 runtime/Judge fallback の履歴である。

### 4.1 `make verify-parallel` の実原因

Makefile の recipe は `@set -e`、subshell、background process、`$$!`、`wait`、`exit` を使う。
[`resolveMakeRecipe()`](../src/core/verdict/launcher-resolve.ts) は recipe text を取得できる。
Make の先頭 `@` / `-` / `+` は [`normalizeMakeRecipeLine()`](../src/core/verdict/makefile-expand.ts) で除去する。
単独の `set -e`、`wait`、`exit` は shell control builtin として lower する。
subshell、background process、`wait $!` など PID 依存が残る場合は indeterminate を維持する。

対応は executable 名の allowlist ではなく、次の順に行う。

1. Make recipe prefix (`@`, `-`, `+`) と行継続を正規化する
2. `set`、`wait`、`exit`、単純 assignment を shell builtin として lower する
3. subshell/background/PID 依存が残る場合は indeterminate を維持する
4. unknown local execution は ADR-006 の contained execution で扱う

複雑な並行 recipe を無理に read-only と証明してはならない。contained execution を使わない
構成では exact approval が正しい fallback である。

### 4.2 heredoc と command substitution

現行 heredoc 処理には、`<<` を通常の input redirect と誤認して repo 内の `"<"` path を
`fs.read` として生成するケースがある。quoted delimiter と body boundary を tokenizer で認識し、
body を top-level shell segment として再解釈しないよう修正する。

ただし意味は利用先で分ける。

- `cat <<'EOF'` の literal stdin: shell effect は増えない
- `python3 <<'PY'` / `node <<'JS'`: body は任意コードなので indeterminate
- unquoted heredoc: expansion/substitution を解析し、不明なら indeterminate

これにより safe commit/PR wrapper の message 生成ノイズは減らせるが、wrapper executable 自体を
名前だけで許可してはならない。ADR-004/ADR-005 に従い、内容を再帰解析できない wrapper は
contained execution または exact approval へ送る。

## 5. Judge/availability の扱い

全期間では availability-caused ask が 1,164 件ある。しかし現行 shell authority は
[`verdict()`](../src/core/verdict/verdict.ts) の EffectPlan + PolicyEngine で決定論的に完結し、
`docs/CONTEXT.md` の invariant どおり sync Judge を gate authority にしていない。

よって次を行う。

- 旧 `tier1_catastrophic + ollama_unavailable` を現行 EffectPlan の教師データにしない
- metrics は availability を runtime/decision cohort ごとに表示する
- Judge health は shadow telemetry として別表示する
- Judge unavailable を destructive effect と表現する互換コードは段階的に削除するが、P0 の
  authorization 緩和とは結びつけない

現行 cohort の availability ask は 0 件である。まず audit schema を直して新規データで再確認する。

## 6. readiness 判定の見直し

[`MIN_GATE_EVENTS_FOR_ENFORCE`](../src/core/audit-metrics.ts) は 20 で、zero would-block なら
enforce ready になりうる。しかし 20 件で失敗 0 件でも、rule-of-three による 95% 上限は約 15%
であり、silent-pass 98% という目標の証拠には弱い。

また raw would-block には正しい must-ask も含まれる。安全な外部変更を正しく止めた件まで FP と
数えるべきではない。

readiness は次の条件へ変更する。

1. schema v3 かつ重複のない active decision cohort のみ
2. availability ask が 0
3. reviewed benign traffic の `benignBlockRate` が 2% 未満
4. MUST-ASK corpus の false negative が 0
5. 少なくとも約 150 件の reviewed benign sample、かつ複数 session を含む
6. boundary profile ごとに別判定

承認された action は「人間がリスクを引き受けた」証拠であり、単独では benign label にしない。

## 7. 実装順

### Phase A — 計測を正す（P0）

1. audit serializer v3 と correlation field
2. Cursor shell 二重 gate の除去と upgrade migration
3. content-addressed runtime/decision cohort
4. doctor に legacy placeholder/duplicate hook warning
5. current log を削除せず legacy archive として切り離す

Phase A 完了までは all-time would-block rate、repeat fingerprint、approval latency、daily trend を
リリース判断に使わない。

### Phase B — 現行の規範違反を直す（P0/P1）

1. control-plane read MUST-ALLOW / mutation MUST-ASK
2. heredoc boundary の正規化
3. Make recipe prefix と安全な builtin の lowering
4. MUST-ALLOW/MUST-ASK の対テストと holdout corpus

### Phase C — 保存と運用を bounded にする（P1）

1. compact post-tool telemetry
2. actionSnapshot v2 と full replay payload 廃止
3. rotation/retention/streaming reader
4. disk usage と malformed line の doctor/metrics 表示

### Phase D — clean cohort で再 dogfood（P1）

1. `mode: audit` + `unknownLocalEffect: deny` を維持
2. 通常開発を複数 session 実行
3. benign/must-ask/unknown をレビューでラベル付け
4. reason 別の残差を EffectPlan seam ごとに修正
5. readiness 条件を満たした後にだけ enforce trial

## 8. 完了条件

- ISO timestamp と一意 fingerprint が disk 上の integration test で保持される
- secret と raw approval ID は disk に残らない
- 1 Cursor shell action = 1 gate event
- 同じ runtime/config の再 upgrade で cohort が維持される
- control-plane read は allow、mutation は ask
- `gateEventsByDay`、repeat friction、approval round-trip が実データで成立する
- 通常設定で audit file が retention 上限を超えて増え続けない
- clean cohort に旧/provenance 不明 event が混ざらない
- reviewed benign sample の block rate と MUST-ASK FN=0 を同時に満たす
- enforce を有効化する場合、`l3-l4-only` と L1/contained の保証範囲を混同しない

## 9. 変更候補ファイル

| 目的 | 主な変更候補 |
|---|---|
| audit serialization | `src/core/audit-io.ts`, `src/adapters/shared/gate-runtime.ts`, `src/egress-daemon.ts` |
| audit schema/readers | `src/core/audit-types.ts`, `src/core/audit-query.ts`, `src/core/audit-metrics.ts` |
| Cursor hook dedupe | `src/defaults.ts`, `src/adapters/cursor/hooks.ts`, installer/doctor tests |
| cohort identity | `src/templates.ts`, `src/runtime-provenance.ts` |
| action-aware path policy | `src/core/capability/policy-engine.ts`, EffectPlan policy tests |
| heredoc/Make lowering | `src/core/shell-tokenizer.ts`, `src/core/effect-ir/shell-lower.ts`, `src/core/verdict/launcher-resolve.ts` |
| compact snapshot | `src/core/audit-replay-context.ts`, `src/core/reclassify.ts` |
| bounded storage | audit sink、metrics/report streaming reader、config schema、doctor |

## 10. 非対応とする短絡策

- `pnpm`、`make`、safe wrapper 名を standing allow/command allowlist に入れる
- `maskHighEntropyStrings` を全体で無効にして raw payload を残す
- 旧ログの隣接レコードを推測で一括削除する
- Judge unavailable 時に allow へ倒す
- `allow_flagged` を would-block と同一視する
- 20 件程度の unreviewed event だけで enforce ready とする
- arbitrary Node/Python heredoc を read-only と決め打ちする

これらは観測不良を隠すか、ADR-004/ADR-005 の EffectPlan 単一 authority を破るため採用しない。

## 11. 実装状況（2026-08-22 時点）

本文書は原因分析と方針。以下は `fix/dogfood-audit-remediation-phase-a` ブランチでの実装追記。

| 項目 | Phase | 状態 | 備考 |
|---|---|---|---|
| audit serializer v3 + correlation field | A | **完了** | `src/core/audit-serialize.ts`、reader プレースホルダー無効化 |
| CLI `ts` → `timestamp` 統一 | A | **完了** | gate / CLI / egress 共通 serializer |
| Cursor shell 二重 gate 除去 | A | **完了** | `defaults.ts`、`mergeCursorHooksFile()`、doctor warning |
| `sourceEvent` による audit event | A | **完了** | kind 再推論を廃止 |
| content-addressed cohort | A | **完了** | `runtimeArtifactHash`、`decisionConfigFingerprint`、`boundaryProfile` |
| legacy audit archive | A | **完了** | upgrade 時 placeholder 検出で rename |
| control-plane read MUST-ALLOW | B | **完了** | `policy-engine.ts` + `tier0-retention-ledger.md` |
| control-plane write `effect.control_plane_write` | B | **完了** | EffectPlan policy test |
| heredoc / Make lowering | B | **未着手** | §4.1–4.2 |
| shell MUST-ALLOW/MUST-ASK corpus | B | **部分** | EffectPlan path 単体テストのみ |
| bounded storage / rotation | C | **未着手** | §P0-5 |
| compact post-tool telemetry | C | **未着手** | |
| readiness 改定（150 sample、`benignBlockRate`） | D | **未着手** | §6、`MIN_GATE_EVENTS_FOR_ENFORCE` は現行 20 のまま |
| egress audit cohort フィールド | A | **完了** | `resolveActiveAuditCohort` を onAudit に注入 |
| cohort 部分 v3 legacy 誤マッチ | A | **完了** | `matchesAuditCohort` fail-closed |
| invalid runtimeArtifactHash fallback | A | **完了** | 64-hex のみ採用、stamp suffix 廃止 |

ドキュメント反映: `CHANGELOG.md` Unreleased、`docs/config-schema.md`（audit v3）、
`docs/CONTEXT.md`、`docs/adr/tier0-retention-ledger.md`、
`docs/superpowers/specs/2026-08-14-runtime-cohort-dogfood-readiness-design.md`、
`docs/README.ja.md`。
