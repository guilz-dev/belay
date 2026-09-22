import { spawnSync } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const scriptPath = fileURLToPath(
  new URL('../../.cursor/skills/update-local-belay/scripts/sync-and-upgrade.sh', import.meta.url),
)
const smokeScriptPath = fileURLToPath(
  new URL('../../scripts/smoke-installed-cursor-hook.mjs', import.meta.url),
)

describe('sync-and-upgrade', () => {
  it.skipIf(process.platform === 'win32')(
    'uses the source-built CLI and fails the installed-hook check when its runner is missing',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'belay-source-upgrade-'))
      const binDir = path.join(root, 'bin')
      const distDir = path.join(root, 'dist')
      const scriptsDir = path.join(root, 'scripts')
      const logPath = path.join(root, 'calls.log')
      const auditPayloadPath = path.join(root, 'audit-payload.json')
      const hooksPath = path.join(root, '.cursor', 'hooks.json')
      const runnerPath = path.join(root, '.cursor', 'hooks', 'belay-runner')
      const hooksSettings = {
        hooks: {
          beforeSubmitPrompt: [{ command: `${runnerPath} belay-before-submit`, failClosed: true }],
          postToolUse: [{ command: `${runnerPath} belay-audit postToolUse` }],
        },
      }
      try {
        await mkdir(binDir)
        await mkdir(distDir)
        await mkdir(scriptsDir)
        await copyFile(smokeScriptPath, path.join(scriptsDir, 'smoke-installed-cursor-hook.mjs'))
        await mkdir(path.dirname(runnerPath), { recursive: true })
        await writeFile(path.join(root, 'package.json'), '{"name": "@guilz-dev/belay"}\n')
        await writeFile(hooksPath, `${JSON.stringify(hooksSettings)}\n`)
        await writeFile(
          runnerPath,
          '#!/bin/sh\nif [ "$1" = "belay-audit" ]; then\n  if [ "$BELAY_TEST_SKIP_AUDIT_WRITE" = "1" ]; then cat >/dev/null; rm -f "$BELAY_TEST_AUDIT_PAYLOAD"; else cat > "$BELAY_TEST_AUDIT_PAYLOAD"; fi\n  printf "audit\\n" >> "$BELAY_TEST_LOG"\n  printf \'{}\\n\'\nelse\n  cat >/dev/null\n  printf "hook\\n" >> "$BELAY_TEST_LOG"\n  printf \'{"continue":true}\\n\'\nfi\n',
        )
        await chmod(runnerPath, 0o755)
        await writeFile(
          path.join(binDir, 'git'),
          '#!/bin/sh\ncase "$*" in\n  "rev-parse --show-toplevel") printf "%s\\n" "$BELAY_TEST_ROOT" ;;\n  "rev-parse HEAD") printf "same\\n" ;;\n  "status --porcelain") ;;\n  *) exit 0 ;;\nesac\n',
        )
        await writeFile(path.join(binDir, 'pnpm'), '#!/bin/sh\nexit 0\n')
        await writeFile(
          path.join(binDir, 'powershell'),
          '#!/bin/sh\ncat >/dev/null\nprintf \'{"continue":true}\\n\'\n',
        )
        await writeFile(
          path.join(binDir, 'belay'),
          '#!/bin/sh\nprintf "stale binary\\n" >> "$BELAY_TEST_LOG"\nexit 91\n',
        )
        await Promise.all(
          ['git', 'pnpm', 'belay', 'powershell'].map((name) =>
            chmod(path.join(binDir, name), 0o755),
          ),
        )
        await writeFile(
          path.join(distDir, 'cli.js'),
          'const fs = require("node:fs")\nconst args = process.argv.slice(2).join(" ")\nif (args === "doctor --json") { console.log(JSON.stringify({ ok: true, repoRoot: process.env.BELAY_TEST_ROOT, hooksPath: process.env.BELAY_TEST_HOOKS })) } else if (args.startsWith("audit query --json")) { const payload = fs.existsSync(process.env.BELAY_TEST_AUDIT_PAYLOAD) ? JSON.parse(fs.readFileSync(process.env.BELAY_TEST_AUDIT_PAYLOAD, "utf8")) : null; console.log(JSON.stringify({ subcommand: "query", records: payload ? [{ event: "postToolUse", toolName: payload.tool_name }] : [] })) } else { fs.appendFileSync(process.env.BELAY_TEST_LOG, args + "\\n") }\n',
        )

        const env = {
          ...process.env,
          PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
          BELAY_TEST_ROOT: root,
          BELAY_TEST_LOG: logPath,
          BELAY_TEST_HOOKS: hooksPath,
          BELAY_TEST_AUDIT_PAYLOAD: auditPayloadPath,
        }
        const result = spawnSync('bash', [scriptPath], {
          cwd: root,
          env,
          encoding: 'utf8',
          timeout: 15_000,
        })

        expect(result.status, result.stderr).toBe(0)
        expect((await readFile(logPath, 'utf8')).trim().split('\n')).toEqual([
          'upgrade --with-skill',
          'doctor',
          '--version',
          'hook',
          'audit',
        ])

        const encodedPrompt = Buffer.from(
          "& 'C:\\Hook Dir\\belay-runner.ps1' 'belay-before-submit'",
          'utf16le',
        ).toString('base64')
        await writeFile(
          hooksPath,
          `${JSON.stringify({ ...hooksSettings, hooks: { ...hooksSettings.hooks, beforeSubmitPrompt: [{ command: `powershell -EncodedCommand ${encodedPrompt}`, failClosed: true }] } })}\n`,
        )
        const encoded = spawnSync(
          'node',
          [path.join(scriptsDir, 'smoke-installed-cursor-hook.mjs')],
          {
            cwd: root,
            env,
            encoding: 'utf8',
            timeout: 15_000,
          },
        )
        expect(encoded.status, encoded.stderr).toBe(0)
        await writeFile(hooksPath, `${JSON.stringify(hooksSettings)}\n`)

        const noAudit = spawnSync(
          'node',
          [path.join(scriptsDir, 'smoke-installed-cursor-hook.mjs')],
          {
            cwd: root,
            env: { ...env, BELAY_TEST_SKIP_AUDIT_WRITE: '1' },
            encoding: 'utf8',
            timeout: 15_000,
          },
        )
        expect(noAudit.status).not.toBe(0)
        expect(noAudit.stderr).toContain('did not write its smoke audit event')

        await rm(runnerPath)
        const missingRunner = spawnSync(
          'node',
          [path.join(scriptsDir, 'smoke-installed-cursor-hook.mjs')],
          {
            cwd: root,
            env,
            encoding: 'utf8',
            timeout: 15_000,
          },
        )
        expect(missingRunner.status).not.toBe(0)
        expect(missingRunner.stderr).toContain('Installed beforeSubmitPrompt hook failed')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
