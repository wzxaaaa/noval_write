import { describe, expect, it } from 'vitest'
import { chunkText } from '../../src/main/services/knowledge/document-parser'

describe('chunkText', () => {
  it('keeps paragraph chunks under the requested size when possible', () => {
    const chunks = chunkText('one two\n\nthree four\n\nfive six', 14, 0)

    expect(chunks.map(chunk => chunk.content)).toEqual(['one two', 'three four', 'five six'])
    expect(chunks.map(chunk => chunk.chunkIndex)).toEqual([0, 1, 2])
  })
})
