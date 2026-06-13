# agent-belay SPEC v2.3 — 初 OSS リリース（restorability floor + 命綱 skill 知性層）

Status: **Canonical / Release spec**（規範。belay の初出荷バージョン）
Builds on: SPEC-v2.0〜v2.2（floor / judge / skill front-door / scope）、SPEC-v2.1.2〜v2.1.4
（Tier0 偽陰性・偽陽性・concept conformance）、ADR-001 / ADR-002
Supersedes: `SPEC-v2.3-draft.md`（pillar 検討を本書に正本化。同ファイルは `-superseded` で退避）
扱うこと: belay を**初めて OSS として出荷**する。出荷物 = (1) 概念整合した restorability floor、
(2) skill front-door、(3) **skill 知性層（③可視化 + ①復元 = 命綱の完成）**。

---

## 0. これは何のリリースか

belay が作っているのは1つの判定規則（ADR-002）:
> **「間違いだったとして取り消せるか? 取り消せる/何も変えない → 通す。取り消せない×破滅的 → ask。」**

v2.3 はこの floor を**初めて出荷可能な製品**にする。新規の中核は **skill 知性層**:
- **③ 可視化** — 「98% 黙過」で見えない床を、監査要約で**見せる**（低障壁・信頼構築）。
- **① 復元支援（命綱）** — 止めた/起きた後の**戻し方を助言**する。belay が「取り消せるか」で判定する
  以上、いざ取り消す段で**取り消し方を知っている**のは自然。「止める床」と「引き上げる命綱」の二役で
  belay の独自性を確立する。

**② 上流ディシプリンは v2.3 に含めない**（助言ゆえ fence/予測に化けるリスク。§5 で後送り理由）。

> 不変条件（ADR-002）: **skill は floor を代替しない。** ③も①も hook(floor) の上に乗る助言/UX で
> あり、新しい停止・緩和・自動実行を導入しない。

---

## 1. リリーススコープとゲート

| WS | 内容 | 状態 / 出荷ゲート |
| --- | --- | --- |
| **WS-Concept** | restorability floor の概念整合（ADR-002） | v2.1.3/v2.1.4 実装済み。**FN=0 と FP→0 の両輪 + guarantee 実行照合が緑**であること（R-REL1） |
| **WS-Front** | skill front-door / scope（v2.2 R-S1〜S5） | 実装済み。**R-S2 wizard 整合 + G-B1 close** が出荷前提（v2.2 残ゲート） |
| **WS-Visible** | ③ 可視化（R-V*） | **本書で新規規範化・実装** |
| **WS-Recover** | ① 復元支援（R-R*） | **本書で新規規範化・実装** |
| **WS-Release** | OSS 出荷整備（docs / 配布 / semver / adapter 状態）（R-REL*） | 本書で規範化 |

---

## 2. WS-Visible — ③ 可視化（hook の上の助言・read-only）

### R-V1 — 監査要約コマンド（MUST）
- `agent-belay status`（既存）を拡張、または `agent-belay report` を新設し、監査ログ
  （`*/belay/audit.ndjson`）から**人間可読の要約**を出す:
  - 期間内に **ask（block）した件数 / flag した件数 / 黙過（allow）した件数**、**silent-pass 率**、
    直近の ask 一覧（コマンド redacted + reason + tier）。
- **MUST（ADR-002）**: 監査の **read-only** 集計のみ。新しい判定・停止・緩和を導入しない。
- skill: `/belay status` がこれを呼ぶ薄い表口（v2.2 R-S3 の延長）。
- **受け入れ基準**: T-V1（固定 audit に対し件数・silent-pass 率が一致）。

### R-V2 — 「fence ではない」の自己診断（SHOULD）
- silent-pass 率が想定（おおむね高い）を**下回ったら doctor/report が警告**する
  （過剰ブロック=fence 化の早期検知。ADR-002 M6）。
- **受け入れ基準**: T-V2（FP を注入した audit で警告が出る）。

## 3. WS-Recover — ① 復元支援（命綱・助言のみ）

### R-R1 — 復元助言コマンド（MUST）
- `agent-belay recover`（`/belay recover`）を新設。直近の**不可逆方向に見える操作**（audit の
  destructive/ask エントリ、または明示指定したコマンド）に対し、**戻し方を助言**する:
  - 例: ファイル削除/編集 → `git restore` / `git checkout` / `git reflog` / trash 復元、
    誤 commit → `git revert` / reset、push → revert+push、等。
  - 入力 = audit（何が起きたか）+ repo 状態（`git status`/`reflog` の利用可否）。
- **MUST（ADR-002・最重要）**: **助言のみ。復元コマンドを自動実行しない。** 提示した逆操作を
  実行する場合は、それ自体が belay の hook を通る（逆操作も破壊的なら ask される）。auto-fix
  エージェント化しない（賢くして自動修復させる圧に抗う）。
- **MUST（非破壊優先）**: **可逆な復元経路だけを提示**する。`reset --hard` のような**それ自体が
  不可逆**な手段を、可逆なミスの修復に勧めてはならない（特定ファイルの `restore`/`reflog` を
  広域操作より優先）。
- **MUST（show-don't-run）**: 「実行せよ」ではなく「**これで戻せる可能性がある・実行前に確認を**」
  とフレーミングする。確信が低い案は出さない。
- **MUST（過剰約束しない・正直さ）**: 可逆/不可逆を**言い分ける**。belay が ask したものは定義上
  「取り消せない×破滅的」＝**復元不能**であり、その場合は「**これは取り消せない**（exfil 済み /
  remote 削除 / force-push 等）」と明示し、ありもしない復元案を出さない（誤った復元案は害）。
- **MUST（部分視界の明示）**: 助言は **belay が hook で観測した範囲**（redact 済み audit）に基づく。
  手動操作や redact された詳細は見えないことを明示する。
- **SHOULD（偽りの安心を作らない）**: 出力トーンは「これは保険であって、止めた ask は依然
  あなたの判断」を保つ。命綱は「落ちる」ことを推奨しない。
- **受け入れ基準**: T-R1（既知の破壊操作の audit から正しい復元案）/ T-R2（自動実行しない）/
  T-R3（復元不能ケースで「不能」を明示）/ T-R4（不可逆な復元手段を提示しない）/
  T-R5（show-don't-run フレーミング・確信低は出さない）。

### R-R2 — 命綱は floor の判定根拠を流用する（SHOULD）
- 復元助言は belay が既に持つ **reversibility 判定**（Tier0/Tier1 の effect/location）を入力にする。
  「止める床」と「引き上げる命綱」が**同じ restorability レンズ**で一貫すること。

## 4. WS-Release — OSS 出荷整備

### R-REL1 — 概念整合ゲート（出荷の絶対条件）
- **FN=0**（構造スイート MUST-ASK）と **FP→0**（MUST-ALLOW）の**両輪が硬い CI ゲート**として緑。
- **guarantee-table が実エンジンで実行照合**され、ADR/SPEC と一致（v2.1.4 R38）。
- CONCEPT-v2.0 を**唯一の判定規則の出典**として参照（ADR-002 M1）。

### R-REL2 — docs 整備（出荷条件）
- README が安全境界（skill-only=助言 / `init` 必須）を保持し、scope（project/global）と
  対応 adapter を正確に記載。stale なロードマップ（v0.4 停止）を v2.x に更新。
- guarantee-table.md を**公開 conformance 契約**として整備。SECURITY.md 脅威モデルを最新化。

### R-REL3 — 配布（出荷条件）
- **skill front-door**: `npx skills add`（marketplace）+ `init --with-skill --scope X`（per-host）。
- 対応 adapter の出荷状態を明示:
  - **Cursor / Claude Code** = 出荷（hooks + skill 検証済み）。
  - **Codex** = **experimental 出荷**（shell gating 検証済み / 非 shell tool 名 best-guess /
    managed 未実装）。doctor が残存注意点を表示（v2.2 R-X3）。
- managed Codex / plugin・hook-package（v2.2 R-X4 WS-Pkg）は**本リリースの非ゴール**（出荷後）。

### R-REL4 — バージョン契約（semver）
- 公開・安定とみなす表面を宣言: CLI コマンド（init/upgrade/doctor/explain/status/recover/approve）、
  config schema v4、guarantee-table。以後はこれに semver を適用。

## 5. 非ゴール（v2.3）

- **② 上流ディシプリン**（エージェントに事前自己点検を促す）。助言ゆえモデルが無視でき、
  **fence/予測ゲート**（v2.0 で捨てた方式）に化けるリスク。**v2.4 候補**として別途検討。
- skill による floor の代替・自動復元実行・ephemeral トグル（v2.2 §4 / ADR-002 を継承）。
- 判定ロジック（Tier0/Tier1/三値 boolean）の変更。managed Codex / plugin 配布（出荷後）。

## 6. テスト要件 (v2.3)

| # | 対象 | 検証 |
| --- | --- | --- |
| T-V1 | R-V1 可視化 | 固定 audit → ask/flag/allow 件数・silent-pass 率が一致（read-only） |
| T-V2 | R-V2 自己診断 | FP 注入 audit で過剰ブロック警告 |
| T-R1 | R-R1 復元助言 | 既知破壊操作の audit → 正しい復元案 |
| T-R2 | R-R1 不変条件 | recover が**自動実行しない**（提示のみ） |
| T-R3 | R-R1 正直さ | 復元不能ケースで「不能」を明示 |
| T-REL1 | R-REL1 概念ゲート | FN=0 + FP→0 + guarantee 実行照合が緑 |
| T-REL2 | R-REL3 配布 | `npx skills add` / `init --with-skill --scope` → `doctor` 緑（Cursor/Claude） |

## 7. リリース判定（v2.3 Done = 出荷可）

1. **R-REL1**: FN=0 / FP→0 / guarantee 実行照合が緑（概念整合の証明）。
2. **WS-Front 残ゲート close**: R-S2（wizard 実装 or spec 整合）+ G-B1（Cursor UX 確認）。
3. **R-V1/R-V2**: 可視化が出荷（silent-pass を見せる + fence 化を自己診断）。
4. **R-R1/R-R2**: 復元助言が出荷（助言のみ・正直・restorability レンズ一貫）。
5. **R-REL2/R-REL3/R-REL4**: docs / 配布 / semver 整備。Codex は experimental 明示で出荷。
6. ② 上流ディシプリンは v2.4 候補として記録（本リリース非ゴール）。

## 8. 一行で

**v2.3 = belay の初出荷。「取り消せない×破滅的だけ止める床」を概念整合した状態で出し、
それを『見せる(③)』『引き上げる(①命綱)』skill 知性層を載せる。fence には決してしない。**

## 参照

- 思想/規律: [CONCEPT-v2.0.md](./CONCEPT-v2.0.md) / [ADR-002-concept-conformance.md](./ADR-002-concept-conformance.md)
- 前提: [SPEC-v2.2.md](./SPEC-v2.2.md)（skill front-door / scope）/ [SPEC-v2.1.3](./SPEC-v2.1.3.md) /
  [SPEC-v2.1.4](./SPEC-v2.1.4.md)（concept conformance）
- 元検討: `SPEC-v2.3-draft-superseded.md`（三本柱の検討）
