# 再帰的品質改善 — false positive（過剰ブロック）を継続的に減らす設計

Status: **検討 / 提案（directional）**
関連: [`CONCEPT.md`](./CONCEPT.md) §3,§10,§12 · [`ROADMAP.md`](./ROADMAP.md)（Dial 1 / Horizon 0–1）· [`adr/ADR-002-concept-conformance.md`](./adr/ADR-002-concept-conformance.md) M2 · [`recursive-quality-loop-issues.md`](./recursive-quality-loop-issues.md)

---

## 0. このドキュメントが答える問い

> 「再帰的に品質を上げる施策を打ちたい。具体的には、本来は止めなくてもいいものが止まる（＝過剰ブロック）のを避けたい。」

Belay の語彙に翻訳すると、これは **false positive（benign / reversible なアクションをブロックしてしまう＝不要な承認要求）を、再帰的に減らし続けるフィードバックループを閉じる** という課題です。

ROADMAP はこれを既に最優先テーマとして宣言しています:

> **Invariant:** never let an irreversible × catastrophic action through silently.（＝FN は絶対に出さない）
> **Target:** drive every *other* interruption toward zero.（＝FP を限りなくゼロへ）

つまり目指すのは **「FN=0 を一切犠牲にせずに FP を単調に減らし続ける」** こと。本書はそのための（a）現状の棚卸し、（b）ループが閉じていない理由、（c）打つべき具体策、を順に示す。

---

## 1. 用語の確定（ここがブレると全部ブレる）

「止める＝deny（positive）」とみなす検出器の枠組みで揃える:

| 用語 | 定義 | コスト | ユーザーの今回の関心 |
|---|---|---|---|
| **False Positive (FP)** | 本来通すべき（reversible / read）ものを **止めた** | 摩擦。積もると gate を無効化 → 保護がゼロに | **★これ**（「本来止めなくていいものが止まる」） |
| **False Negative (FN)** | 止めるべき（irreversible × catastrophic）ものを **通した** | 見逃し。信頼して踏み込むと **無限大** | 絶対に増やしてはいけない不可侵線 |

ADR-002 M2 は **「benign を1件でも止めたら concept violation（FN と同格の失敗）」** と位置づけている。FP は UX の papercut ではなく **設計違反**。

---

## 2. 現状の棚卸し — フライホイールの部品はほぼ揃っている

再帰ループに必要な部品は、実はすでに大半が実装済み。問題は「繋がって回っていない」こと。

| ループ段階 | 既存資産 | 場所 |
|---|---|---|
| **Capture**（全判定を記録） | `audit.ndjson` トレース（verdict / reason / wouldBlock / fingerprint） | 各 adapter の `belay/audit.ndjson` |
| **Collect 安全に**（リスクなく実分布収集） | dogfood / audit モード（would-block を記録するが実行は通す） | [`operational-insights.ts`](../src/operational-insights.ts) |
| **Detect**（FP 候補を見つける） | `detectNoisyRules`（deny→approve が 50%↑ の reason を抽出）、bypass 検出 | [`audit-analysis.ts:99`](../src/core/audit-analysis.ts) |
| **Surface**（人に見せる） | `belay metrics`（noisy rule candidates / top would-block summaries / dogfood readiness） | [`commands/metrics.ts`](../src/commands/metrics.ts) |
| **Replay**（設定変更の影響を実トレースで差分抽出＝トリアージ。※再分類は lossy、施策6 参照） | `belay simulate`（候補 config で再分類し `allow→deny` / `deny→allow` を集計） | [`commands/simulate.ts`](../src/commands/simulate.ts) ＋ [`reclassify.ts`](../src/core/reclassify.ts) |
| **Gate**（CI で回帰を止める） | `pnpm corpus`（コーパス評価をベースラインと比較） | [`scripts/corpus.mjs`](../scripts/corpus.mjs) ＋ [`corpus/`](../corpus) |
| **Tune**（直す手段） | `overrides.allow`、MUST-ALLOW カタログ、Tier1 プロンプト、presets | config / [`CONCEPT.md`](./CONCEPT.md) §3 |

**結論:** 新規に作るより、**この部品群を1本のループに結線する**ほうが投資対効果が高い。

---

## 3. ギャップ — なぜ「再帰的に」品質が上がらないのか

実コードを読んで判明した、ループが閉じていない5つの理由。**G1 が最も致命的**。

### G1.（基盤）CI ゲートが「真の FP」を測っていない ★

[`evaluate.ts:90-94`](../src/corpus/evaluate.ts) の `falsePositiveRate` の中身:

```ts
const falsePositives = mismatches.filter(
  (e) => e.expected === 'deny_pending_approval' && e.actual !== 'deny_pending_approval',
).length
// falsePositiveRate: falsePositives / denyCases
```

これは **「deny すべきものを deny しなかった」率**、つまり Belay の語彙では **見逃し（FN）** を測る指標。名前が逆。そして:

- ユーザーが減らしたい **真の FP（expected=allow なのに actual=deny）を測る指標が存在しない**。
- [`baseline.json`](../corpus/baseline.json) は `falsePositiveRate: 0.05` を許容 → **見逃しを 5% まで容認**しており、ROADMAP の「FN=0 ハードゲート」とも矛盾。
- [`scripts/corpus.mjs`](../scripts/corpus.mjs) のチェックは `accuracy` と `falsePositiveRate` の悪化のみ。**benign-block（真の FP）を落とす CI ゲートが無い**。

→ ROADMAP「MUST-ALLOW corpus as an equal hard gate（benign を1件 ask したら CI fail）」が**宣言だけで未実装**。測れないものは再帰的に改善できない。

### G2. コーパスが実トレースから育っていない

[`corpus/shell-commands.json`](../corpus/shell-commands.json) は **手書き27件**。ROADMAP は "grown from real traces" と言うが、**audit → corpus の抽出パイプラインが無い**。現実に起きた過剰ブロックがテストとして固定化されず、同じ FP が何度でも再発しうる。

### G3. 同じ過剰ブロックが毎回再発する（approval cache 未実装）

`describe` / `list` / `get` 系の最初の ask が、毎回 ask になる。CONCEPT build order #5・ROADMAP Horizon 1 の **approval cache（first ask → register → pass through）が未実装**。最も体感が悪い FP の温床。

### G4. judge 不在・タイムアウト・cwd 欠落が「構造的 FP」を生む

fallback = ask（[`CONCEPT.md`](./CONCEPT.md) §3, H2/H3）。これは「危険だから止める」ではなく **「分からないから止める」= ユーザー視点では純ノイズ**。判定の質ではなく **可用性** の問題で FP が出ている。

### G5. ループを回す計器（KPI トレンド）が無い

`belay metrics` は単発スナップショット。**silent-pass rate / benignBlockRate の時系列**を継続追跡する仕組みが無く、「再帰的に上がっているか」を観測できない。

---

## 4. 提案 — 再帰品質フライホイール

```
        ┌─────────────────────────────────────────────────────────┐
        │                                                         │
        ▼                                                         │
  [Capture]  全判定を audit.ndjson に記録（既存）                  │
        │                                                         │
        ├────────────────────────┐                               │
        ▼                        ▼                               │
  [Detect FP 候補]         [Detect 可用性事故]                    │
   benign らしい ask:       judge 不在 / timeout / cwd 欠落 由来   │
   ・deny→approve           の ask → must-allow ではなく          │
   ・後から override.allow   別キュー → 施策4 へ（corpus に流さない）│
   ・read/describe シグナル  │
        │                                                        │
        ▼                                                        │
  [Harvest]  証拠を揃えて人がラベル確定 → corpus ★施策2           │
        │                                                        │
        ▼                                                        │
  [Gate]     FP=0 かつ FN=0 をハードゲート化 ★施策1             │  ← 二度と下がらない
        │     （provably-benign を止めたら fail / must-ask を通したら fail）│ ラチェット
        ▼                                                        │
  [Tune]     approval cache / judge 可用性 / Tier1 / substrate   │
        │     ★施策3,4,5                                         │
        ▼                                                        │
  [Triage]   simulate で影響範囲を洗い出し、各遷移を corpus と    │
        │     突き合わせて確認（安全性の証明は [Gate] が担う）★施策6│
        ▼                                                        │
        └──────────── [Measure] FP/silent-pass SLO ★施策7 ──────┘
```

各ターンで「現実の FP が恒久テスト化 → 修正 → CI で固定」され、品質が **単調に上がり二度と戻らない**。これが「再帰的」の意味。
**重要:** 安全性の証明は一貫して [Gate]（ラベル付き corpus, 施策1）が担う。simulate（[Triage], 施策6）はあくまで「どの判定が変わるか」を洗い出すトリアージであって、それ単体では FN/FP を保証しない（後述）。

### 4.1 運用原則（ループを逆噴射させないための2つの掟）

**掟1 — 品質ループと可用性ループを混ぜない（可用性 ≠ 判定品質）。**
上図は実は **2本の独立したループ**であり、最後まで別レーンで扱う:

- **品質ループ:** `[Detect FP 候補] → [Harvest] → [Gate] → [Tune]`。classifier の **判定そのもの**を直す。corpus / ground truth を育てる。
- **可用性ループ:** `[Detect 可用性事故] → 施策4`。judge timeout / cwd 欠落 / cold start といった **インフラ起因**の ask を直す。**これは classifier 品質の問題ではない。**

両者を同じ backlog で扱うと、(a) 対策がぼける（プロンプト改善とインフラ改善が混線）し、(b) 可用性事故が「判定ミス」として corpus を汚し、危険な deny を緩める方向にバイアスする。**可用性事故は corpus にも品質 KPI にも流さない**（別集計＝施策7 の `fallback 起因 ask 件数`）。

**掟2 — 修正順は FP の大きさではなく再発性で決める。**
単発で痛い1件の FP より、**毎日出る `describe` / `list` / `get` 系**を先に潰す。体感改善が大きく、silent-pass rate に直結するため。harvest backlog は **same-fingerprint repeat ask 件数（施策7）で並べ替える**のを既定とし、「痛さ」ではなく「頻度 × 確実に benign と言えるか」で優先度を付ける。

---

## 5. 施策（優先順）

各施策に **「何を / なぜ FP が減るか / 既存資産との接続 / FN を守るガード」** を付す。

### 施策1（基盤・最優先）真の FP 指標と MUST-ALLOW ハードゲート

- **何を:**
  - [`evaluate.ts`](../src/corpus/evaluate.ts) に `benignBlockRate`（expected ∈ {allow, allow_flagged} かつ actual = deny）を追加。現 `falsePositiveRate` は実態に合わせ `missRate`（=FN率）にリネームし命名混乱を解消。
  - コーパスを **`must-ask`（irreversible×catastrophic）** と benign 側2層に分割:
    - **`provably-benign`** = read / describe / payload-less GET / local-recoverable など、概念上または構造上 benign と言い切れるケース。
    - **`accepted-benign`** = 運用上は benign と見てよいが、証拠が人間判断に依るケース。
  - [`scripts/corpus.mjs`](../scripts/corpus.mjs) を改修:
    - **`provably-benign` を1件でも block したら CI fail（hard FP=0）**
    - **`must-ask` を1件でも通したら CI fail（FN=0）**
    - `accepted-benign` は最初は **review-required / soft gate** に置き、ground truth が固まったものから `provably-benign` に昇格させる。`baseline.json` の `0.05` 許容は撤廃。
- **なぜ FP が減るか:** 測れないものは下げられない。これは下げ幅を作るのではなく、**「下がった品質が二度と戻らない」ラチェットの土台**。他の全施策の効果がここで固定される。
- **接続:** 既存の corpus 評価ハーネスをそのまま拡張。
- **FN ガード:** must-ask=0 ゲートを同時に強化するので、FP を下げる過程で FN が増えれば即 CI fail。benign 側を二層化することで、「人が今回は通しただけ」のケースが hard gate を汚染しない。

### 施策2 audit → corpus ハーベスト（`belay corpus harvest`）

- **何を:** 実トレースから「後悔した ask（regretted ask）」を抽出し corpus 候補に。ただし **`approve` は ground truth ではなく候補信号の1つ**として扱い、**候補の出所によって意味づけ（＝流す先のキュー）を厳格に分ける**:
  - **benign 候補キュー**:
    - **deny→approve**（[`detectNoisyRules`](../src/core/audit-analysis.ts) / `ApprovalRoundTrip`）= 「今回は人間が不確実性を引き受けた」信号。**単体では must-allow 証拠にならない**。
    - **後から `overrides.allow` に足されたコマンド** = 人間が事後に「これは通すべきだった」と判断した信号。これも単体では hard ground truth にしない。
    - **read / describe / list / get / payload-less GET** などの静的特徴。
    - **同一 reason / fingerprint での高頻度承認**、**実行後の副作用ゼロ確認**、**既存 MUST-ALLOW カタログとの一致** などの補助証拠。
  - **可用性事故キュー**（＝corpus には流さない。施策4 に回す）:
    - **fallback / timeout / cwd 欠落 由来の ask** は「**その時点で判定できなかった**」だけで、基底の操作が benign だった証拠には**ならない**。これを must-allow 候補に寄せると、危険な deny を「可用性ノイズ」として誤って緩める方向にバイアスする。よって corpus には載せず、可用性指標（施策4）として別集計する。
  - benign 候補キューの各件は、**証拠強度で振り分ける**:
    - 構造的に benign と言い切れるもの → `provably-benign`
    - 人間判断が混ざるが benign 寄りのもの → `accepted-benign`
    - まだ不明 → corpus に入れず review backlog
  - corpus への昇格は **人間が must-allow / must-ask / accepted-benign をラベル確定**してから（自動昇格しない）。
- **なぜ FP が減るか:** 現実に起きた FP 候補が **証拠付きで恒久テスト化**され、施策1のゲートで再発がブロックされる。**これがフライホイールを閉じる中心**（G2 を解消）。
- **接続:** `detectNoisyRules` / `ApprovalRoundTrip` / `parseAuditNdjson` を再利用。
- **FN ガード:** harvest は **候補提示まで**。`approve` は単なる候補信号に留め、昇格には複数証拠か構造的説明を要求する。可用性事故は corpus を一切汚さない。

### 施策3 approval cache / standing-allow（再発 FP の即時消去）

- **何を:** standing-allow は **「一度 approve されたもの」ではなく「既に benign と確定したもの」** にだけ付与する。対象は:
  - `provably-benign` corpus に載った fingerprint / パターン
  - MUST-ALLOW カタログに一致する read-class
  - 一時的な可用性事故で ask になったが、判定自体は benign と再確認できたもの

  これらに限って standing-allow に登録し、次回から沈黙。
- **なぜ FP が減るか:** describe 系の「毎回 ask」を消す。**最大の体感改善**（G3 を解消、CONCEPT #5 / Horizon 1）。
- **接続:** 既存の承認ループ（fingerprint / TTL / revoke）を拡張。
- **FN ガード:** **approve 済みであること自体は十分条件にしない。** 対象は benign と説明可能な read/reversible クラスに限定。TTL + revoke 必須。**Tier0 の must-ask 経路（git remote / control-plane / high-stakes paths）は対象外**。standing-allow も監査ログに残す。

### 施策4 judge 可用性ハードニング（構造的 FP の除去）

- **何を:** prewarm + `keep_alive`、judge session transport（commit #23 で導入済み）、`belay judge doctor` の健全性チェック、degraded-mode ポリシーの明示。cwd 欠落（H2）対策（context 収集の信頼性向上）も同列。
- **なぜ FP が減るか:** 「judge が落ちている＝ask」「cold start＝ask」「cwd 不明＝ask」は **判定の質ではなくインフラ起因の純 FP**。可用性向上が直接 FP を削る（G4 を解消）。
- **接続:** 既存の judge 起動・session 機構、`judge-doctor`。
- **FN ガード:** judge 不在時の fallback は **依然 ask（安全側）を維持**。可用性を上げて「不在そのもの」を起こさない方向に投資するだけで、安全側のデフォルトは変えない。

### 施策5 Tier1 キャリブレーション回帰セット

- **何を:** harvest した `provably-benign` / `accepted-benign`（特に read / describe / IDE plan files）を **Tier1 プロンプトの回帰テスト**に。プロンプト/モデル変更時に read クラス FP が増えないことを保証。MUST-ALLOW カタログ（CONCEPT §3）の拡充をデータ駆動化。
- **なぜ FP が減るか:** 残差 FP（H4: 2B モデルが read を誤って not-recoverable と判定）を削り、かつプロンプト改善時のデグレを防ぐ。
- **接続:** corpus（施策1）＋ Tier1 judge。
- **FN ガード:** 同じ回帰セットに must-ask も含め、read 寄りに振った際に catastrophe を取りこぼさないことを同時検証。

### 施策6 replay によるトリアージ（`belay simulate`）— ただし安全性の証明には使わない

> **このセクションは安全性ゲートではない。** simulate は「設定変更でどの判定が変わるか」を実トレース上で**洗い出す**ためのトリアージであり、それ単体で FN/FP を保証しない。理由を先に明示する。

- **集計値の意味（実装の事実）:** [`simulate.ts:42-54`](../src/commands/simulate.ts) は再分類の差分を数えるだけ:
  - `allowToDeny` = 以前 allow/allow_flagged → 今 deny になった件数。これは **新たに増えた ask = 新規 FP の候補**（だが benign とは限らない＝中身を見る必要あり）。
  - `denyToAllow` = 以前 deny → 今 allow になった件数。**ここには「狙った FP 修正」と「新規 FN（本来止めるべきものが通るようになった）」が混在する。** 件数だけでは両者を区別できない。
- **誤った使い方（やってはいけない）:** 「`denyToAllow > 0` かつ `allowToDeny == 0` を PR ゲートに」は **安全性の根拠として逆**。catastrophe が新たに通る事象は `denyToAllow` 側に現れるので、`allowToDeny == 0` では何も防げない。`denyToAllow` を一律「FP が消えた」とみなすと、新規 FN を成功と取り違える。
- **正しい使い方:**
  1. simulate で **変化した遷移を列挙**する（件数ではなく個々の遷移）。
  2. 各遷移を **ラベル付き corpus（施策1）と突き合わせ**、ground truth に照らして判定する:
     - `deny→allow` の遷移が **must-ask ケースに該当 → 新規 FN = 即ブロック**。
     - `deny→allow` が **must-allow ケースに該当 → 狙った FP 修正（OK）**。
     - corpus に未登録の遷移 → **人間レビュー必須**（昇格は施策2 経由）。
  3. **安全性の最終保証は施策1（FP=0 / FN=0 のラベル付き corpus ゲート）が担う。** simulate はそこへ候補を供給するだけ。
- **前提（先に直すべき）— replay fidelity:** 現状の再分類は **lossy** で、このままでは差分の信頼度が低い。[`reclassify.ts:40-81`](../src/core/reclassify.ts) は:
  - shell/tool/subagent を `summary` から再構成（元コマンドの完全な復元ではない）、
  - `cwd` を常に `repoRoot` に固定（元の cwd を喪失 → パス起因の判定が変わる）、
  - tool イベントを `toolName: 'Shell'` に潰す（元の tool identity を喪失）。

  → simulate を回帰トリアージとして意味あるものにする**前に**、audit スキーマを拡張して **元の `cwd` / 完全な payload / tool 名** を保持し、`reclassify` がそれらを使って忠実に再構成できるようにする。fidelity を上げるまでは simulate は **方向性の参考（directional）** に留め、ゲートには使わない。
  - **最も確実な手（推奨）:** 判定時に classifier が実際に見た **正規化済み action（`normalizeGatedAction` の出力）を audit にそのまま残す**。こうすれば replay は `summary` からの再構成を**一切スキップ**でき、lossy 経路を構造的に消せる。cwd/payload/tool 名を個別に足すより、判定入力スナップショットを1つ残すほうが堅い。
- **これは施策6 の前提ではなく独立した先行タスク:** 「audit schema を simulate より先に強化する」こと自体が単独で価値を持つ（フォレンジック・KPI・再現性すべてに効く）。実行順（§7）でも simulate と切り離した先行ステップとして扱う。
- **接続:** `simulate` / `reclassify` は実装済み。まず audit スキーマ拡張（正規化 action スナップショット）→ fidelity 向上 → その上で施策1 のラベルと突き合わせ。
- **FN ガード:** FN を防ぐのは simulate の件数条件ではなく、**施策1 の must-ask=0 ゲート**。simulate はそこに差分を渡す入力に徹する。

### 施策7 FP SLO とトレンド計測（ループの計器）

- **何を:** `silentPassRate`（目標 ~98%）と `benignBlockRate` を日次バケットで継続追跡（`bucketGateEventsByDay` は既存）。加えて、**rate だけでなく分母付きの操作指標**を持つ:
  - reason 別 deny 件数
  - reason 別 approve 率
  - fallback / timeout / cwd 欠落起因 ask 件数
  - same-fingerprint repeat ask 件数

  低下＝fence 化の早期シグナルとしてアラート。
- **なぜ FP が減るか:** 直接は減らないが、**「再帰的に上がっているか」を観測する唯一のメーター**。G5 を解消。
- **接続:** `audit-analysis.ts` の bucketing を拡張。
- **FN ガード:** 同じダッシュボードに「regretted miss（FN 疑い）」も並置し、FP を追う過程で FN を見落とさない。

---

## 6. 不可侵のガードレール（全 FP 削減施策に共通）

1. **全ての FP 削減は FN=0 ゲートの下で行う。** その FN=0 を保証するのは **施策1 のラベル付き corpus（must-ask=0）**であって、simulate の件数（施策6）ではない。simulate は影響範囲を洗い出すトリアージで、それ自体は安全性を証明しない。FP を1つ消す変更が catastrophe を1つ通すなら、それは退行であり、施策1 のゲートが落とす。
2. **緩めてよいのは reversible / read クラスのみ。** Tier0 の must-ask（git remote / control-plane mutation / high-stakes paths）は決して緩めない（[`CONCEPT.md`](./CONCEPT.md) §3）。
3. **standing-allow / override は TTL + revoke + 監査必須。** さらに、`approve 済み` を standing-allow の十分条件にしない。永続的な穴を作らない。
4. **「危険そうだが reversible」を止めるのは FP**（ADR-002 §6）。逆に**「分からないから一律 allow」は FN**。両者を分ける本筋は、**L2 substrate（git-worktree / CoW snapshot）で reversible を"証明"する**こと（Horizon 1）。証明できれば、より多くを安全に allow でき、FP の上限自体が下がる。

---

## 7. 実行順（CONCEPT §12 の精神 — 各ステップ単独で出荷可能）

1. **施策1**（真の FP 指標 + MUST-ALLOW/MUST-ASK ハードゲート） — 土台。これ無しに他を測れない。
2. **audit スキーマ拡張（先行・独立）** — 判定時の正規化済み action（＋cwd / payload / tool 名）を audit に残す。**simulate より先**。これ単体でフォレンジック・KPI・再現性に効き、施策6 の前提にもなる。
3. **施策2（harvest）** — 実 FP を corpus に固定し、施策1 のゲートで再発を止める。ループを閉じる中心。harvest backlog は再発性（same-fingerprint repeat 件数）で並べる（§4.1 掟2）。
   - 施策6（simulate トリアージ）は **施策1 と並行**で価値が出るが、上の audit スキーマ拡張で replay fidelity が上がってから。fidelity が低いうちはゲートにせず方向性の参考に留める。
4. **施策3（approval cache）** — 最大の体感改善。ただし benign 確定済みのものだけに限定して入れる。
5. **施策4 / 5（judge 可用性 + Tier1 回帰）** — 残差 FP・構造的 FP を削る。可用性ループ（施策4）は品質ループと別レーンで回す（§4.1 掟1）。
6. **施策7（SLO ダッシュボード）** — 継続計測で回り続けていることを確認。
7. （later）**L2 substrate** で reversible を証明 → allow を広げ FP の天井を下げる。

---

## 8. 成功条件（「効いた」と言える状態）

- `provably-benign` corpus が実トレースと MUST-ALLOW カタログから育ち、**FP=0 が CI ハードゲート**として常時緑。`accepted-benign` は review-required から始まり、根拠が固まったものだけが hard gate 側に昇格する。
- dogfood の **silent-pass rate が ~98% に漸近**、`benignBlockRate` が**単調減少**、かつ **FN 回帰ゼロ**。
- 同一 reason / fingerprint の repeat ask が新規にほぼ出ない。出たら harvest / cache / fix で**そのターンのうちに閉じる**。
- 結果として、ユーザーが「止めなくていいものが止まった」と感じる頻度が、リリースを重ねるごとに**観測可能な形で下がり続ける**。

---

## 付録: 参照した実装

| トピック | ファイル |
|---|---|
| コーパス評価（FP/FN 指標の所在） | [`src/corpus/evaluate.ts`](../src/corpus/evaluate.ts), [`corpus/baseline.json`](../corpus/baseline.json), [`scripts/corpus.mjs`](../scripts/corpus.mjs) |
| FP 候補検出（noisy rule / bypass） | [`src/core/audit-analysis.ts`](../src/core/audit-analysis.ts) |
| メトリクス表示 | [`src/commands/metrics.ts`](../src/commands/metrics.ts) |
| トレース再分類 / what-if | [`src/core/reclassify.ts`](../src/core/reclassify.ts), [`src/commands/simulate.ts`](../src/commands/simulate.ts) |
| dogfood 状態 | [`src/operational-insights.ts`](../src/operational-insights.ts) |
| 判定設計 / 残差ホール | [`docs/CONCEPT.md`](./CONCEPT.md) §3,§10,§12 |
| 品質 KPI と Dial | [`docs/ROADMAP.md`](./ROADMAP.md) |
