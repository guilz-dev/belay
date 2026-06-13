import { describe, expect, it } from 'vitest'

import { buildInitOptionsFromWizard } from '../commands/init-wizard.js'

describe('init wizard', () => {
  it('maps wizard answers to InitOptions', () => {
    expect(
      buildInitOptionsFromWizard(
        {
          adapter: 'codex',
          scope: 'global',
          withSkill: true,
          dogfood: true,
        },
        '/tmp/repo',
      ),
    ).toEqual({
      targetDir: '/tmp/repo',
      adapter: 'codex',
      scope: 'global',
      withSkill: true,
      dogfood: true,
    })
  })
})
