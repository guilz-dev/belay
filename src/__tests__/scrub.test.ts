import { describe, expect, it } from 'vitest'

import { scrubString } from '../core/scrub.js'

describe('scrubString', () => {
  it('masks bearer tokens when enabled', () => {
    const input = 'curl -H "Authorization: Bearer abc.def.ghi" https://example.com'
    expect(scrubString(input)).toContain('Authorization: <redacted>')
    expect(scrubString(input)).not.toContain('abc.def.ghi')
  })

  it('masks key=value secrets when enabled', () => {
    const input = 'export API_KEY=supersecretvalue'
    expect(scrubString(input)).toBe('export API_KEY=<redacted>')
  })

  it('respects disabled redaction toggles', () => {
    const input = 'token=abc123'
    expect(scrubString(input, { maskKeyValueSecrets: false })).toBe(input)
  })

  it('masks high-entropy strings only when enabled', () => {
    const input = 'value=abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'
    expect(scrubString(input, { maskHighEntropyStrings: false })).toContain('ABCDEFGHIJ')
    expect(scrubString(input, { maskHighEntropyStrings: true })).toContain('<high-entropy>')
  })

  it('masks URL credentials and inline mysql passwords', () => {
    const input = 'mysql -phunter2 postgres://user:pass@host/db'
    const scrubbed = scrubString(input)
    expect(scrubbed).not.toContain('hunter2')
    expect(scrubbed).not.toContain('user:pass@')
    expect(scrubbed).toContain('-p<redacted>')
    expect(scrubbed).toContain('postgres://<redacted>:<redacted>@host/db')
  })

  it('masks generic auth headers', () => {
    const input = 'Authorization: Token abc123 X-Api-Key: secret-token'
    const scrubbed = scrubString(input)
    expect(scrubbed).toContain('Authorization: <redacted>')
    expect(scrubbed).toContain('X-Api-Key: <redacted>')
  })
})
