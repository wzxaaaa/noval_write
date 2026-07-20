import { deflateRawSync } from 'zlib'
import { describe, expect, it } from 'vitest'
import { readZipEntries, type ZipReadLimits } from '../../src/main/services/skills/zip-reader'

interface TestZipEntry {
  name: string
  data: Buffer
  method?: 0 | 8
  declaredUncompressedSize?: number
}

const generousLimits: ZipReadLimits = {
  maxEntries: 20,
  maxEntryUncompressedBytes: 1024 * 1024,
  maxTotalUncompressedBytes: 2 * 1024 * 1024,
  maxCompressionRatio: 1_000
}

function createZip(specs: TestZipEntry[]): Buffer {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let localOffset = 0

  for (const spec of specs) {
    const name = Buffer.from(spec.name, 'utf8')
    const method = spec.method ?? 8
    const compressed = method === 8 ? deflateRawSync(spec.data) : spec.data
    const declaredSize = spec.declaredUncompressedSize ?? spec.data.length

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(method, 8)
    localHeader.writeUInt32LE(compressed.length, 18)
    localHeader.writeUInt32LE(declaredSize, 22)
    localHeader.writeUInt16LE(name.length, 26)
    localParts.push(localHeader, name, compressed)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(method, 10)
    centralHeader.writeUInt32LE(compressed.length, 20)
    centralHeader.writeUInt32LE(declaredSize, 24)
    centralHeader.writeUInt16LE(name.length, 28)
    centralHeader.writeUInt32LE(localOffset, 42)
    centralParts.push(centralHeader, name)

    localOffset += localHeader.length + name.length + compressed.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(specs.length, 8)
  end.writeUInt16LE(specs.length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(localOffset, 16)

  return Buffer.concat([...localParts, centralDirectory, end])
}

describe('bounded ZIP reader', () => {
  it('reads a normal deflated entry within all limits', () => {
    const content = Buffer.from('# Safe skill\n')
    const [entry] = readZipEntries(createZip([{ name: 'SKILL.md', data: content }]), generousLimits)

    expect(entry.path).toBe('SKILL.md')
    expect(entry.read()).toEqual(content)
  })

  it('bounds inflation by the declared size when a malicious entry declares a tiny output', () => {
    const archive = createZip([{
      name: 'SKILL.md',
      data: Buffer.alloc(512 * 1024, 0x61),
      declaredUncompressedSize: 1
    }])
    const [entry] = readZipEntries(archive, generousLimits)

    expect(() => entry.read()).toThrow(/超过大小限制/)
  })

  it('rejects a declared single-entry size above the hard limit before inflation', () => {
    const archive = createZip([{ name: 'SKILL.md', data: Buffer.alloc(2_048, 0x61) }])

    expect(() => readZipEntries(archive, {
      ...generousLimits,
      maxEntryUncompressedBytes: 1_024
    })).toThrow(/单个文件过大/)
  })

  it('rejects a declared total size above the archive budget', () => {
    const archive = createZip([
      { name: 'SKILL.md', data: Buffer.alloc(600, 0x61), method: 0 },
      { name: 'notes.md', data: Buffer.alloc(600, 0x62), method: 0 }
    ])

    expect(() => readZipEntries(archive, {
      ...generousLimits,
      maxTotalUncompressedBytes: 1_000
    })).toThrow(/超过大小限制/)
  })

  it('rejects excessive entry counts and compression ratios', () => {
    const twoEntries = createZip([
      { name: 'SKILL.md', data: Buffer.from('a') },
      { name: 'notes.md', data: Buffer.from('b') }
    ])
    expect(() => readZipEntries(twoEntries, {
      ...generousLimits,
      maxEntries: 1
    })).toThrow(/条目过多/)

    const highRatio = createZip([{ name: 'SKILL.md', data: Buffer.alloc(10_000, 0x61) }])
    expect(() => readZipEntries(highRatio, {
      ...generousLimits,
      maxCompressionRatio: 10
    })).toThrow(/压缩比异常/)
  })
})
