# 0004 Shell scannerを単一解析結果へ段階統合する

## 種別

技術的負債（今回は実装しない）

## 正本

このMarkdownが唯一の仕様正本である。GitHub Issueは索引であり、仕様、スコープ、
受け入れ基準をIssue本文へ複製しない。変更時はこのMarkdownを先に更新する。

## 背景

`tokenizeShell`、`splitStructuralShellSegments`、`detectUnparseableShell`、command
substitution scannerが独立してshell文字列を走査している。そのためquote、escape、
構造境界の解釈がdriftできる。今回のargv境界改善では互換facadeを残し、scanner統合は
影響範囲とデグレリスクが大きいため見送る。

## 対象

- `src/core/shell-tokenizer.ts`
- `src/core/verdict/parser.ts`のstructural segment scanner
- `src/core/shell-unparseable.ts`
- `src/core/shell-substitution.ts`
- 上記の解析結果を利用するEffectPlan lowering

## 着手トリガー

- 同一shell入力に対するscanner間の解釈差が原因の不具合が再発した。
- 1つのshell構文対応に3箇所以上のscanner変更が必要になった。
- structured lexerのdecision-diff corpusで解釈差が継続的に観測された。

## 移行方針

1. 単一の`ShellParseResult`を追加し、既存scannerとshadow比較する。
2. ASKからALLOWへ弱まる差分をゼロにする。
3. recursive argv、structural split、substitution、unparseableの順にconsumerを移す。
4. すべてのconsumer移行後にだけ旧scannerを削除する。

## 非目標

- command allowlistの導入
- 未知構文の推測許可
- 一括置換
- shell完全互換parserの自作

## 受け入れ基準

- [ ] 1入力を1回解析した`ShellParseResult`から全consumerが判定を得る。
- [ ] malformed、quote、escape、substitution、operator境界の解釈が一意である。
- [ ] EffectPlan decision-diffでASKからALLOWへの差分がない。
- [ ] dynamic／unknown入力はindeterminateを維持する。
- [ ] 旧scanner削除前に新旧shadow corpusの差分がレビュー済みである。
- [ ] ADR-004／ADR-005の権威境界を維持する。

## 関連資料

- [Shell argv境界解析と構造化tokenの段階導入](../superpowers/specs/2026-08-26-shell-argv-structured-token-design.md)
- [ADR-004: EffectPlan authority](../adr/ADR-004-effectplan-shell-authority.md)
- [ADR-005: Command allowlist prohibition](../adr/ADR-005-command-allowlist-prohibition.md)
