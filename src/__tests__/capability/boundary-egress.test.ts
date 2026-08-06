import { describe, expect, it } from 'vitest'
import {
  belayContainerNetworkName,
  dockerNetworkArgs,
  resolveBoundaryEgressProxyEnv,
} from '../../core/capability/boundary-egress.js'
import { DEFAULT_CONFIG_V4 } from '../../core/config.js'

describe('boundary egress docker networking', () => {
  it('uses network none when proxy is inactive', () => {
    expect(dockerNetworkArgs(false, '/repo')).toEqual(['--network', 'none'])
  })

  it('uses an internal per-repo network when proxy is active', () => {
    const repoRoot = '/workspace/project'
    expect(dockerNetworkArgs(true, repoRoot)).toEqual([
      '--add-host=host.docker.internal:host-gateway',
      '--network',
      belayContainerNetworkName(repoRoot),
    ])
    expect(belayContainerNetworkName(repoRoot)).toMatch(/^belay-int-[a-f0-9]{12}$/)
  })

  it('falls back to network none when proxy is active but repo root is missing', () => {
    expect(dockerNetworkArgs(true)).toEqual(['--network', 'none'])
  })

  it('uses host.docker.internal proxy env for container driver', () => {
    const env = resolveBoundaryEgressProxyEnv({
      driverId: 'container',
      config: {
        ...DEFAULT_CONFIG_V4,
        egress: {
          ...DEFAULT_CONFIG_V4.egress,
          enabled: true,
          listenHost: '127.0.0.1',
          listenPort: 17831,
        },
      },
      proxyActive: true,
    })
    expect(env.HTTPS_PROXY).toBe('http://host.docker.internal:17831')
  })
})
