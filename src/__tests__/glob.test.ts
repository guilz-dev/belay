import { describe, expect, it } from 'vitest'

import { matchesSensitivePath } from '../core/glob.js'

const DEFAULT_SENSITIVE_PATHS = ['.env', '.env.*', '**/credentials/**']

describe('matchesSensitivePath', () => {
  it('matches ** glob patterns with wildcards in the suffix', () => {
    expect(matchesSensitivePath('secrets/a.pem', ['**/*.pem'])).toBe(true)
    expect(matchesSensitivePath('a.pem', ['**/*.pem'])).toBe(true)
    expect(matchesSensitivePath('x/y/id_rsa', ['**/id_*'])).toBe(true)
    expect(matchesSensitivePath('id_rsa', ['**/id_*'])).toBe(true)
    expect(matchesSensitivePath('a/b/keys.json', ['**/keys.json'])).toBe(true)
    expect(matchesSensitivePath('credentials/api.json', ['**/credentials/**'])).toBe(true)
  })

  it('keeps default sensitive path behavior', () => {
    expect(matchesSensitivePath('.env', DEFAULT_SENSITIVE_PATHS)).toBe(true)
    expect(matchesSensitivePath('.env.local', DEFAULT_SENSITIVE_PATHS)).toBe(true)
    expect(matchesSensitivePath('config/credentials/api.json', DEFAULT_SENSITIVE_PATHS)).toBe(true)
    expect(matchesSensitivePath('notes.txt', DEFAULT_SENSITIVE_PATHS)).toBe(false)
  })

  it('does not throw on regex metacharacters in patterns', () => {
    expect(() => matchesSensitivePath('foo', ['foo[bar]'])).not.toThrow()
    expect(matchesSensitivePath('foo[bar]', ['foo[bar]'])).toBe(true)
  })

  it('matches basename-only patterns against nested paths', () => {
    expect(matchesSensitivePath('nested/.env', ['.env'])).toBe(true)
    expect(matchesSensitivePath('nested/secret.pem', ['*.pem'])).toBe(true)
  })
})
