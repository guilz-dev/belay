import { describe, expect, it } from 'vitest'
import { loadJudgeAccuracyCases, parseJudgeAccuracyCases } from '../../corpus/judge-accuracy.js'

describe('judge accuracy fixture', () => {
  it('loads fixed fixture with whyThisExists on every case', async () => {
    const cases = await loadJudgeAccuracyCases()
    expect(cases.length).toBeGreaterThanOrEqual(15)
    for (const entry of cases) {
      expect(entry.whyThisExists.trim().length).toBeGreaterThan(0)
    }
  })

  it('rejects fixture entries missing whyThisExists', () => {
    expect(() =>
      parseJudgeAccuracyCases([
        {
          command: 'git status',
          expectedPermission: 'allow',
          category: 'routine_read',
        },
      ]),
    ).toThrow(/whyThisExists/)
  })
})
