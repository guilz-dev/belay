import { accessSync, constants, existsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import type { BelayControlPlaneIsolationConfig } from './config.js'

export interface ControlPlaneIsolationReport {
  ok: boolean
  mode: BelayControlPlaneIsolationConfig['mode']
  controlPlaneDir: string
  issues: string[]
  agentWritable: boolean
  observedOwnerUid: number | null
}

function currentUid(): number | null {
  if (typeof process.getuid === 'function') {
    return process.getuid()
  }
  return null
}

export function verifyControlPlaneIsolation(
  controlPlaneDir: string,
  isolation: BelayControlPlaneIsolationConfig,
): ControlPlaneIsolationReport {
  const issues: string[] = []
  let agentWritable = false
  let observedOwnerUid: number | null = null

  if (isolation.mode === 'none') {
    return {
      ok: true,
      mode: isolation.mode,
      controlPlaneDir,
      issues,
      agentWritable: false,
      observedOwnerUid: null,
    }
  }

  if (!existsSync(controlPlaneDir)) {
    issues.push(`control plane directory does not exist: ${controlPlaneDir}`)
    return {
      ok: false,
      mode: isolation.mode,
      controlPlaneDir,
      issues,
      agentWritable: false,
      observedOwnerUid: null,
    }
  }

  try {
    const stats = statSync(controlPlaneDir)
    observedOwnerUid = stats.uid
    const uid = currentUid()
    if (isolation.mode === 'separate-user' && uid !== null && stats.uid === uid) {
      issues.push('control plane directory is owned by the current agent uid')
    }
    if (isolation.expectedOwnerUid !== undefined && stats.uid !== isolation.expectedOwnerUid) {
      issues.push(
        `control plane owner uid ${stats.uid} does not match expected ${isolation.expectedOwnerUid}`,
      )
    }
  } catch (error) {
    issues.push(error instanceof Error ? error.message : 'failed to stat control plane directory')
  }

  if (isolation.verifyAgentWritable) {
    const probePath = path.join(controlPlaneDir, '.belay-isolation-probe')
    try {
      mkdir(controlPlaneDir, { recursive: true })
      writeFileSync(probePath, 'probe\n', 'utf8')
      agentWritable = true
      try {
        unlinkSync(probePath)
      } catch {
        // best effort
      }
      issues.push('agent process can write to the control plane directory')
    } catch {
      agentWritable = false
      try {
        accessSync(controlPlaneDir, constants.W_OK)
        agentWritable = true
        issues.push('agent process has write access to the control plane directory')
      } catch {
        agentWritable = false
      }
    }
  }

  return {
    ok: issues.length === 0,
    mode: isolation.mode,
    controlPlaneDir,
    issues,
    agentWritable,
    observedOwnerUid,
  }
}
