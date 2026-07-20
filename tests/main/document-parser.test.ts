import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  chunkText,
  MAX_KNOWLEDGE_DOCUMENT_BYTES,
  parseDocument
} from '../../src/main/services/knowledge/document-parser'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('chunkText', () => {
  it('keeps paragraph chunks under the requested size when possible', () => {
    const chunks = chunkText('one two\n\nthree four\n\nfive six', 14, 0)

    expect(chunks.map(chunk => chunk.content)).toEqual(['one two', 'three four', 'five six'])
    expect(chunks.map(chunk => chunk.chunkIndex)).toEqual([0, 1, 2])
  })

  it('parses a document within the file-size limit', () => {
    const directory = mkdtempSync(join(tmpdir(), 'noval-parser-'))
    tempDirectories.push(directory)
    const filePath = join(directory, 'notes.md')
    writeFileSync(filePath, 'hello world', 'utf8')

    expect(parseDocument(filePath)).toMatchObject({
      text: 'hello world',
      charCount: 11,
      metadata: { format: '.md' }
    })
  })

  it('rejects oversized documents before reading their contents', () => {
    const directory = mkdtempSync(join(tmpdir(), 'noval-parser-'))
    tempDirectories.push(directory)
    const filePath = join(directory, 'oversized.txt')
    writeFileSync(filePath, '')
    truncateSync(filePath, MAX_KNOWLEDGE_DOCUMENT_BYTES + 1)

    expect(() => parseDocument(filePath)).toThrow('Knowledge documents cannot exceed 5MB')
  })
})
