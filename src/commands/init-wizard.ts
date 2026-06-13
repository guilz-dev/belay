import { stdin as input, stdout as output } from 'node:process'
import readline from 'node:readline/promises'

import { initProject } from '../installer.js'
import type { AdapterName, InitOptions } from '../types.js'

export interface WizardAnswers {
  adapter: AdapterName
  scope: 'project' | 'global'
  withSkill: boolean
  dogfood: boolean
}

function parseAdapter(value: string | undefined): AdapterName {
  const normalized = (value ?? 'cursor').trim().toLowerCase()
  if (normalized === 'claude' || normalized === 'codex' || normalized === 'cursor') {
    return normalized
  }
  throw new Error(`Unknown adapter: ${value ?? '(empty)'}`)
}

function parseScope(value: string | undefined): 'project' | 'global' {
  const normalized = (value ?? 'project').trim().toLowerCase()
  if (normalized === 'global' || normalized === 'project') {
    return normalized
  }
  throw new Error(`Unknown scope: ${value ?? '(empty)'}`)
}

function parseYesNo(value: string | undefined, defaultValue: boolean): boolean {
  const normalized = (value ?? (defaultValue ? 'y' : 'n')).trim().toLowerCase()
  if (['y', 'yes', 'true', '1'].includes(normalized)) {
    return true
  }
  if (['n', 'no', 'false', '0'].includes(normalized)) {
    return false
  }
  return defaultValue
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
    dogfood: answers.dogfood,
  }
}

export async function runInitWizard(options: { targetDir?: string } = {}) {
  const rl = readline.createInterface({ input, output })
  try {
    output.write('agent-belay init wizard\n')
    const adapter = parseAdapter(await rl.question('Adapter (cursor/claude/codex) [cursor]: '))
    const scope = parseScope(await rl.question('Install scope (project/global) [project]: '))
    const withSkill = parseYesNo(
      await rl.question('Install SKILL.md and slash commands? (y/n) [y]: '),
      true,
    )
    const dogfood = parseYesNo(await rl.question('Start in audit dogfood mode? (y/n) [n]: '), false)
    return initProject(
      buildInitOptionsFromWizard({ adapter, scope, withSkill, dogfood }, options.targetDir),
    )
  } finally {
    rl.close()
  }
}
