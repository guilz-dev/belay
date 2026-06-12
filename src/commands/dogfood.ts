import path from 'node:path'

import { configPathFor, loadConfigFile, writeConfigFile } from '../config-io.js'
import { mergeConfig } from '../core/config.js'
import {
  isDogfoodConfig,
  loadOperationalInsights,
  readOq3SpikeStatus,
} from '../operational-insights.js'
import type { DogfoodOptions, DogfoodResult } from '../types.js'
import { metricsProject } from './metrics.js'

export async function dogfoodProject(options: DogfoodOptions = {}): Promise<DogfoodResult> {
  const repoRoot = path.resolve(options.targetDir ?? process.cwd())
  const adapter = options.adapter ?? 'cursor'
  const configPath = configPathFor(repoRoot, adapter)

  if (options.enforce) {
    return promoteDogfoodToEnforce(repoRoot, configPath, options.force === true, adapter)
  }

  const existing = await loadConfigFile(repoRoot, adapter)
  const spikeOnPrompt = options.spikeOnPrompt !== false
  const updated = mergeConfig({
    ...existing,
    mode: 'audit',
    policy: {
      ...existing.policy,
      unknownLocalEffect: 'deny',
    },
    controlPlane: {
      ...existing.controlPlane,
      spikeOnPrompt,
    },
  })
  await writeConfigFile(repoRoot, updated, adapter)

  return {
    ok: true,
    repoRoot,
    configPath,
    mode: updated.mode,
    unknownLocalEffect: updated.policy.unknownLocalEffect,
    spikeOnPrompt: updated.controlPlane.spikeOnPrompt === true,
    message: [
      'Dogfood mode enabled: audit + policy.unknownLocalEffect deny.',
      spikeOnPrompt
        ? 'OQ3 spikeOnPrompt is enabled — submit a chat prompt in Cursor to validate control-plane access.'
        : 'OQ3 spikeOnPrompt is disabled.',
      'Run agent-belay metrics after normal agent work, then agent-belay dogfood --enforce when ready.',
    ].join(' '),
  }
}

async function promoteDogfoodToEnforce(
  repoRoot: string,
  configPath: string,
  force: boolean,
  adapter: DogfoodOptions['adapter'] = 'cursor',
): Promise<DogfoodResult> {
  const existing = await loadConfigFile(repoRoot, adapter)
  const metrics = await metricsProject({ targetDir: repoRoot })

  if (!force && !metrics.dogfood.readyForEnforce) {
    return {
      ok: false,
      repoRoot,
      configPath,
      mode: existing.mode,
      unknownLocalEffect: existing.policy.unknownLocalEffect,
      spikeOnPrompt: existing.controlPlane.spikeOnPrompt === true,
      message: [
        'Dogfood metrics do not recommend enforce yet.',
        ...metrics.dogfood.notes,
        'Re-run agent-belay metrics, tune overrides.allow, or pass --force to override.',
      ].join(' '),
    }
  }

  if (!force && existing.controlPlane.spikeOnPrompt) {
    const spike = await readOq3SpikeStatus(existing)
    if (!spike) {
      return {
        ok: false,
        repoRoot,
        configPath,
        mode: existing.mode,
        unknownLocalEffect: existing.policy.unknownLocalEffect,
        spikeOnPrompt: true,
        message:
          'OQ3 spike not recorded. Submit a chat prompt in Cursor to run the control-plane spike, or pass --force to override.',
      }
    }
    if (!spike.ok) {
      return {
        ok: false,
        repoRoot,
        configPath,
        mode: existing.mode,
        unknownLocalEffect: existing.policy.unknownLocalEffect,
        spikeOnPrompt: true,
        message: [
          `OQ3 spike failed at ${spike.path}.`,
          spike.error ?? 'Control-plane filesystem may be blocked from hook context.',
          'Resolve the issue or pass --force to override.',
        ].join(' '),
      }
    }
  }

  const updated = mergeConfig({
    ...existing,
    mode: 'enforce',
    controlPlane: {
      ...existing.controlPlane,
      spikeOnPrompt: false,
    },
  })
  await writeConfigFile(repoRoot, updated, adapter)

  return {
    ok: true,
    repoRoot,
    configPath,
    mode: updated.mode,
    unknownLocalEffect: updated.policy.unknownLocalEffect,
    spikeOnPrompt: false,
    message: force
      ? 'Switched to enforce mode (forced). Fail-closed shell policy remains active via policy.unknownLocalEffect deny.'
      : 'Switched to enforce mode. Fail-closed shell policy remains active via policy.unknownLocalEffect deny.',
  }
}

export function formatDogfoodResult(result: DogfoodResult): string {
  return `${result.message}\n`
}

export { isDogfoodConfig, loadOperationalInsights }
