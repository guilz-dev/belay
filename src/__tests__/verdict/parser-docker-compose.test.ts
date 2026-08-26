import { describe, expect, it } from 'vitest'

import { tokenizeShell } from '../../core/shell-tokenizer.js'
import { extractDockerComposeRunScript, extractRecursiveScript } from '../../core/verdict/parser.js'

describe('extractRecursiveScript', () => {
  it('preserves the closing quote of a nested shell script', () => {
    expect(extractRecursiveScript(tokenizeShell(`sh -c 'sh -c "set -e"'`))).toBe('sh -c "set -e"')
  })

  it('preserves the closing quote of a compose script nested in sh -c', () => {
    expect(
      extractRecursiveScript(
        tokenizeShell(
          `sh -c 'docker compose run --rm app sh -lc "bundle exec rspec spec/models/user_spec.rb"'`,
        ),
      ),
    ).toBe('docker compose run --rm app sh -lc "bundle exec rspec spec/models/user_spec.rb"')
  })

  it('extracts only the script operand and not sh -c positional arguments', () => {
    expect(extractRecursiveScript(tokenizeShell(`sh -c 'printf "%s" "$1"' shell-name value`))).toBe(
      'printf "%s" "$1"',
    )
  })
})

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
      extractDockerComposeRunScript(['docker', 'compose', 'run', 'app', 'sh', '-c', 'pnpm test']),
    ).toBe('pnpm test')
  })

  it('preserves the closing quote of a shell nested in the compose script', () => {
    expect(
      extractDockerComposeRunScript(
        tokenizeShell(`docker compose run app sh -lc 'sh -c "set -e"'`),
      ),
    ).toBe('sh -c "set -e"')
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
