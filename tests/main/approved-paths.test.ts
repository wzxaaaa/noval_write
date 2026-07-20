import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import {
  approvePath,
  consumeApprovedPath,
  isApprovedPath,
  isTrustedRendererUrl
} from '../../src/main/utils/approved-paths'

const tempDirectories: string[] = []

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('approved paths', () => {
  it('scopes native picker approvals to a purpose and consumes them once', () => {
    const directory = mkdtempSync(join(tmpdir(), 'noval-approved-'))
    tempDirectories.push(directory)
    const filePath = join(directory, 'notes.txt')
    writeFileSync(filePath, 'notes')

    approvePath(filePath, 'knowledge-document')

    expect(isApprovedPath(filePath, 'knowledge-document')).toBe(true)
    expect(consumeApprovedPath(filePath, 'background-image')).toBeNull()
    expect(consumeApprovedPath(filePath, 'knowledge-document')).toBeTruthy()
    expect(consumeApprovedPath(filePath, 'knowledge-document')).toBeNull()
  })

  it('does not approve missing paths', () => {
    const missingPath = join(tmpdir(), `noval-missing-${Date.now()}.txt`)
    approvePath(missingPath, 'knowledge-document')
    expect(isApprovedPath(missingPath, 'knowledge-document')).toBe(false)
  })
})

describe('trusted renderer URLs', () => {
  it('allows only the configured development origin', () => {
    const configured = 'http://localhost:5173/editor'

    expect(isTrustedRendererUrl('http://localhost:5173/project/1', configured)).toBe(true)
    expect(isTrustedRendererUrl('http://localhost:5174/project/1', configured)).toBe(false)
    expect(isTrustedRendererUrl('https://example.com/', configured)).toBe(false)
  })

  it('allows only the packaged renderer file in production', () => {
    const directory = mkdtempSync(join(tmpdir(), 'noval-renderer-'))
    tempDirectories.push(directory)
    const rendererPath = join(directory, 'index.html')
    const otherPath = join(directory, 'other.html')
    writeFileSync(rendererPath, '<html></html>')
    writeFileSync(otherPath, '<html></html>')
    const rendererUrl = pathToFileURL(rendererPath).href

    expect(isTrustedRendererUrl(`${rendererUrl}#/project/1`, undefined, rendererUrl)).toBe(true)
    expect(isTrustedRendererUrl(pathToFileURL(otherPath).href, undefined, rendererUrl)).toBe(false)
    expect(isTrustedRendererUrl('https://example.com/', undefined, rendererUrl)).toBe(false)
  })
})
