import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const mocks = vi.hoisted(() => ({
  getPath: vi.fn(),
  readZipEntries: vi.fn(),
  createSkill: vi.fn(),
  scanSkillDocs: vi.fn(() => Promise.resolve([]))
}))

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath }
}))

vi.mock('../../src/main/services/skills/zip-reader', () => ({
  readZipEntries: mocks.readZipEntries
}))

vi.mock('../../src/main/services/skills/skill-docs', () => ({
  scanSkillDocs: mocks.scanSkillDocs
}))

vi.mock('../../src/main/db/repositories/skill.repo', () => ({
  skillRepo: {
    create: mocks.createSkill,
    getById: vi.fn(),
    delete: vi.fn()
  }
}))

import { installSkillFromPath } from '../../src/main/services/skills/skill-installer'

const tempDirectories: string[] = []

afterEach(() => {
  vi.clearAllMocks()
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('skill ZIP installer security', () => {
  it('validates the actual decompressed length before writing an entry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noval-skill-zip-'))
    tempDirectories.push(root)
    mocks.getPath.mockReturnValue(root)
    const sourcePath = join(root, 'malicious.zip')
    writeFileSync(sourcePath, 'not-read-by-mocked-reader')

    mocks.readZipEntries.mockReturnValue([{
      path: 'SKILL.md',
      isDirectory: false,
      compressedSize: 1,
      uncompressedSize: 1,
      read: () => Buffer.from('actual output is larger')
    }])

    await expect(installSkillFromPath(sourcePath)).rejects.toThrow(/实际大小与目录声明不一致/)
    expect(mocks.createSkill).not.toHaveBeenCalled()
  })
})
