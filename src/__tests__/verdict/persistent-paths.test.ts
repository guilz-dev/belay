import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  isPersistentAgentPath,
  PERSISTENT_AGENT_PATH_MARKERS,
} from '../../core/verdict/persistent-paths.js'

describe('persistent agent paths (M3 catalog)', () => {
  it('exports markers aligned with tier0-retention-ledger', () => {
    expect(PERSISTENT_AGENT_PATH_MARKERS).toContain('.ssh/authorized_keys')
    expect(PERSISTENT_AGENT_PATH_MARKERS).toContain('.config/')
  })

  it('detects persistent agent startup paths', () => {
    const home = process.env.HOME ?? '/home/user'
    expect(isPersistentAgentPath(path.join(home, '.zshrc'))).toBe(true)
    expect(isPersistentAgentPath(path.join(home, '.ssh/authorized_keys'))).toBe(true)
    expect(isPersistentAgentPath(path.join(home, '.config/app/settings.json'))).toBe(true)
    expect(isPersistentAgentPath('/tmp/benign.txt')).toBe(false)
    expect(isPersistentAgentPath(path.join(home, '.cursor/plans/foo.plan.md'))).toBe(false)
  })
})
