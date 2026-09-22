# 監査ログ（versioned audit log）運用メモ

## 正本

- Gate 書き込み先は **`{audit.logPath のディレクトリ}/v{installedRuntime}.log`**（0.12.1 以降）。
- 設定の `audit.logPath`（例: `.cursor/belay/audit.ndjson`）は **ディレクトリ解決用**。ファイル名 `audit.ndjson` 自体は更新されない場合がある。

## CLI

- **`belay report` / `metrics` / `quality` / `audit`** は、Cursor では hook と同様に **routing repo root**（`.cursor/belay.config.json` があるディレクトリ）へ `--target` / cwd を正規化する。
- 子ディレクトリから実行する例:

```bash
belay report --target /path/to/parent-or-child-under-anchor
belay where --target /path/to/child   # requested target と config anchor を表示
```

## 横断分析

- 通常: インストール済み runtime 世代の log のみ。
- Forensic: `belay audit versions`、`--audit-version`、`--all-versions`。

## readiness

- アクティブ世代: **`v{runtime}.log.readiness.json`**
- 旧 `audit.ndjson.readiness.json` は legacy cohort 用（参照しない）。
