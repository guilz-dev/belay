import { describe, expect, it } from 'vitest'

import {
  buildInitOptionsFromConfigAnswers,
  buildInstalledConfigAreaSelectOptions,
  buildUnknownLocalEffectSelectOptions,
  parseAdapter,
  parseJudgeProviderId,
  parseScope,
  parseYesNo,
} from '../commands/config.js'

describe('belay config parsers', () => {
  it('uses bracket defaults when the user presses Enter', () => {
    expect(parseAdapter('')).toBe('cursor')
    expect(parseScope('')).toBe('project')
    expect(parseJudgeProviderId('', 'ollama')).toBe('ollama')
    expect(parseJudgeProviderId('', 'openai')).toBe('codex')
    expect(parseYesNo('', true)).toBe(true)
    expect(parseYesNo('', false)).toBe(false)
  })

  it('defaults unknown local effects to pass with an audit flag', () => {
    const policy = buildUnknownLocalEffectSelectOptions()
    expect(policy.defaultValue).toBe('allow_flagged')
    expect(policy.choices.map((choice) => choice.value)).toEqual(['allow_flagged', 'deny'])
  })

  it('offers policy-only configuration for installed projects', () => {
    const area = buildInstalledConfigAreaSelectOptions()
    expect(area.defaultValue).toBe('judge')
    expect(area.choices.map((choice) => choice.value)).toEqual(['judge', 'policy', 'full'])
  })

  it('maps config wizard answers to InitOptions', () => {
    expect(
      buildInitOptionsFromConfigAnswers(
        {
          adapter: 'codex',
          scope: 'global',
          withSkill: true,
          unknownLocalEffect: 'deny',
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
      unknownLocalEffect: 'deny',
      judgeProviderId: 'codex',
      acceptCloudJudge: true,
      dogfood: true,
    })
  })
})
