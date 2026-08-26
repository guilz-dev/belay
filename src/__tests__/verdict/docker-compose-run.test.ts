import { describe, expect, it } from 'vitest'

import { lexShell } from '../../core/shell-tokenizer.js'
import { decodeDockerComposeRun } from '../../core/verdict/docker-compose-run.js'

describe('decodeDockerComposeRun', () => {
  it('decodes global options, run options, service, and shell command in order', () => {
    expect(
      decodeDockerComposeRun(
        lexShell(
          `docker compose -f compose.yml run --rm -e RAILS_ENV=test app sh -lc 'bundle exec rspec'`,
        ).tokens,
      ),
    ).toMatchObject({ kind: 'recursive', service: 'app', script: 'bundle exec rspec' })
  })

  it('supports the legacy docker-compose executable form', () => {
    expect(
      decodeDockerComposeRun(
        lexShell(`docker-compose run --rm app /bin/bash -c 'bundle exec rspec'`).tokens,
      ),
    ).toMatchObject({ kind: 'recursive', service: 'app', script: 'bundle exec rspec' })
  })

  it.each([
    `docker compose run --name sh app bundle exec rspec`,
    `docker compose run app printf '%s' 'sh -c value'`,
    `docker compose run sh-service bundle exec rspec sh -c value`,
  ])('does not scan option values, service names, or command arguments: %s', (command) => {
    expect(decodeDockerComposeRun(lexShell(command).tokens).kind).toBe('none')
  })

  it.each([
    `docker compose --future value run app sh -c ok`,
    `docker compose run -e=RAILS_ENV=test app sh -c ok`,
    `docker compose run --entrypoint`,
    `docker compose run --rm`,
  ])('fails closed on unknown or incomplete Compose argv: %s', (command) => {
    expect(decodeDockerComposeRun(lexShell(command).tokens)).toEqual({
      kind: 'indeterminate',
      signal: 'shell.compose_argv_indeterminate',
    })
  })

  it('returns none for non-run Compose subcommands', () => {
    expect(decodeDockerComposeRun(lexShell(`docker compose up -d`).tokens)).toEqual({
      kind: 'none',
    })
  })
})
