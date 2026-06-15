import { describe, expect, it } from 'vitest'

import {
  buildInitOptionsFromWizard,
  parseAdapter,
  parseJudgeProviderId,
  parseScope,
  parseYesNo,
} from '../commands/init-wizard.js'

describe('init wizard', () => {
  it('uses bracket defaults when the user presses Enter', () => {
    expect(parseAdapter('')).toBe('cursor')
    expect(parseScope('')).toBe('project')
    expect(parseJudgeProviderId('', 'ollama')).toBe('ollama')
    expect(parseJudgeProviderId('', 'openai')).toBe('codex')
    expect(parseYesNo('', true)).toBe(true)
    expect(parseYesNo('', false)).toBe(false)
  })

  it('maps wizard answers to InitOptions', () => {
    expect(
      buildInitOptionsFromWizard(
        {
          adapter: 'codex',
          scope: 'global',
          withSkill: true,
          judgeProviderId: 'codex',
          acceptCloud: true,
          dogfood: true,
        },
        '/tmp/repo',
      ),
    ).toEqual({
      targetDir: '/tmp/repo',
      adapter: 'codex',
      scope: 'global',
      withSkill: true,
      judgeProviderId: 'codex',
      acceptCloudJudge: true,
      dogfood: true,
    })
  })
})
