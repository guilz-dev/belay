import { cp, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { collectRequirements } from '../../core/effect-ir/build.js'
import { verdict } from '../../core/verdict/verdict.js'
import { verdictTestContext } from './helpers.js'

const fixtureDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/makefiles/freelance-test-fast',
)

describe('freelance dogfood grammar regression', () => {
  const tempDirs: string[] = []
  const ctx = verdictTestContext()

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('does not classify freelance contract test commands as unknown_local_effect', async () => {
    const ruby = await verdict('ruby -Itest test/upgrade_script_contract_test.rb', ctx)
    expect(ruby.reason).not.toBe('unknown_local_effect')
    expect(ruby.effectPlan?.completeness).toBe('complete')

    const chained = await verdict(
      'ruby -Itest test/upgrade_script_contract_test.rb && bundle exec rubocop test/upgrade_script_contract_test.rb',
      ctx,
    )
    expect(chained.reason).not.toBe('unknown_local_effect')
    expect(chained.effectPlan?.completeness).toBe('complete')
  })

  it('does not classify repo-outside minitest scripts as allow', async () => {
    const result = await verdict('ruby -Itest /tmp/evil_test.rb', ctx)
    expect(result.permission).toBe('ask')
    expect(result.reason).toBe('unknown_local_effect')
  })

  it('requires approval when the incident test-fast command exposes its Docker prerequisite', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'belay-freelance-fixture-'))
    tempDirs.push(dir)
    await cp(fixtureDir, dir, { recursive: true })

    const result = await verdict('make test-fast ARGS="spec/requests/api/v1/project_spec.rb:74"', {
      ...ctx,
      cwd: dir,
      repoRoot: dir,
    })
    const requirements = result.effectPlan ? collectRequirements(result.effectPlan.root) : []
    expect(
      requirements.some(
        (requirement) =>
          requirement.action === 'indeterminate' &&
          requirement.evidence.signals.includes('launcher.make_recipe_dynamic') &&
          requirement.provenances?.some((provenance) =>
            provenance.innerCommand?.includes('docker start'),
          ),
      ),
    ).toBe(true)
    expect(result.permission).toBe('ask')
    expect(result.authorizationDecision?.outcome).toBe('require_approval')
  })
})
