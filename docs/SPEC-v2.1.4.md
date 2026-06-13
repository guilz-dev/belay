# agent-belay SPEC v2.1.4 — Concept conformance audit（L1/egress・Codex tool identity・subagent intent の floor 整合）

Status: **Implemented** (SPEC v2.1.4)
Builds on: ADR-002（concept conformance）/ SPEC-v2.1.3（egress 偽陽性）/ CONCEPT-v2.0（restorability floor）
Source: 2026-06-13 レビュー指摘（P0×2 / P1×2 / P2×1）を 2026-06-13 に実装完了。
`make verify-parallel`（410 tests）緑。main @ `7f0fd3e` 以降。

---

## Summary

belay のコンセプトは **restorability floor**:
> 「取り消せるなら通す。**取り消せない × 破滅的**だけ ask。fence ではない。」

ADR-002 M5（コンセプト再定義時の全ルール監査）をレビュアーが L1〜L4 に適用した結果、
**行為ではなく tool identity / 依頼文の意図 / レイヤの起動状態で止める/緩める fence ルール**が
複数残存していた。5 件すべて**同じ病**であり、独立バグではなく**1 つの概念整合タスク**として
一括で修正した。

当初の監査で特に危険だった 2 件の**実 FN**（偽陽性だけでなく床の穴）は解消済み:
- ~~`demoteL3External` が `git push` 等の `remote_mutation` ask を proxy 起動中というだけで hint に降格~~
  → shell classifier から L3 降格を**完全削除**（R36）。
- ~~egress proxy の承認 fingerprint が method を含まず、GET の承認で同 host:port の POST/DELETE まで通る~~
  → method/action class 付き fingerprint に作り替え（R37）。

## 規範上の位置づけ

- **FN=0 は不可侵**（R1〜R14）。本書は偽陽性（fence）を削り、上記 2 件の**実 FN を塞いだ**。
- 判定規則（ADR-002 §3）を全レイヤに適用する:
  > 取り消せる/何も変えない → 通す。取り消せない×破滅的 → ask。曖昧 → Tier1/ask（fail-closed）。
- **止める根拠は「行為の不可逆性」のみ**。tool 名・カテゴリ・依頼文の語・レイヤ起動状態で止めない。

## 非ゴール

- action-specific に正しいルール（`git push` / `docker push` / `npm publish` / `terraform apply`）の弱体化。
- egress チョークポイントの撤廃（撤廃ではなく read/mutate/exfil へ作り替える）。
- Tier0/Tier1 判定ロジック・三値 boolean そのものの変更。

---

## 要件（実装済み）

### R38 — guarantee-table を ADR に合わせ、実行照合テストにする ✅

- [src/conformance/guarantee-table.ts](../src/conformance/guarantee-table.ts) と
  [docs/guarantee-table.md](./guarantee-table.md) を ADR-002 / SPEC-v2.1.3 に合わせた
  （`curl https://example.com` 等の read 系を deny 固定から外した）。
- [src/__tests__/conformance/guarantee-table.test.ts](../src/__tests__/conformance/guarantee-table.test.ts)
  で**表の各 scenario を実エンジン（verdict/gate）で実行し、表の期待と一致するか検証**する。
  表と実装が乖離したら CI が落ちる。
- ADR-002 M2（MUST-ALLOW を MUST-ASK と同格の硬いゲートに）の guarantee-table 版。

### R36 — `demoteL3External` による shell L3 降格を廃止 ✅

- [src/core/gate-engine.ts](../src/core/gate-engine.ts) の `applyShellPeripheralPolicy` から
  **egress proxy 起動中の external_effect 降格を完全削除**した（read-only 限定ではなく廃止）。
  残る降格は **capability broker fs-scope** のみ（`capability_fs_hint`）。
- `tier0_external` / `remote_mutation` / `external_effect`(mutate) は**いかなる条件でも
  shell classifier で降格されない**。
- 固定テスト [egress-l3-demotion.test.ts](../src/__tests__/egress-l3-demotion.test.ts) /
  guarantee-table の `git push`・`npm run deploy` は **ask 維持**（hint ではない）。
- 根拠: proxy 起動は「行為の可逆性」を変えない。push は依然 irreversible×catastrophic → ask 維持。

**P2 残債（非ブロッカー）**: `egress.demoteL3External` は config/preset に legacy として残存するが、
shell classifier には適用されない。`doctor` / `explain` は「legacy・未適用」と表示する。
将来の minor で設定削除または deprecation 注記を検討。

### R37 — egress proxy を read/mutate/exfil 判定に作り替え、fingerprint を method+action class で分離 ✅

- [src/core/egress/policy.ts](../src/core/egress/policy.ts): allowlist/approved に無ければ
  GET でも一律 deny する「host 単位 fence」をやめ、**method/action で判定**する:
  - read（GET/HEAD・無 body）→ 過剰ブロックしない。
  - mutate/exfil（POST/PUT/PATCH/DELETE・body 付き・upload）→ ask。
  - 曖昧 → fail-closed（ask）。
- [src/core/egress/fingerprint.ts](../src/core/egress/fingerprint.ts): fingerprint に
  **method（最低でも action class＝read/mutate）を含める**。GET の承認で同 host:port の
  POST/DELETE が通る粗い承認（FN）を解消した。
- 関連: [egress/types.ts](../src/core/egress/types.ts) /
  [egress/proxy-server.ts](../src/core/egress/proxy-server.ts)。
- 注: 秘密を URL に混ぜる GET（`?leak=$(cat .env)`）は command 層の `command_substitution` /
  secret prescan が ask に倒すため、read を通しても exfil 経路は守られる（FN=0 保全）。

### R39 — Codex 未マップ tool は hard deny ではなく **ask**、既知 tool の payload は実 shape で正規化 ✅

- 未マップ tool の既定 `deny`（hard block）は **tool identity で止める fence** だった。
  [src/adapters/codex/runtime-entry.ts](../src/adapters/codex/runtime-entry.ts) の
  `gateUnmappedToolVerdict` 経由で **`ask`（deny_pending_approval + approval path）** に変更した。
  - **audit-only allow は不可**（黙過＝FN）。identity で hard-block もせず、黙過もせず、**人間に委ねる**
    のが floor-native の中間で FN=0 を保つ。
- `normalizeCodexToolPayload` が `apply_patch` を `ApplyPatch(patch body)` として正規化するよう修正。
  path shape 違いで `file_mutation_missing_path` deny に落ちない。
- 結果: 既知 tool は action で判定。未マップ tool は ask（黙過ではない）。

### R40 — subagent gate は phrase-deny をやめ、実行層の判定に委ねる ✅

- [src/core/classify-subagent.ts](../src/core/classify-subagent.ts) の
  `deploy`/`production`/`publish`/`email` 等の**語だけで `deny_pending_approval`** を返す挙動を廃止。
  `allow_flagged` + `subagent_external_intent_hint` に変更。
- subagent が実行する不可逆操作は **shell/tool 実行時のゲート**で捕捉する。
- 内側ゲート確認: [hooks-runtime.test.ts](../src/__tests__/hooks-runtime.test.ts) の
  **R40 TE**（deploy 文言 allow → 続く `git push` shell deny + pending）。

### R41 — FN=0 保全の不変条件（全要件横断） ✅

- 偽陽性を削る各変更で、不可逆経路が**いずれかのルールで必ず ask**されること:
  push/publish/apply 等の mutate（維持）、データ送信 egress（R37）、未マップ tool（R39=ask）、
  秘密読取（既存 substitution ルール）。
- 構造スイート（FN=0 ハードゲート）と R38 の guarantee 実行照合が緑であること。

---

## テスト要件 (v2.1.4)

各領域で **MUST-ALLOW（偽陽性解消）** と **MUST-ASK（FN=0 保全）** の両系列を、実エンジンで検証する。

| # | 領域 | MUST-ALLOW（ask されない） | MUST-ASK（ask） | テスト |
| --- | --- | --- | --- | --- |
| TA | demote (R36) | （該当なし。L3 降格廃止） | `git push` / `npm run deploy` が proxy 起動中でも **ask**（hint でない） | `egress-l3-demotion.test.ts` |
| TB | egress proxy (R37) | GET example.com（read） | 同 host への POST/DELETE / body 付き / upload。GET の承認が POST を通さない | `egress-policy.test.ts`, `egress-proxy.test.ts` |
| TC | guarantee (R38) | 表の read scenario が実エンジンで allow 系 | 表の mutate scenario が実エンジンで deny 系。**表＝実装の一致を実行照合** | `guarantee-table.test.ts` |
| TD | Codex (R39) | 既知 tool（apply_patch 等）が誤 deny されない | 未マップ tool が **ask**（黙過でない）。apply_patch が正規化され誤 deny しない | `codex-adapter.test.ts`, `classify-tool.test.ts` |
| TE | subagent (R40) | 「deploy」を含むだけの依頼が phrase-deny されない | subagent の実不可逆操作が実行層で ask（内側ゲート確認後） | `classify-subagent.test.ts`, `hooks-runtime.test.ts` |

## 出荷判定（v2.1.4 Done）

1. ✅ R1〜R14（FN=0 構造スイート）と R38 の guarantee 実行照合が緑。
2. ✅ R36: `tier0_external`/`remote_mutation` がいかなる条件でも shell classifier で降格されない（TA）。
3. ✅ R37: read 過剰ブロック解消 + method/action fingerprint で粗い承認解消（TB）。
4. ✅ R38: guarantee-table が ADR/v2.1.3 と一致し、各 scenario を実行照合（TC）。
5. ✅ R39: 未マップ Codex tool が ask、payload 正規化が実 shape（TD）。
6. ✅ R40: phrase-deny 廃止、内側ゲート確認済み（TE）。

## 参照

- 規律: [ADR-002-concept-conformance.md](./ADR-002-concept-conformance.md)（M2/M3/M5/M7）
- 兄弟: [SPEC-v2.1.2.md](./SPEC-v2.1.2.md)（Tier0 偽陰性）/ [SPEC-v2.1.3.md](./SPEC-v2.1.3.md)（egress 偽陽性）
- 該当コード: [gate-engine.ts](../src/core/gate-engine.ts) /
  [egress/policy.ts](../src/core/egress/policy.ts) /
  [egress/fingerprint.ts](../src/core/egress/fingerprint.ts) /
  [conformance/guarantee-table.ts](../src/conformance/guarantee-table.ts) /
  [adapters/codex/runtime-entry.ts](../src/adapters/codex/runtime-entry.ts) /
  [classify-tool.ts](../src/core/classify-tool.ts) /
  [classify-subagent.ts](../src/core/classify-subagent.ts) /
  [adapters/shared/gate-runtime.ts](../src/adapters/shared/gate-runtime.ts)（`gateUnmappedToolVerdict`）
- 観測: `git push` は proxy 起動中でも ask、`curl` read は allow 系、未マップ Codex tool は ask +
  pending approval（410 tests 通過）
