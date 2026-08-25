import { describe, expect, it } from 'vitest'

import { extractDockerComposeRunScript } from '../../core/verdict/parser.js'

describe('extractDockerComposeRunScript', () => {
  it('extracts bash -lc inner script from docker-compose run', () => {
    expect(
      extractDockerComposeRunScript([
        'docker-compose',
        'run',
        '--rm',
        'test',
        '/bin/bash',
        '-lc',
        'bundle exec rspec spec/makefile/upgrade_harness_spec.rb',
      ]),
    ).toBe('bundle exec rspec spec/makefile/upgrade_harness_spec.rb')
  })

  it('extracts inner script from docker compose run', () => {
    expect(
      extractDockerComposeRunScript([
        'docker',
        'compose',
        'run',
        'app',
        'sh',
        '-c',
        'pnpm test',
      ]),
    ).toBe('pnpm test')
  })

  it('returns null when compose run has no shell wrapper', () => {
    expect(
      extractDockerComposeRunScript([
        'docker-compose',
        'run',
        '--rm',
        'test',
        'bundle',
        'exec',
        'rspec',
        'spec/foo_spec.rb',
      ]),
    ).toBeNull()
  })

  it('returns null without run subcommand', () => {
    expect(extractDockerComposeRunScript(['docker-compose', 'up', '-d'])).toBeNull()
  })

  it('returns null for non-compose commands', () => {
    expect(extractDockerComposeRunScript(['make', 'test-fast'])).toBeNull()
  })
})
