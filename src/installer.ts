import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  DEFAULT_CONFIG,
  EMPTY_APPROVALS,
  getManagedHookEvents,
  type ManagedHookDefinition,
} from './defaults.js'
import { buildRunnerScript, buildWindowsRunnerScript } from './node-resolution.js'
import {
  renderAuditHook,
  renderBeforeSubmitHook,
  renderConfig,
  renderRuntimeCore,
  renderShellGateHook,
  renderToolGateHook,
} from './templates.js'
import type { HookEntry, HooksFile, InitOptions } from './types.js'

const BUNDLED_SKILL_TEMPLATE_URL = new URL('../skills/belay/SKILL.md', import.meta.url)
const BUNDLED_COMMAND_TEMPLATE_URL = new URL('../skills/belay/belay-approve.md', import.meta.url)

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

async function writeTextFile(filePath: string, content: string, executable = false): Promise<void> {
  await ensureDir(path.dirname(filePath))
  await writeFile(filePath, content, 'utf8')
  if (executable) {
    await chmod(filePath, 0o755)
  }
}

async function writeJsonIfMissing(filePath: string, value: unknown): Promise<void> {
  if (await pathExists(filePath)) {
    return
  }
  await ensureDir(path.dirname(filePath))
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeTextIfMissing(filePath: string, content: string): Promise<void> {
  if (await pathExists(filePath)) {
    return
  }
  await ensureDir(path.dirname(filePath))
  await writeFile(filePath, content, 'utf8')
}

async function readBundledTemplate(fileUrl: URL): Promise<string> {
  try {
    return await readFile(fileUrl, 'utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown read failure.'
    throw new Error(`Bundled template missing at ${fileUrl.pathname}: ${detail}`)
  }
}

async function loadHooksFile(hooksPath: string): Promise<HooksFile> {
  if (!existsSync(hooksPath)) {
    return { version: 1, hooks: {} }
  }
  const raw = await readFile(hooksPath, 'utf8')
  try {
    const parsed = JSON.parse(raw) as HooksFile
    if (!parsed || typeof parsed !== 'object' || typeof parsed.version !== 'number') {
      throw new Error('hooks.json must contain a numeric version field.')
    }
    if (!parsed.hooks || typeof parsed.hooks !== 'object') {
      throw new Error('hooks.json must contain an object hooks field.')
    }
    return parsed
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'Unknown JSON parse failure.'
    throw new Error(`Invalid hooks.json at ${hooksPath}: ${detail}`)
  }
}

function entryMatches(existing: HookEntry, expected: HookEntry): boolean {
  return existing.command === expected.command && existing.matcher === expected.matcher
}

function mergeHookEntry(
  current: HookEntry[] | undefined,
  expected: HookEntry,
  placement: 'prepend' | 'append',
) {
  const entries = Array.isArray(current) ? [...current] : []
  const filtered = entries.filter((entry) => !entryMatches(entry, expected))
  if (placement === 'prepend') {
    return [expected, ...filtered]
  }
  return [...filtered, expected]
}

function mergeHooksFile(current: HooksFile): HooksFile {
  const next: HooksFile = {
    version: current.version || 1,
    hooks: { ...current.hooks },
  }
  const managedEntries = Object.entries(getManagedHookEvents(process.platform)) as Array<
    [string, ManagedHookDefinition]
  >
  for (const [eventName, definition] of managedEntries) {
    next.hooks[eventName] = mergeHookEntry(
      current.hooks[eventName],
      {
        command: definition.command,
        matcher: definition.matcher,
      },
      definition.placement,
    )
  }
  return next
}

export async function initProject(
  options: InitOptions = {},
): Promise<{ repoRoot: string; withSkill: boolean }> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const withSkill = options.withSkill === true || options.nightly === true
  const cursorDir = path.join(repoRoot, '.cursor')
  const hooksDir = path.join(cursorDir, 'hooks')
  const belayDir = path.join(cursorDir, 'belay')
  const runtimeDir = path.join(belayDir, 'runtime')
  const skillsDir = path.join(cursorDir, 'skills', 'belay')
  const commandsDir = path.join(cursorDir, 'commands')
  const hooksPath = path.join(cursorDir, 'hooks.json')
  const hooksFile = await loadHooksFile(hooksPath)
  const merged = mergeHooksFile(hooksFile)

  await ensureDir(hooksDir)
  await ensureDir(runtimeDir)
  await ensureDir(belayDir)

  await writeTextFile(path.join(cursorDir, 'belay.config.json'), renderConfig(DEFAULT_CONFIG))
  await writeTextFile(path.join(hooksDir, 'belay-before-submit.mjs'), renderBeforeSubmitHook())
  await writeTextFile(path.join(hooksDir, 'belay-shell-gate.mjs'), renderShellGateHook())
  await writeTextFile(path.join(hooksDir, 'belay-tool-gate.mjs'), renderToolGateHook())
  await writeTextFile(path.join(hooksDir, 'belay-audit.mjs'), renderAuditHook())
  await writeTextFile(path.join(runtimeDir, 'core.mjs'), renderRuntimeCore(DEFAULT_CONFIG))
  await writeTextFile(
    path.join(hooksDir, 'belay-runner'),
    buildRunnerScript(process.execPath),
    true,
  )
  await writeTextFile(
    path.join(hooksDir, 'belay-runner.cmd'),
    buildWindowsRunnerScript(process.execPath),
  )

  await writeJsonIfMissing(path.join(belayDir, 'pending-approvals.json'), EMPTY_APPROVALS)
  await writeJsonIfMissing(path.join(belayDir, 'approved-approvals.json'), EMPTY_APPROVALS)
  await writeTextIfMissing(path.join(belayDir, 'audit.ndjson'), '')

  if (withSkill) {
    await ensureDir(skillsDir)
    await ensureDir(commandsDir)
    const bundledSkill = await readBundledTemplate(BUNDLED_SKILL_TEMPLATE_URL)
    const bundledCommand = await readBundledTemplate(BUNDLED_COMMAND_TEMPLATE_URL)
    await writeTextFile(path.join(skillsDir, 'SKILL.md'), bundledSkill)
    await writeTextFile(path.join(commandsDir, 'belay-approve.md'), bundledCommand)
  }

  await writeFile(hooksPath, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')

  return { repoRoot, withSkill }
}

export { loadHooksFile, mergeHooksFile }
