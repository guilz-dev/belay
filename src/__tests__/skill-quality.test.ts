import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const skillPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../skills/belay/SKILL.md',
)

describe('SKILL.md quality (T20/T23)', () => {
  it('T20: skill body does not embed classification logic', async () => {
    const content = await readFile(skillPath, 'utf8')
    const forbidden = [
      'classifyShell',
      'classifySubagent',
      'classifyToolUse',
      'deny_pending_approval',
      'tier0_external',
      'verdict(',
      'gate-engine',
    ]
    for (const token of forbidden) {
      expect(content.includes(token)).toBe(false)
    }
    expect(content).toContain('does not classify commands itself')
  })

  it('T23: frontmatter and description include trigger vocabulary', async () => {
    const content = await readFile(skillPath, 'utf8')
    expect(content).toMatch(/^---\n/)
    expect(content).toContain('name: belay')
    expect(content).toContain('disable-model-invocation: true')
    const descriptionMatch = content.match(/description:\s*>-\s*\n([\s\S]*?)\n[a-z-]+:/)
    const description = descriptionMatch?.[1] ?? content
    for (const trigger of ['denied', 'blocked', 'high-risk', 'belay-approve', 'belay']) {
      expect(description.toLowerCase()).toContain(trigger)
    }
    expect(content).toContain('/belay why')
    expect(content).toContain('belay explain')
  })

  it('T23: SKILL.md snapshot stays stable', async () => {
    const content = await readFile(skillPath, 'utf8')
    expect(content).toMatchSnapshot()
  })
})
