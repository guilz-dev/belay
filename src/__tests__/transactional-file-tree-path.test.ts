import { describe, expect, it } from 'vitest'
import { compareRelativePathsBytewise } from '../core/transactional/file-tree-path.js'

describe('compareRelativePathsBytewise', () => {
  it('sorts by UTF-8 bytes rather than UTF-16 code units', () => {
    const paths = ['\uFF41', '\u{1D400}']
    const sorted = [...paths].sort(compareRelativePathsBytewise)
    expect(sorted).toEqual(['\uFF41', '\u{1D400}'])
    expect([...paths].sort()).toEqual(['\u{1D400}', '\uFF41'])
  })
})
