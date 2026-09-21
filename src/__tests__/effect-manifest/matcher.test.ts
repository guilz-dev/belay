import { describe, expect, it } from 'vitest'

import { matchArgv } from '../../core/effect-manifest/matcher.js'
import type { ArgvMatcherV1 } from '../../core/effect-manifest/types.js'

describe('effect manifest argv matcher', () => {
  it('matches every bounded capture type with exact argv length', () => {
    const matcher: ArgvMatcherV1[] = [
      { kind: 'literal', value: 'deploy' },
      { kind: 'enum', name: 'environment', values: ['staging', 'production'] },
      { kind: 'path', name: 'source' },
      { kind: 'host', name: 'host' },
      { kind: 'integer', name: 'count', min: 1, max: 3 },
      { kind: 'token', name: 'label' },
    ]
    expect(
      matchArgv(['deploy', 'staging', './src', 'api.example.com', '2', 'blue'], matcher),
    ).toEqual({
      environment: 'staging',
      source: './src',
      host: 'api.example.com',
      count: '2',
      label: 'blue',
    })
    expect(
      matchArgv(['deploy', 'STAGING', './src', 'api.example.com', '2', 'blue'], matcher),
    ).toBeNull()
    expect(
      matchArgv(['deploy', 'staging', './src', 'api.example.com', '4', 'blue'], matcher),
    ).toBeNull()
    expect(matchArgv(['deploy', 'staging'], matcher)).toBeNull()
  })

  it('rejects malformed hosts, integers, paths, and tokens', () => {
    expect(matchArgv(['bad host'], [{ kind: 'host', name: 'host' }])).toBeNull()
    expect(matchArgv(['01'], [{ kind: 'integer', name: 'count' }])).toBeNull()
    expect(matchArgv([''], [{ kind: 'path', name: 'path' }])).toBeNull()
    expect(matchArgv([''], [{ kind: 'token', name: 'token' }])).toBeNull()
  })
})
