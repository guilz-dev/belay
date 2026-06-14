import { stdin as input, stdout as output } from 'node:process'
import readline from 'node:readline/promises'
import {
  isJudgeProviderId,
  JUDGE_PROVIDER_IDS,
  type JudgeProviderId,
} from '../core/verdict/judge-catalog.js'
import { initProject } from '../installer.js'
import type { AdapterName, InitOptions } from '../types.js'

export interface WizardAnswers {
  adapter: AdapterName
  scope: 'project' | 'global'
  withSkill: boolean
  judgeProviderId: JudgeProviderId
  judgeCredentialMode?: 'project' | 'apiKey'
  judgeEndpoint?: string
  acceptCloud: boolean
  dogfood: boolean
}

export function parseAdapter(value: string | undefined): AdapterName {
  const normalized = (value?.trim() || 'cursor').toLowerCase()
  if (normalized === 'claude' || normalized === 'codex' || normalized === 'cursor') {
    return normalized
  }
  throw new Error(`Unknown adapter: ${value ?? '(empty)'}`)
}

export function parseScope(value: string | undefined): 'project' | 'global' {
  const normalized = (value?.trim() || 'project').toLowerCase()
  if (normalized === 'global' || normalized === 'project') {
    return normalized
  }
  throw new Error(`Unknown scope: ${value ?? '(empty)'}`)
}

export function parseYesNo(value: string | undefined, defaultValue: boolean): boolean {
  const normalized = (value?.trim() || (defaultValue ? 'y' : 'n')).toLowerCase()
  if (['y', 'yes', 'true', '1'].includes(normalized)) {
    return true
  }
  if (['n', 'no', 'false', '0'].includes(normalized)) {
    return false
  }
  return defaultValue
}

export function parseJudgeProviderId(
  value: string | undefined,
  defaultId: JudgeProviderId,
): JudgeProviderId {
  const normalized = (value?.trim() || defaultId).toLowerCase()
  if (isJudgeProviderId(normalized)) {
    return normalized
  }
  throw new Error(`Unknown judge provider: ${value ?? '(empty)'}`)
}

export function buildInitOptionsFromWizard(
  answers: WizardAnswers,
  targetDir?: string,
): InitOptions {
  return {
    targetDir,
    adapter: answers.adapter,
    scope: answers.scope,
    withSkill: answers.withSkill,
    judgeProviderId: answers.judgeProviderId,
    judgeEndpoint: answers.judgeEndpoint,
    judgeCredentialMode: answers.judgeCredentialMode,
    acceptCloudJudge: answers.acceptCloud,
    dogfood: answers.dogfood,
  }
}

export async function runInitWizard(options: { targetDir?: string } = {}) {
  const rl = readline.createInterface({ input, output })
  try {
    output.write('belay init wizard\n')
    const adapter = parseAdapter(await rl.question('Adapter [cursor | claude | codex] (cursor): '))
    const scope = parseScope(await rl.question('Install scope [project | global] (project): '))
    const withSkill = parseYesNo(
      await rl.question('Install SKILL.md and slash commands? [y | n] (y): '),
      true,
    )
    const judgeProviderId = parseJudgeProviderId(
      await rl.question(`Judge provider [${JUDGE_PROVIDER_IDS.join(' | ')}] (local): `),
      'local',
    )

    let judgeCredentialMode: 'project' | 'apiKey' | undefined
    let judgeEndpoint: string | undefined
    let acceptCloud = false

    const isCloud = judgeProviderId !== 'local'
    if (isCloud) {
      judgeCredentialMode = parseYesNo(
        await rl.question('Use project env for credentials? [y=project | n=apiKey] (y): '),
        true,
      )
        ? 'project'
        : 'apiKey'

      if (judgeProviderId === 'cursor' || judgeProviderId === 'custom') {
        judgeEndpoint = (await rl.question('Judge endpoint URL (required): ')).trim()
      }

      if (judgeCredentialMode === 'apiKey') {
        const key = await rl.question('Paste API key (hidden input not available in all shells): ')
        if (key.trim()) {
          process.env.BELAY_WIZARD_JUDGE_KEY = key.trim()
        }
      }

      acceptCloud = parseYesNo(
        await rl.question(
          'Accept cloud judge egress (redacted commands leave the repo)? [y | n] (n): ',
        ),
        false,
      )
    }

    const initOptions = buildInitOptionsFromWizard(
      {
        adapter,
        scope,
        withSkill,
        judgeProviderId,
        judgeCredentialMode,
        judgeEndpoint,
        acceptCloud,
        dogfood: false,
      },
      options.targetDir,
    )

    const result = await initProject(initOptions)

    if (process.env.BELAY_WIZARD_JUDGE_KEY && judgeCredentialMode === 'apiKey') {
      const { writeJudgeCredentialStore } = await import('../core/credential-store.js')
      const { loadConfigFile, repoLocalStateDirFor } = await import('../config-io.js')
      const { belayStateDir } = await import('../core/config.js')
      const config = await loadConfigFile(result.repoRoot, result.adapter)
      const stateDir = belayStateDir(config, repoLocalStateDirFor(result.repoRoot, config))
      await writeJudgeCredentialStore(stateDir, process.env.BELAY_WIZARD_JUDGE_KEY)
      delete process.env.BELAY_WIZARD_JUDGE_KEY
    }

    return result
  } finally {
    rl.close()
  }
}
