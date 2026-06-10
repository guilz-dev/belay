import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { defaultControlPlaneDir } from './config.js'

export interface ControlPlaneSpikeResult {
  ok: boolean
  controlPlaneDir: string
  testFile: string
  home: string
  xdgConfigHome: string | null
  cwd: string
  wrote: boolean
  readBack: string | null
  error?: string
}

/**
 * OQ3 spike: verify hook-like Node context can read/write the user control-plane dir.
 * Does not require Cursor; simulates the filesystem access pattern for beforeSubmitPrompt.
 */
export async function persistControlPlaneSpikeResult(
  result: ControlPlaneSpikeResult,
  env: NodeJS.ProcessEnv = process.env,
  homedir: () => string = () => env.HOME ?? '',
  controlPlaneDir?: string,
): Promise<string> {
  const outputPath = path.join(
    controlPlaneDir ?? defaultControlPlaneDir(env, homedir),
    'oq3-spike-last.json',
  )
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(
    outputPath,
    `${JSON.stringify({ ...result, recordedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8',
  )
  return outputPath
}

export async function runControlPlaneSpike(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
  homedir: () => string = () => env.HOME ?? '',
  controlPlaneDirOverride?: string,
): Promise<ControlPlaneSpikeResult> {
  const controlPlaneDir = controlPlaneDirOverride ?? defaultControlPlaneDir(env, homedir)
  const testFile = path.join(controlPlaneDir, 'oq3-spike.json')
  const payload = {
    timestamp: new Date().toISOString(),
    cwd,
    pid: process.pid,
  }

  const base: ControlPlaneSpikeResult = {
    ok: false,
    controlPlaneDir,
    testFile,
    home: homedir(),
    xdgConfigHome: env.XDG_CONFIG_HOME?.trim() || null,
    cwd,
    wrote: false,
    readBack: null,
  }

  try {
    await mkdir(controlPlaneDir, { recursive: true })
    await writeFile(testFile, `${JSON.stringify(payload)}\n`, 'utf8')
    const readBack = await readFile(testFile, 'utf8')
    const parsed = JSON.parse(readBack.trim()) as { cwd?: string }
    await rm(testFile, { force: true })

    return {
      ...base,
      ok: parsed.cwd === cwd && existsSync(controlPlaneDir),
      wrote: true,
      readBack: readBack.trim(),
    }
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
