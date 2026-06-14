import path from 'node:path'
import { applyConfigPreset, type ConfigPresetName } from '../presets.js'
import type { BelayConfigV3 } from './config.js'
import { DEFAULT_CONFIG_V3, mergeConfig, rejectTeamLayerJudgeSecrets } from './config.js'

export type ConfigLayerSource = 'builtin' | 'team' | 'repo' | 'protected'

export interface ConfigProvenanceEntry {
  path: string
  source: ConfigLayerSource
}

export interface LayeredConfigResult {
  config: BelayConfigV3
  provenance: ConfigProvenanceEntry[]
}

export interface TeamConfigFile {
  preset?: ConfigPresetName
  config?: Record<string, unknown>
}

export function teamConfigPath(
  homedir: () => string = () => process.env.HOME ?? process.env.USERPROFILE ?? '',
): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  const base = xdg || path.join(homedir(), '.config')
  return path.join(base, 'agent-belay', 'team.config.json')
}

function applyProtectedLayer(config: BelayConfigV3, builtin: BelayConfigV3): BelayConfigV3 {
  const controlPlane = { ...config.controlPlane }

  if (builtin.controlPlane.enabled && controlPlane.enabled === false) {
    controlPlane.enabled = true
  }

  if (builtin.controlPlane.integrity === 'hash-pinned' && controlPlane.integrity === 'none') {
    controlPlane.integrity = 'hash-pinned'
  }

  return {
    ...config,
    controlPlane,
  }
}

function asV3Layer(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') {
    return { version: 3 }
  }
  return { version: 3, ...(raw as Record<string, unknown>) }
}

function mergeConfigLayer(base: BelayConfigV3, layer: Record<string, unknown>): BelayConfigV3 {
  const merged = mergeConfig(layer, base)
  if (!layer.policy) {
    return { ...merged, policy: base.policy }
  }
  return merged
}

export function resolveLayeredConfig(params: {
  repoConfig: unknown
  adapterDefaults: BelayConfigV3
  teamConfig?: TeamConfigFile | Record<string, unknown> | null
  teamConfigPath?: string
  repoConfigPath?: string
}): LayeredConfigResult {
  const provenance: ConfigProvenanceEntry[] = [{ path: '(builtin)', source: 'builtin' }]

  let config = mergeConfig({}, params.adapterDefaults)

  if (params.teamConfig) {
    const teamFile = params.teamConfig as TeamConfigFile
    const teamRaw = teamFile.preset
      ? applyConfigPreset(teamFile.preset, teamFile.config ?? {})
      : (teamFile.config ?? params.teamConfig)
    rejectTeamLayerJudgeSecrets(
      (teamRaw as { judge?: Parameters<typeof rejectTeamLayerJudgeSecrets>[0] }).judge,
      'team',
    )
    config = mergeConfigLayer(config, asV3Layer(teamRaw))
    provenance.push({
      path: params.teamConfigPath ?? teamConfigPath(),
      source: 'team',
    })
  }

  config = mergeConfigLayer(config, asV3Layer(params.repoConfig))
  if (params.repoConfigPath) {
    provenance.push({ path: params.repoConfigPath, source: 'repo' })
  }

  const protectedConfig = applyProtectedLayer(config, DEFAULT_CONFIG_V3)
  if (JSON.stringify(protectedConfig) !== JSON.stringify(config)) {
    provenance.push({ path: '(protected-layer)', source: 'protected' })
    config = protectedConfig
  }

  return { config, provenance }
}
