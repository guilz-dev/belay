import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const JUDGE_SESSION_KILL_FILE = 'judge-session-kill.json'

export interface JudgeSessionKillSwitchRecord {
  triggered: boolean
  at: string
  reason?: string
}

export function judgeSessionKillSwitchPath(stateDir: string): string {
  return path.join(stateDir, JUDGE_SESSION_KILL_FILE)
}

export async function readJudgeSessionKillSwitch(
  stateDir: string,
): Promise<JudgeSessionKillSwitchRecord | null> {
  const filePath = judgeSessionKillSwitchPath(stateDir)
  if (!existsSync(filePath)) {
    return null
  }
  try {
    const raw = JSON.parse(await readFile(filePath, 'utf8')) as JudgeSessionKillSwitchRecord
    return raw.triggered === true ? raw : null
  } catch {
    return null
  }
}

export async function isJudgeSessionKillSwitchPersisted(stateDir: string): Promise<boolean> {
  const record = await readJudgeSessionKillSwitch(stateDir)
  return record?.triggered === true
}

export async function persistJudgeSessionKillSwitch(
  stateDir: string,
  reason = 'shadow_mismatch',
): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const record: JudgeSessionKillSwitchRecord = {
    triggered: true,
    at: new Date().toISOString(),
    reason,
  }
  await writeFile(judgeSessionKillSwitchPath(stateDir), JSON.stringify(record), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

export async function clearJudgeSessionKillSwitch(stateDir: string): Promise<void> {
  const filePath = judgeSessionKillSwitchPath(stateDir)
  if (!existsSync(filePath)) {
    return
  }
  await unlink(filePath)
}
