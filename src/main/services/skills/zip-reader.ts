import { inflateRawSync } from 'zlib'

/**
 * 精简 ZIP 读取器。
 *
 * 只支持技能包实际会用到的两种存储方式：stored(0) 和 deflate(8)。
 * 通过中央目录（central directory）枚举条目，不做流式处理，
 * 因此调用方必须先用 MAX_ZIP_BYTES 之类的上限拦住超大文件。
 *
 * 这样做是为了避免为"导入一个 zip"引入新的运行时依赖。
 */

export interface ZipEntry {
  /** 归档内路径，已统一为正斜杠。 */
  path: string
  isDirectory: boolean
  compressedSize: number
  uncompressedSize: number
  read(): Buffer
}

export interface ZipReadLimits {
  /** 中央目录允许的最大条目数（包含目录）。 */
  maxEntries: number
  /** 单个条目允许的最大解压体积。 */
  maxEntryUncompressedBytes: number
  /** 所有条目声明的最大解压总体积。 */
  maxTotalUncompressedBytes: number
  /** 单个条目允许的最大解压体积 / 压缩体积比。 */
  maxCompressionRatio: number
}

const SIGNATURE_END_OF_CENTRAL_DIRECTORY = 0x06054b50
const SIGNATURE_CENTRAL_FILE_HEADER = 0x02014b50
const SIGNATURE_LOCAL_FILE_HEADER = 0x04034b50
const SIGNATURE_ZIP64_END_LOCATOR = 0x07064b50

const METHOD_STORED = 0
const METHOD_DEFLATE = 8

export function readZipEntries(buffer: Buffer, limits: ZipReadLimits): ZipEntry[] {
  validateLimits(limits)

  const endOffset = findEndOfCentralDirectory(buffer)
  if (endOffset < 0) {
    throw new Error('压缩包格式无法识别，请确认这是一个标准 zip 文件')
  }

  if (findZip64Locator(buffer, endOffset)) {
    throw new Error('暂不支持 ZIP64 格式的压缩包，请改用文件夹导入')
  }

  const entryCount = buffer.readUInt16LE(endOffset + 10)
  if (entryCount > limits.maxEntries) {
    throw new Error('压缩包内条目过多，请精简后重试')
  }

  const centralDirectorySize = buffer.readUInt32LE(endOffset + 12)
  let cursor = buffer.readUInt32LE(endOffset + 16)
  const centralDirectoryEnd = cursor + centralDirectorySize
  if (cursor > buffer.length || centralDirectoryEnd > endOffset || centralDirectoryEnd < cursor) {
    throw new Error('压缩包内容已损坏')
  }

  const entries: ZipEntry[] = []
  let declaredTotalBytes = 0

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > centralDirectoryEnd || cursor + 46 > buffer.length) {
      throw new Error('压缩包内容已损坏')
    }
    if (buffer.readUInt32LE(cursor) !== SIGNATURE_CENTRAL_FILE_HEADER) {
      throw new Error('压缩包内容已损坏')
    }

    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42)

    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength
    if (nextCursor > centralDirectoryEnd || nextCursor > buffer.length) {
      throw new Error('压缩包内容已损坏')
    }

    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
    const path = rawName.replace(/\\/g, '/')
    const isDirectory = path.endsWith('/')

    if (uncompressedSize > limits.maxEntryUncompressedBytes) {
      throw new Error('压缩包内单个文件过大，请精简后重试')
    }

    declaredTotalBytes += uncompressedSize
    if (declaredTotalBytes > limits.maxTotalUncompressedBytes) {
      throw new Error('压缩包解压后超过大小限制，请精简后重试')
    }

    if (!isDirectory && uncompressedSize > 0) {
      if (compressedSize === 0 || uncompressedSize / compressedSize > limits.maxCompressionRatio) {
        throw new Error('压缩包内文件压缩比异常，已拒绝导入')
      }
    }

    entries.push({
      path,
      isDirectory,
      compressedSize,
      uncompressedSize,
      read: () => readEntryData(
        buffer,
        localHeaderOffset,
        method,
        compressedSize,
        uncompressedSize,
        limits.maxEntryUncompressedBytes
      )
    })

    cursor = nextCursor
  }

  if (cursor !== centralDirectoryEnd) {
    throw new Error('压缩包内容已损坏')
  }

  return entries
}

function readEntryData(
  buffer: Buffer,
  localHeaderOffset: number,
  method: number,
  compressedSize: number,
  uncompressedSize: number,
  maxOutputBytes: number
): Buffer {
  if (localHeaderOffset + 30 > buffer.length) {
    throw new Error('压缩包内容已损坏')
  }
  if (buffer.readUInt32LE(localHeaderOffset) !== SIGNATURE_LOCAL_FILE_HEADER) {
    throw new Error('压缩包内容已损坏')
  }

  if (buffer.readUInt16LE(localHeaderOffset + 8) !== method) {
    throw new Error('压缩包内容已损坏')
  }

  const nameLength = buffer.readUInt16LE(localHeaderOffset + 26)
  const extraLength = buffer.readUInt16LE(localHeaderOffset + 28)
  const dataStart = localHeaderOffset + 30 + nameLength + extraLength
  const dataEnd = dataStart + compressedSize

  if (dataEnd > buffer.length) {
    throw new Error('压缩包内容已损坏')
  }

  const raw = buffer.subarray(dataStart, dataEnd)

  if (method === METHOD_STORED) {
    if (raw.length > maxOutputBytes || raw.length !== uncompressedSize) {
      throw new Error('压缩包内容已损坏或超过大小限制')
    }
    return Buffer.from(raw)
  }
  if (method === METHOD_DEFLATE) {
    let inflated: Buffer
    try {
      // 不论中央目录声明了什么大小，zlib 都不得分配超过该条目的硬上限。
      // 声明值更小时也以声明值为上限，阻断“小声明、大输出”的恶意条目。
      const boundedOutputLength = Math.max(1, Math.min(uncompressedSize, maxOutputBytes))
      inflated = inflateRawSync(raw, { maxOutputLength: boundedOutputLength })
    } catch {
      throw new Error('压缩包内容已损坏或解压后超过大小限制')
    }
    if (inflated.length !== uncompressedSize || inflated.length > maxOutputBytes) {
      throw new Error('压缩包内容已损坏或超过大小限制')
    }
    return inflated
  }

  throw new Error('压缩包使用了不支持的压缩算法，请改用文件夹导入')
}

function validateLimits(limits: ZipReadLimits): void {
  const values = [
    limits.maxEntries,
    limits.maxEntryUncompressedBytes,
    limits.maxTotalUncompressedBytes,
    limits.maxCompressionRatio
  ]
  if (values.some(value => !Number.isFinite(value) || value <= 0)) {
    throw new Error('ZIP 读取上限配置无效')
  }
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // EOCD 最小 22 字节，注释最长 65535 字节，从尾部往前扫。
  const minOffset = Math.max(0, buffer.length - 22 - 0xffff)
  for (let offset = buffer.length - 22; offset >= minOffset; offset--) {
    if (buffer.readUInt32LE(offset) === SIGNATURE_END_OF_CENTRAL_DIRECTORY) return offset
  }
  return -1
}

function findZip64Locator(buffer: Buffer, endOffset: number): boolean {
  const locatorOffset = endOffset - 20
  if (locatorOffset < 0) return false
  return buffer.readUInt32LE(locatorOffset) === SIGNATURE_ZIP64_END_LOCATOR
}
