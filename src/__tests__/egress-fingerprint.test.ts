import { describe, expect, it } from 'vitest'

import { egressSummary, parseHostFromSummary } from '../core/egress/fingerprint.js'
import { parseConnectTarget } from '../core/egress/proxy-server.js'
import { normalizeEgressListenHost } from '../core/config.js'

describe('egress fingerprint helpers', () => {
  it('formats and parses IPv6 host summaries', () => {
    const summary = egressSummary('::1', 8443)
    expect(summary).toBe('CONNECT [::1]:8443')
    expect(parseHostFromSummary(summary)).toBe('::1')
  })

  it('rejects invalid CONNECT ports', () => {
    expect(parseConnectTarget('example.com:notanumber')).toBeNull()
    expect(parseConnectTarget('[::1]:0')).toBeNull()
  })

  it('coerces non-loopback listen hosts to localhost', () => {
    expect(normalizeEgressListenHost('0.0.0.0')).toBe('127.0.0.1')
    expect(normalizeEgressListenHost('127.0.0.1')).toBe('127.0.0.1')
    expect(normalizeEgressListenHost('::1')).toBe('::1')
  })
})
