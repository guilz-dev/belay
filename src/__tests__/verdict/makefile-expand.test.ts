import { describe, expect, it } from 'vitest'

import {
  expandMakeExpression,
  normalizeMakeRecipeLine,
  parseMakefileVariables,
} from '../../core/verdict/makefile-expand.js'

describe('makefile-expand', () => {
  it('parses simple makefile variables', () => {
    const variables = parseMakefileVariables(`
TEST_RSPEC_ARGS = $(or $(ARGS),spec)
TEST_DOCKER_RUN = docker-compose run --rm test
`)
    expect(variables.get('TEST_RSPEC_ARGS')).toBe('$(or $(ARGS),spec)')
    expect(variables.get('TEST_DOCKER_RUN')).toBe('docker-compose run --rm test')
  })

  it('expands $(or $(ARGS),spec) with CLI ARGS', () => {
    const variables = parseMakefileVariables('TEST_RSPEC_ARGS = $(or $(ARGS),spec)\n')
    expect(
      expandMakeExpression(
        '$(TEST_RSPEC_ARGS)',
        { ARGS: 'spec/makefile/upgrade_harness_spec.rb' },
        variables,
      ),
    ).toBe('spec/makefile/upgrade_harness_spec.rb')
  })

  it('strips make recipe prefixes', () => {
    expect(normalizeMakeRecipeLine('@docker-compose run test')).toBe('docker-compose run test')
    expect(normalizeMakeRecipeLine('+pnpm test')).toBe('pnpm test')
    expect(normalizeMakeRecipeLine('-git status')).toBe('git status')
  })

  it('expands braced makefile variables including PWD', () => {
    const pwdVariable = '$' + '{PWD}'
    const appComposeVariable = '$' + '{APP_COMPOSE_FILE}'
    const variables = parseMakefileVariables(
      `APP_COMPOSE_FILE=${pwdVariable}/docker-compose.development.yml\n`,
    )
    expect(expandMakeExpression(appComposeVariable, {}, variables)).toBe(
      './docker-compose.development.yml',
    )
  })

  it('returns null for shell expansions', () => {
    expect(expandMakeExpression('$(shell pwd)', {}, new Map())).toBeNull()
  })
})
