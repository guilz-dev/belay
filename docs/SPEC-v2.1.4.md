# agent-belay SPEC v2.1.4 — Concept conformance audit（L1/egress・Codex tool identity・subagent intent の floor 整合）

Status: Draft（spec-first。実装前のレビュー用）
Builds on: ADR-002（concept conformance）/ SPEC-v2.1.3（egress 偽陽性）/ CONCEPT-v2.0（restorability floor）
Source: 2026-06-13 レビュー指摘（P0×2 / P1×2 / P2×1）。`pnpm vitest run` 158 tests 全通過 ―― つまり
これらは**未実装ではなく「現行契約として固定済み」のズレ**である（ADR-002 root cause #1/#2）。

---

## Summary

belay のコンセプトは **restorability floor**:
> 「取り消せるなら通す。**取り消せない × 破滅的**だけ ask。fence ではない。」

ADR-002 M5（コンセプト再定義時の全ルール監査）をレビュアーが L1〜L4 に適用した結果、
**行為ではなく tool identity / 依頼文の意図 / レイヤの起動状態で止める/緩める fence ルール**が
複数残存していた。5 件すべて**同じ病**であり、独立バグではなく**1 つの概念整合タスク**として扱う。

特に 2 件は**実 FN**（偽陽性だけでなく床の穴）:
- `demoteL3External` が `git push` 等の `remote_mutation` ask を proxy 起動中というだけで hint に降格。
- egress proxy の承認 fingerprint が method を含まず、GET の承認で同 host:port の POST/DELETE まで通る。

## 規範上の位置づけ

- **FN=0 は不可侵**（R1〜R14）。本書は偽陽性（fence）を削ると同時に、上記 2 件の**実 FN を塞ぐ**。
- 判定規則（ADR-002 §3）を全レイヤに適用する:
  > 取り消せる/何も変えない → 通す。取り消せない×破滅的 → ask。曖昧 → Tier1/ask（fail-closed）。
- **止める根拠は「行為の不可逆性」のみ**。tool 名・カテゴリ・依頼文の語・レイヤ起動状態で止めない。

## 非ゴール

- action-specific に正しいルール（`git push` / `docker push` / `npm publish` / `terraform apply`）の弱体化。
- egress チョークポイントの撤廃（撤廃ではなく read/mutate/exfil へ作り替える）。
- Tier0/Tier1 判定ロジック・三値 boolean そのものの変更。

---

## 要件

### R38 — guarantee-table を ADR に合わせ、実行照合テストにする（**最優先・M2 の実体化**）

> root cause #1/#2 を最初に潰す。契約が嘘をつけない状態を先に作れば、以降の修正がテストで固定される。

- [src/conformance/guarantee-table.ts](../src/conformance/guarantee-table.ts) と
  [docs/guarantee-table.md](./guarantee-table.md) を ADR-002 / SPEC-v2.1.3 に合わせる
  （`curl https://example.com` 等の read 系を deny 固定から外す）。
- [src/__tests__/conformance/guarantee-table.test.ts](../src/__tests__/conformance/guarantee-table.test.ts)
  を、件数照合でなく**表の各 scenario を実エンジン（verdict/gate）で実行し、表の期待と一致するか
  検証する**形に作り替える。表と実装が乖離したら CI 落ち。
- これは ADR-002 M2（MUST-ALLOW を MUST-ASK と同格の硬いゲートに）の guarantee-table 版。

### R36 — `demoteL3External` は remote_mutation/tier0_external を絶対に降格しない（**実 FN**）

- [src/core/gate-engine.ts:123 `applyShellPeripheralPolicy`](../src/core/gate-engine.ts#L123) の
  「proxy 起動中なら external_effect の ask を `allow_flagged` に降格」を**廃止**する。
- 最低でも、降格対象を**真の read-only egress（`egress_read`）に厳密限定**し、
  `tier0_external` / `remote_mutation` / `external_effect`(mutate) は**いかなる条件でも降格しない**。
- 固定テスト [egress-l3-demotion.test.ts](../src/__tests__/egress-l3-demotion.test.ts) /
  guarantee-table の `git push`・`npm run deploy` を **hint → ask** へ修正（R38 の表と整合）。
- 根拠: proxy 起動は「行為の可逆性」を変えない。push は依然 irreversible×catastrophic → ask 維持。

### R37 — egress proxy を read/mutate/exfil 判定に作り替え、fingerprint を method+action class で分離

- [src/core/egress/policy.ts:6](../src/core/egress/policy.ts#L6): allowlist/approved に無ければ
  GET でも一律 deny する「host 単位 fence」をやめ、**method/action で判定**する:
  - read（GET/HEAD・無 body）→ 過剰ブロックしない。
  - mutate/exfil（POST/PUT/PATCH/DELETE・body 付き・upload）→ ask。
  - 曖昧 → fail-closed（ask）。
- [src/core/egress/fingerprint.ts:3](../src/core/egress/fingerprint.ts#L3): fingerprint に
  **method（最低でも action class＝read/mutate）を含める**。GET の承認で同 host:port の
  POST/DELETE が通る粗い承認（FN）を解消する。
- 関連: [egress/types.ts](../src/core/egress/types.ts) /
  [egress/proxy-server.ts:75](../src/core/egress/proxy-server.ts#L75)。
- 注: 秘密を URL に混ぜる GET（`?leak=$(cat .env)`）は command 層の `command_substitution` /
  secret prescan が ask に倒すため、read を通しても exfil 経路は守られる（FN=0 保全）。

### R39 — Codex 未マップ tool は hard deny ではなく **ask**、既知 tool の payload は実 shape で正規化

- 未マップ tool の既定 `deny`（hard block）は **tool identity で止める fence**。
  [runtime-entry.ts:160](../src/adapters/codex/runtime-entry.ts#L160) を
  **`ask`（deny_pending_approval + approval path）** に変える。
  - **audit-only allow は不可**（黙過＝FN）。identity で hard-block もせず、黙過もせず、**人間に委ねる**
    のが floor-native の中間で FN=0 を保つ。
- [normalizeCodexToolPayload:110](../src/adapters/codex/runtime-entry.ts#L110) が apply_patch まで
  `Write(path)` に潰し、path shape 違いで
  [classify-tool.ts:104 `file_mutation_missing_path`](../src/core/classify-tool.ts#L104) deny に落ちる
  のを修正。**実 payload shape を確認**し（apply_patch の patch body 等）、tool ごとに正しく正規化する。
- 結果: read-only MCP/tool を「未マップだから止める」挙動を解消（action で判定）。

### R40 — subagent gate は phrase-deny をやめ、実行層の判定に委ねる（**要・内側ゲート確認**）

- [classify-subagent.ts:5 / :106](../src/core/classify-subagent.ts#L106) の
  `deploy`/`production`/`publish`/`email` 等の**語だけで `deny_pending_approval`** を返す挙動は、
  実際の不可逆操作ではなく「依頼文の意図」を止めており、v2.0 で捨てた**予測ゲートの出戻り**。
- phrase-deny を**廃止**し、subagent が実行する不可逆操作は **shell/tool 実行時のゲート**で捕捉する。
- **前提条件（MUST）**: 廃止前に「subagent 配下の tool/shell 呼び出しが各 adapter で確実に
  ゲートされる（PreToolUse 等が発火する）」ことを確認する。発火しない経路があるなら、その経路を
  塞ぐまで phrase-deny は**残す**（実ギャップを作らない）。

### R41 — FN=0 保全の不変条件（全要件横断）

- 偽陽性を削る各変更で、不可逆経路が**いずれかのルールで必ず ask**されること:
  push/publish/apply 等の mutate（維持）、データ送信 egress（R37）、未マップ tool（R39=ask）、
  秘密読取（既存 substitution ルール）。
- 構造スイート（FN=0 ハードゲート）と R38 の guarantee 実行照合が緑であること。

---

## テスト要件 (v2.1.4)

各領域で **MUST-ALLOW（偽陽性解消）** と **MUST-ASK（FN=0 保全）** の両系列を、実エンジンで検証する。

| # | 領域 | MUST-ALLOW（ask されない） | MUST-ASK（ask） |
| --- | --- | --- | --- |
| TA | demote (R36) | （該当なし。降格対象は read のみ） | `git push` / `npm run deploy` が proxy 起動中でも **ask**（hint でない） |
| TB | egress proxy (R37) | GET example.com（read） | 同 host への POST/DELETE / body 付き / upload。GET の承認が POST を通さない |
| TC | guarantee (R38) | 表の read scenario が実エンジンで allow 系 | 表の mutate scenario が実エンジンで deny 系。**表＝実装の一致を実行照合** |
| TD | Codex (R39) | read-only MCP/tool が hard-deny されない | 未マップ tool が **ask**（黙過でない）。apply_patch が正規化され誤 deny しない |
| TE | subagent (R40) | 「deploy」を含むだけの依頼が phrase-deny されない | subagent の実不可逆操作が実行層で ask（内側ゲート確認後） |

## 出荷判定（v2.1.4 Done）

1. R1〜R14（FN=0 構造スイート）と R38 の guarantee 実行照合が緑。
2. R36: `tier0_external`/`remote_mutation` がいかなる条件でも降格されない（TA）。
3. R37: read 過剰ブロック解消 + method/action fingerprint で粗い承認解消（TB）。
4. R38: guarantee-table が ADR/v2.1.3 と一致し、各 scenario を実行照合（TC）。
5. R39: 未マップ Codex tool が ask、payload 正規化が実 shape（TD）。
6. R40: phrase-deny 廃止、ただし内側ゲート確認済み（TE）。

## 参照

- 規律: [ADR-002-concept-conformance.md](./ADR-002-concept-conformance.md)（M2/M3/M5/M7）
- 兄弟: [SPEC-v2.1.2.md](./SPEC-v2.1.2.md)（Tier0 偽陰性）/ [SPEC-v2.1.3.md](./SPEC-v2.1.3.md)（egress 偽陽性）
- 該当コード: gate-engine.ts:123 / egress/policy.ts:6 / egress/fingerprint.ts:3 /
  conformance/guarantee-table.ts:45 / adapters/codex/runtime-entry.ts:45,110,160 /
  classify-tool.ts:104 / classify-subagent.ts:106
- 観測: `git push`/`curl` が現行契約で hint/deny 固定（158 tests 通過 = 契約として固定済み）
