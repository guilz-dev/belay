#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url))

function isManagedHookCommand(command, hookName) {
  if (typeof command !== 'string') {
    return false
  }
  if (command.includes(` ${hookName}`)) {
    return true
  }
  const encoded = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/iu)?.[1]
  return encoded
    ? Buffer.from(encoded, 'base64').toString('utf16le').includes(`'${hookName}'`)
    : false
}

const doctor = spawnSync(process.execPath, [cliPath, 'doctor', '--json'], {
  cwd: process.cwd(),
  encoding: 'utf8',
  timeout: 30_000,
})
if (doctor.error || doctor.status !== 0) {
  throw new Error(
    `Unable to inspect installed hooks: ${doctor.error?.message ?? (doctor.stderr || doctor.stdout)}`,
  )
}

const report = JSON.parse(doctor.stdout)
if (
  path.basename(report.hooksPath) !== 'hooks.json' ||
  path.basename(path.dirname(report.hooksPath)) !== '.cursor'
) {
  process.stdout.write('Cursor hook smoke check: skipped (another adapter is active)\n')
  process.exit(0)
}

const settings = JSON.parse(readFileSync(report.hooksPath, 'utf8'))
const entries = settings.hooks?.beforeSubmitPrompt
const command = Array.isArray(entries)
  ? entries.find((entry) => isManagedHookCommand(entry.command, 'belay-before-submit'))?.command
  : undefined
if (!command) {
  throw new Error(`Managed beforeSubmitPrompt hook is missing from ${report.hooksPath}`)
}

const result = spawnSync(command, {
  cwd: report.repoRoot,
  input: JSON.stringify({
    prompt: 'Belay installed hook smoke check',
    cwd: report.repoRoot,
    workspace_roots: [report.repoRoot],
  }),
  encoding: 'utf8',
  shell: true,
  timeout: 15_000,
})
if (result.error || result.status !== 0) {
  throw new Error(
    `Installed beforeSubmitPrompt hook failed: ${result.error?.message ?? result.stderr}`,
  )
}

let response
try {
  response = JSON.parse(result.stdout.trim())
} catch {
  throw new Error(`Installed beforeSubmitPrompt hook returned invalid JSON: ${result.stdout}`)
}
if (response.continue !== true) {
  throw new Error(
    `Installed beforeSubmitPrompt hook did not allow a harmless prompt: ${result.stdout}`,
  )
}
process.stdout.write('Cursor beforeSubmitPrompt hook: OK\n')

const auditCommand = Array.isArray(settings.hooks?.postToolUse)
  ? settings.hooks.postToolUse.find((entry) => isManagedHookCommand(entry.command, 'belay-audit'))
      ?.command
  : undefined
if (!auditCommand) {
  throw new Error(`Managed postToolUse audit hook is missing from ${report.hooksPath}`)
}

const marker = `belay-smoke-${randomBytes(8).toString('hex')}`
const since = new Date(Date.now() - 1000).toISOString()
const auditHook = spawnSync(auditCommand, {
  cwd: report.repoRoot,
  input: JSON.stringify({
    tool_name: marker,
    tool_input: { command: 'git status' },
    tool_output: 'Belay installed hook smoke check',
    cwd: report.repoRoot,
    success: true,
  }),
  encoding: 'utf8',
  shell: true,
  timeout: 15_000,
})
if (
  auditHook.error ||
  auditHook.status !== 0 ||
  /belay audit hook failed:/iu.test(auditHook.stderr)
) {
  throw new Error(
    `Installed postToolUse audit hook failed: ${auditHook.error?.message ?? auditHook.stderr}`,
  )
}

const query = spawnSync(
  process.execPath,
  [cliPath, 'audit', 'query', '--json', '--event', 'postToolUse', '--since', since],
  { cwd: report.repoRoot, encoding: 'utf8', timeout: 30_000 },
)
if (query.error || query.status !== 0) {
  throw new Error(`Unable to read smoke audit event: ${query.error?.message ?? query.stderr}`)
}
const records = JSON.parse(query.stdout).records
if (!Array.isArray(records) || !records.some((record) => record.toolName === marker)) {
  throw new Error(`Installed postToolUse hook did not write its smoke audit event (${marker})`)
}
process.stdout.write('Cursor postToolUse audit hook: OK\n')
