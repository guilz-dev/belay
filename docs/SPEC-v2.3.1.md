# agent-belay SPEC v2.3.1 — 改名（`@guilz-dev/belay`）と初 npm 公開（v0.0.1）

Status: **Release engineering**（spec-first。改名 + 初公開の手順を規範化）
Builds on: SPEC-v2.3（初 OSS リリース）。本書は v2.3 の**配布固有名・公開**を確定する。
Repo: https://github.com/guilz-dev/belay （作成済み）

---

## 0. Summary

`agent-belay` は `mikepenz/agent-belay`（別プロダクト）と GitHub・検索で衝突するため改名する。
**最強資産 = `belay` の比喩（命綱）を保ったまま、配布固有名だけを差別化**する:

- **npm パッケージ名**: `agent-belay` → **`@guilz-dev/belay`**（scope で衝突回避。fence 語は足さない）
- **CLI コマンド（bin）**: `agent-belay` → **`belay`**（短く、パッケージ名と独立）
- **GitHub repo**: `guilz-dev/agent-belay` → **`guilz-dev/belay`**
- **skill / slash / repo パス**: **`belay` のまま**（`name: belay`、`/belay why`、`.cursor/belay/`、
  `/belay-approve` は変更しない）

そして本リリースを **`@guilz-dev/belay` v0.0.1** として**初めて npm 公開**する。

## 1. バージョンの対応（SPEC 系列 ≠ npm semver）

| 軸 | 値 | 意味 |
| --- | --- | --- |
| SPEC 系列（設計史） | **v2.3.1** | restorability floor の設計ライン（v2.0〜）の続き |
| 公開 npm semver | **`@guilz-dev/belay@0.0.1`** | **初の公開リリース**。`0.0.x` = 早期・不安定を正直に示す |

- 内部 `package.json` は `1.0.0`（未公開）だったが、**npm に公開実績が無い**ため、正直な初公開として
  **`0.0.1` にリセット**する。
- 以後の公開は 0.0.x で反復し、v2.3 の全機能（命綱 recovery / 可視化）が揃った時点で 0.x→ semver を進める。

## 2. v0.0.1 の中身（何を公開し、何を後送りにするか）

**公開する（実装済み）**:
- restorability floor（Tier0/Tier1、concept conformance: v2.1.2/v2.1.3/v2.1.4 反映済み）。
- skill front-door + scope（v2.2: R-S1〜S5）。
- adapters: **Cursor / Claude = 通常出荷、Codex = experimental 出荷**（doctor が残存注意点表示）。

**後送り（v2.3 の残り・以降の 0.0.x）**:
- WS-Visible（③ 可視化）/ WS-Recover（① 命綱 recover）。**v0.0.1 には含めない**。
- ② 上流ディシプリン（v2.4 候補）。managed Codex / plugin 配布（出荷後）。

> v0.0.1 は「**名前を確定し、床 + 配布を早期に出す**」リリース。命綱(recover)・可視化は次以降。
> README/タグラインで「early / 0.0.x」「Codex experimental」を**正直に明示**する。

## 3. 改名要件

### R-RN1 — npm パッケージ名 `@guilz-dev/belay`（MUST）
- `package.json` `name` を `@guilz-dev/belay` に。`publishConfig.access: public`（既設・**scoped public に必須**）。

### R-RN2 — bin コマンドは `belay`（MUST）
- `package.json` `bin` を `{ "belay": "./dist/cli.js" }` に。グローバル導入後は `belay init` /
  `belay doctor` / `belay explain` 等で動く（scope を打たない）。
- `npx @guilz-dev/belay init` は初回/未導入時の形として docs に記す。

### R-RN3 — GitHub repo / メタ（MUST）
- `repository.url` を `https://github.com/guilz-dev/belay.git` に。README バッジ・リンクも追従。
- ロゴ等のファイル名 `agent-belay-logo.png` は任意で `belay-logo.png` に（低優先）。

### R-RN4 — skill / slash / repo パスは `belay` 維持（MUST）
- `name: belay`、`/belay why`・`/belay-approve`、`.cursor/belay/`・`.claude/belay/`・`.codex/belay/`、
  承認 token prefix は**変更しない**（既に短名 `belay`）。
- skill 配布は `npx skills add guilz-dev/belay --skill belay -a <agent>`。

### R-RN5 — `agent-belay` 文字列参照の置換（MUST）
- **機能参照**（ユーザが打つ/メッセージに出るコマンド）を `belay` に置換:
  - docs/SKILL.md/README の `npx agent-belay …` → `npx @guilz-dev/belay …`（初回）/ `belay …`（導入後）。
  - 実行時メッセージ「Run `agent-belay doctor`」等 → 「Run `belay doctor`」。
- user-level control-plane パス `~/.config/agent-belay/` → `~/.config/belay/`（一貫性・未公開ゆえ移行不要・低優先）。
- 内部識別子・コメントの `agent-belay` は段階的に可（機能に出ないものは急がない）。

### R-RN6 — 移行 alias は不要（MUST 明記）
- `agent-belay` は **npm に一度も公開されていない**ため、既存ユーザ・互換 alias・deprecation 期間は
  **不要**。本書は「初公開前の改名」であり後方互換負債を持たない。

## 4. 公開要件（v0.0.1）

### R-PUB1 — package.json 公開設定（MUST）
- `name: @guilz-dev/belay` / `version: 0.0.1` / `bin: { belay }` / `publishConfig.access: public` /
  `files`（dist, skills, docs, README, LICENSE）/ `repository` 更新。`private` を設定しない。

### R-PUB2 — 公開コマンド（MUST）
- `pnpm build`（dist + bundle 生成）→ `npm publish`（scoped public は `--access public`、
  publishConfig 既設なら自動）。タグは `v0.0.1`。

### R-PUB3 — 正直な README / タグライン（MUST）
- タグライン: 「**LLM / AI SDK agent 向けの restorability floor（取り消せない×破滅的だけ止める）**」。
  ドメイン（AI agent）は**名前でなくタグライン**で示す（§ 命名方針）。
- 0.0.x の早期性・**Codex experimental**・recover/可視化が未搭載であることを明示。
- 安全境界（skill-only=助言 / `init` 必須）と scope（project 既定 / global 明示）を記載。

### R-PUB4 — 出荷前ゲート（v2.3 §7 の v0.0.1 適用）
- **FN=0 + FP→0 + guarantee 実行照合が緑**（概念整合の証明、R-REL1）。
- WS-Front 残ゲート（R-S2 wizard / G-B1 記録）close。
- `npm pack` の中身確認（dist/skills/docs が含まれ、不要物が無い）。
- `npx @guilz-dev/belay init`（または tarball 直）で `doctor` 緑が再現（Cursor/Claude）。

## 5. Done（v0.0.1 公開可）

1. R-RN1〜R-RN5 反映（name/bin/repo/参照置換、skill/パスは `belay` 維持）。
2. R-PUB1〜R-PUB4 充足（公開設定・ビルド・正直 README・出荷前ゲート緑）。
3. `@guilz-dev/belay@0.0.1` を npm 公開、GitHub `guilz-dev/belay` に `v0.0.1` タグ。
4. recover / 可視化 / ②ディシプリン は未搭載と明記（以降の 0.0.x / v2.4）。

## 参照
- 親: [SPEC-v2.3.md](./SPEC-v2.3.md)（初 OSS リリース）
- 命名検討: 本リリースで `@guilz-dev/belay`（scoped）+ bin `belay` に確定。`agent-belay`（mikepenz 衝突）
  / fence 語（gate/guard）/ 説明的すぎる `ai-/llm-` は不採用。
