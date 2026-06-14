# agent-belay CONCEPT v2.0 — belay 再設計: 復元可能性の床(restorability floor)

Status: **検証済みプロトタイプに基づく設計(作り直しの土台)**
基づくもの: 動作確認済みスパイク `~/.belay-spike/`(`verdict.mjs` / `hook.mjs` / `warm.mjs`)
思想の出典: Opus との原設計（storyline）、[`docs/adr/ADR-001-layered-enforcement.md`](./adr/ADR-001-layered-enforcement.md)
位置づけ: v0.3〜v0.9 の「静的コマンドリストで事前予測する gate」を core において**置き換える**。
ADR-001 が示した方向(予測を境界から外す)を、実測で裏づけた具体形。

> 日本語訳: [`CONCEPT.md`](./CONCEPT.md) が正本。両者が食い違う場合は英語版に従う。

---

## 1. これは何か(コンセプト)

belay は **YOLO モードで動かすエージェントのための、復元可能性の地雷線(floor)**。

確認の98%を素通りさせ、「**もし間違っても取り返しがつかない一握りの操作**」だけを止める。
網羅は狙わない。取りこぼしは YOLO ベースラインに戻るだけで、それより悪くはならない。
誤検知だけは限りなくゼロに近づける。

ビレイ(登山)の比喩そのもの ── クライマーは自由に登る(柵で動きを縛らない)。
墜落したときだけロープで止める。落ちても死なないから大胆に登れる。

### 判定軸は1本 ── 復元可能性

問いは「これは危険か?」ではなく「**もし間違いだったら、戻せるか?**」だけ。

- テスト赤でマージ / 雑なコミット / repo内のファイル削除 → 戻せる → **通す**
- `drop db` / `git push --force` / 本番デプロイ / repo外の破壊 → 戻せない → **止める(人に渡す)**

storyline 212 の到達点。「危険か」は主観で人の頭の中にしかないが、「戻せるか」はほぼ客観で、
行動と環境の性質として判定できる。

### 非ゴール

- 敵対的エージェントの封じ込め(OS サンドボックスの領分。ADR-001 の L1 完全版 / 将来)
- 網羅的な安全境界(予測で全コマンドを正しく判定することは原理的に不可能 = Rice)
- 静的 denylist / whitelist を安全境界にすること(リストは破綻する、が出発点)

---

## 2. 脅威モデル / 対象ユーザー

- **対象:協力的だが過つエージェント。** 悪意はないが、完了圧や勘違いで `drop db` のような
  不可逆操作に手を伸ばす。
- **対象ユーザー:自分の裁量で運用前プロダクトを YOLO で回す開発者。** 確認の98%が不要で
  邪魔。だが取り返しのつかない一握りだけは止めたい。日常業務(本番・多人数)はこの仕組みの
  対象外 ── そこは確認が必要だから。
- ネイティブ確認は二択(全部確認=98%ノイズ / YOLO=網ゼロ)しかない。その**中間**
  (YOLO + 薄い破滅対策)が、belay が固有に取れる場所。

---

## 3. アーキテクチャ ── 2検出器の床

`verdict(command, cwd, repoRoot)` が `allow` か `ask` を返す。
**2つの独立した検出器のどちらかが「戻せない」と言えば ask。** 互いの穴が重ならないので、
無限コスト案件に対する defense in depth になる。

```
verdict(command, cwd, repoRoot):

  ── Tier0:決定論(コード)。構造的に確実なものだけ。cwd を使う ──
    git push / リモート操作        → not-restorable (ask)   ※remote は snapshot 外
    git その他(ローカル)          → restorable (allow)     ※git snapshot で戻せる
    FS変更系(rm/mv/cp/dd/truncate/tee/shred / リダイレクト >):
        対象を cwd+repoRoot+realpath で解決し
        ├ repo外(home/system/他)   → not-restorable (ask)
        ├ 相対パス × cwd不明        → not-restorable (ask)  ※保守的に倒す
        └ 全て repo内               → restorable (allow)     ※fs snapshot で戻せる
    上記以外                        → 判断保留 → Tier1 へ

  ── Tier1:ローカル LLM(gemma4:e2b)。列挙不能な意味だけ。平坦な事実1問 ──
    「この操作は local machine + repo の外の状態を CHANGE するか?」 yes/no
        yes → not-restorable (ask)
        no  → restorable (allow)
    ※読み取り(describe/list/get/SELECT/GET)は CHANGE しない → no
    ※複合判断(restorable か?)は聞かない。合理化の逃げ道を与えない

  ── fallback ──
    judge 落ち / タイムアウト → ask(安全側 escalate。開放領域なので)

  床:  どれかが not-restorable → ask  /  全て restorable → allow(98%)
```

### 役割分担が「実測で」決まった理由

| 検出器 | 担当 | なぜそこか(実測の根拠) |
|---|---|---|
| **Tier0(決定論)** | git のリモート操作、パス包含 | LLM が `git push --force` を「git だから戻せる」と**合理化して見逃した**。git のリモート挙動とパス算術は**文書化された事実**で、コードで確実に拾える。LLM の機嫌に依らない |
| **Tier1(LLM)** | DB / クラウド / ネットワーク / リモートの変更 | 列挙が破綻する開放領域(新しい DB クライアント・CLI・SaaS が無限に増える)。2B が `dropdb`/`terraform`/`aws s3 rm`/`kubectl delete`/`curl POST`/`npm publish`/`redis FLUSHALL` を warm で全部正しく ask 判定 |
| **fallback** | judge 不在時の開放領域 | judge が落ちても床は壊れず、安全側に倒れる |

これは「2Bでも当たる」ではなく「**2Bが当たる範囲だけ2Bに任せ、当たらない構造判断は決定論が拾う**」。
小型ローカルモデル前提でアーキテクチャを組んだ結果。

### Tier1 のプロンプト設計(重要 ── 平坦な事実にする)

複合判断はモデルに合理化の余地を与える(force push が「git は戻せる、リモートは仮定で消す」で
すり抜けた実例)。だから Tier1 には**平坦な事実1問**だけを聞く:

> Does this command CHANGE (create / modify / delete / send) the state of any system
> OUTSIDE the local machine and its git repository? Reading or querying an external system
> (describe / list / get / SELECT / HTTP GET) does NOT change it. If unsure, yes.

「外部を読むだけ」を CHANGE=no と明示することで、`aws ec2 describe` の偽陽性が消えた(実測)。
構造化出力(`{external_change: boolean, reason: string}`)で受ける。

---

## 4. なぜローカル LLM(gemma4:e2b)か

- **エグレスゼロ** ── belay は外部効果を止める道具。判定のたびにコマンド全文を cloud に送るのは
  自家撞着。ローカルなら判定がマシンの外に出ない
- **プライバシー** ── シェルコマンドは秘密・パス・インフラ情報を含む
- **コストゼロ・API キー不要・Apache 2.0** ── gemma4:e2b(実効2B、~1.7GB、オンデバイス設計)
- **レイテンシ** ── warm ~1秒、コールド ~18秒。`beforeSubmitPrompt` でプリウォーム + `keep_alive`
  常駐で warm を維持。Tier1 を呼ぶのは開放領域の少数だけ(git/fs は Tier0 で即時)

判定器は実行エージェントと**別**であること(利害なし)。ただし実測で分かった通り、独立 judge でも
問いが曖昧だと合理化する ── 対策は「別モデル」だけでなく「平坦な事実への分解 + 構造判断は決定論」。

---

## 5. 動作モードと監査

- **audit モード(既定):** verdict を計算し trace に記録するが、常に `allow` を返す(止めない)。
  実分布の dogfood データを無リスクで集める
- **enforce モード:** 床が `ask` なら実際に Cursor の承認ダイアログを出す
- 切り替え: `~/.belay-spike/mode` に `enforce` / `audit`(本実装では config)

### trace(ndjson、全判定を記録)

```json
{ "ts", "mode", "command", "cwd", "cwdFromPayload", "repoRoot",
  "sandbox", "would", "by"(Tier0|Tier1|fallback), "reason" }
```

`would` は床が言ったこと(audit でも記録)。これが勝利条件の段階2(実分布計測)と、申告 vs 現実の
較正(storyline の「正直な穴」を可視化)の土台。

### 承認ループ(既存 belay から流用)

`ask` → 人が `/belay-approve <id>` で一回だけ許可(one-shot、TTL、revoke)。
storyline の「人が最終の不確実性を引き受ける」層。承認は**人の知識**(これは test DB だ等)と
**substrate 宣言**(config)が持ち、モデルには聞かない(「バックアップ在るか」を judge に
聞くと合理化する、の教訓)。

---

## 6. 文脈の収集(フックの責務)

判定には「エージェントのコマンドが走る cwd」と repoRoot が要る。フックは belay 自身のコードで
ゲートされないので、文脈を自分で集めて verdict に渡す:

```
cwd      = payload.cwd → payload.workspace_roots[0] → process.cwd()   (優先チェーン)
repoRoot = cwd から上に .git を探索、無ければ cwd
```

注意 ── フック自身の `process.cwd()` は**エージェントの cwd と一致しない**ことがある(別プロセス)。
Cursor は sandbox 経路で `cwd:""` を送ることがある(実測)。その時:
- 絶対パス・`~` は cwd 無しでも解決可
- 相対パスの FS 変更は **ask に倒す**(保守)
- `cwdFromPayload` を trace に記録し、cwd 供給の信頼度を測る

---

## 7. 既存 belay コードとの関係

### 残す(資産)

- **承認ループ**(one-shot / TTL / `/belay-approve` / revoke)
- **trace / audit.ndjson** の仕組み
- **フックインストーラ**(`.cursor/hooks.json` マージ、runner、node 解決)
- **skill 配布**(入り口を広く)

### 捨てる(ADR-001 が降格を決めたもの)

- 静的コマンドリスト分類器(`READ_ONLY_COMMANDS`/`FLAGGED_COMMANDS`/`EXTERNAL_COMMANDS`)と、
  その上に積んだ v0.3〜v0.9 の硬化(fail-closed リスト既定、control-plane ハッシュピン、
  サンドボックスブローカー、4次元判定 等)
- 理由:これらは「コマンド名から効果を事前予測する」予測 gate で、リストの穴=安全性の穴。
  本設計は予測を「構造的に確実な決定論(Tier0)」と「列挙不能な意味のローカル LLM(Tier1)」に
  分け、リストを安全境界から外す

### core の置き換え

`classifyShell` 等を呼ぶ経路を `verdict(command, cwd, repoRoot)` に差し替える。
フック I/O・承認・trace・インストーラはそのまま乗る。

---

## 8. ADR-001(L1–L4)との対応

| 層 | ADR-001 | 本設計での現在地 |
|---|---|---|
| L4 人間の承認 | 最終受け皿 | **実装済み(流用)** |
| L3 予測 | ノイズ削減 | **作り直し** = Tier0(構造的に確実)+ Tier1(列挙不能をローカル LLM)。リストではない |
| L2 観測(substrate) | スナップショット上で実測 | **未実装(前提として宣言)** ← §10 の穴 |
| L1 封じ込め(egress) | deny-all が境界 | 未実装(将来) |

本設計は「L3+L4 を正しくやり直した(決定論 + ローカル LLM)」段階。
「restorable か」の判定は L2 の substrate(git+fs スナップショット)が在る**前提**で答えている ──
そこが次の層。

---

## 9. 検証済みのこと(実測の記録)

- `permission:"ask"` は Cursor 実機で確認ダイアログを出す(`sandbox:false`/`true` 両方)
- gemma4:e2b は「reversible」を operational に定義(= substrate で戻せるか、「バックアップ在る」は
  数えない)+ 平坦な事実問いにすれば、drop db を正しく不可逆判定
- 複合問い「restorable か?」は force push を「git だから戻せる」で**見逃した**(偽陰性)
  → git を Tier0 に移して解消
- 8コマンドのスパイクで 8/8、破滅10種で 10/10 ask(warm時の本物 Tier1 判定 + 安全側 fallback)
- `aws ec2 describe` の偽陽性は平坦「CHANGE?」問いで解消
- レイテンシ warm ~1秒 / コールド ~18秒 → プリウォークで解消
- 修正が**振動しなかった**(git を Tier0 へ、は一発で landed)= 構造的分解が正しい兆候

---

## 10. 正直な穴(命名・重大度つき)

| # | 穴 | 重大度 | 現状の挙動 |
|---|---|---|---|
| H1 | **チェーン `a && b` / コマンド置換 `$(...)` / サブシェル** をトークナイザが分割しない。隠れた破滅(`ls && dropdb prod`)を取りこぼす | **高(偽陰性)** | YOLO ベースラインに戻るだけ(悪化はしない)。**最優先で塞ぐ** |
| H2 | sandbox 経路で **cwd が来ない** → 相対パスの包含が解けない | 中 | ask に倒す(安全だが偽陽性増の可能性) |
| H3 | **コールドスタート** で初回開放コマンドが fallback ask | 低 | 安全側。プリウォークで緩和 |
| H4 | **開放領域の残存偽陰性** ── 2B が知らない新種の外部変更ツールを allow しうる | 中(真の残存) | Tier0 の backstop が届かない唯一の領域。緩和:大きいモデル / よくある外部ファミリーの構造認識を第三検出器 / 承認キャッシュ |
| H5 | **substrate 未実装(L2)** ── 「restorable」は git+fs スナップショットが在る前提だが未実装。git追跡分は本物、未追跡ファイル削除は「再生成可能」に寄りかかる | 中 | git worktree / fs スナップショットを実装すれば文字通り真になる |
| H6 | Tier1 = 2B はドリフトしうる | 低〜中 | 構造判断は決定論に逃がしてある。開放領域のみ LLM 単独 |

**過信が唯一の真の危険** ── 床の見逃しは YOLO に戻るだけで悪化しないが、「belay があるから」と
YOLO を強めて見逃すと悪化する。だから穴は正直に文書化する(storyline の精神)。

---

## 11. 勝利条件(「実運用で回る」の定義)

非対称:偽陰性=無限コスト(だが見逃しは YOLO ベースラインに戻るだけ)、偽陽性=摩擦(過剰なら
無効化=網ゼロ)。3段階で積む:

1. **adversarial コーパスで偽陰性ゼロ(CI ハードゲート)** ── バイパス系(チェーン/置換/ラッパー/
   インタプリタ/パストリック)+ 破滅系 + 凡庸系。**必要だが不十分**(既知の難所しかテストしない)
2. **実分布 dogfood**(数週間、実 YOLO 作業)── 悔やむ見逃しゼロ + 無効化しない程度の偽陽性。
   **未知の未知**をテストする唯一の手段
3. **revealed preference** ── あなたが自発的に使い続ける。個人ツールの勝利条件そのもの

正直な天井:偽陰性ゼロは原理的に証明不能。勝利 = 「決定論層は構造的に無欠 + 残存(H4)が命名・
実測で小・backstop あり + 見逃しは YOLO に戻るだけ + 過信させない文書」。

---

## 12. 作る順番(バージョン番号もロードマップも作らない、次の1つだけ)

1. **Tier0 トークナイザ強化(H1)** ── `&& || ; |` と改行でセグメント分割、`$(...)`/バックティック/
   サブシェルを検出。各セグメントを判定し、解析不能なら ask。これで最大の穴が閉じる
2. **adservarial コーパス + 評価ハーネス** ── 偽陰性=0 をハードゲートに。実 trace から育てる
3. **audit dogfood 継続** ── 実分布の偽陽性を測り、コーパスの種にする
4. (後で)**L2 substrate**(git worktree スナップショット)で「restorable」を文字通り真にする
5. (後で)**承認キャッシュ**で describe 級の偽陽性を吸収(初回 ask → 許可登録 → 以降素通り)

各ステップは「作った日に使う」。動かないステップ・使わない最適化は作らない。

---

## 付録:検証済みプロトタイプ

`~/.belay-spike/` に動作実体がある:
- `verdict.mjs` ── Tier0 + Tier1 + fallback(本設計の core)
- `hook.mjs` ── Cursor `beforeShellExecution` 入口、文脈収集、trace、audit/enforce
- `warm.mjs` ── `beforeSubmitPrompt` プリウォーク
- `trace.ndjson` ── 実分布の記録

本実装は、このプロトタイプを belay の構造(承認ループ・インストーラ・skill)に取り込む形で行う。
