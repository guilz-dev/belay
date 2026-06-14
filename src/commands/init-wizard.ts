import { stdin as input, stdout as output } from 'node:process'
import readline from 'node:readline/promises'

import { initProject } from '../installer.js'
import type { AdapterName, InitOptions } from '../types.js'

export interface WizardAnswers {
  adapter: AdapterName
  scope: 'project' | 'global'
  withSkill: boolean
  judgeProfile: 'local-ollama' | 'cursor' | 'claude' | 'codex'
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

export function parseJudgeProfile(
  value: string | undefined,
  defaultProfile: 'local-ollama' | 'cursor' | 'claude' | 'codex',
): 'local-ollama' | 'cursor' | 'claude' | 'codex' {
  const normalized = (value?.trim() || defaultProfile).toLowerCase()
  if (
    normalized === 'local-ollama' ||
    normalized === 'cursor' ||
    normalized === 'claude' ||
    normalized === 'codex'
  ) {
    return normalized
  }
  throw new Error(`Unknown judge profile: ${value ?? '(empty)'}`)
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
    judgeProfile: answers.judgeProfile,
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
    // Show Tier1 judge choice explicitly so init defaults are visible in wizard UX.
    const defaultJudgeProfile = adapter
    const judgeProfile = parseJudgeProfile(
      await rl.question(
        `Tier1 judge profile [cursor | claude | codex | local-ollama] (${defaultJudgeProfile}): `,
      ),
      defaultJudgeProfile,
    )
    return initProject(
      buildInitOptionsFromWizard(
        { adapter, scope, withSkill, judgeProfile, dogfood: false },
        options.targetDir,
      ),
    )
  } finally {
    rl.close()
  }
}
