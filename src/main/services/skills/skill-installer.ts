import { app } from 'electron'
import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'path'
import { deriveSkillMeta, type SkillRecord, type SkillSourceKind } from '../../../shared/skills'
import { skillRepo } from '../../db/repositories/skill.repo'
import { scanSkillDocs } from './skill-docs'
import { readZipEntries } from './zip-reader'

/** 单个技能包的体积上限，防止误选一个巨大的目录。 */
const MAX_SKILL_BYTES = 30 * 1024 * 1024
/** ZIP 内单个文件的解压上限。 */
const MAX_SKILL_ZIP_ENTRY_BYTES = 10 * 1024 * 1024
/** 技能包内的文件数量上限。 */
const MAX_SKILL_FILES = 800
/** ZIP 目录条目还会占用解析资源，因此对文件和目录合计限流。 */
const MAX_SKILL_ZIP_ENTRIES = 1_000
/** 拒绝极端压缩比条目；硬输出上限仍是最终防线。 */
const MAX_SKILL_ZIP_COMPRESSION_RATIO = 200
/** 递归复制的目录深度上限。 */
const MAX_SKILL_DEPTH = 8
/** 会被复制进技能目录的文本类扩展名，其余一律跳过。 */
const ALLOWED_EXTENSIONS = new Set([
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.py', '.js', '.ts', '.csv'
])
/** 跳过的目录名，避免把 .git 之类的东西整个搬进来。 */
const SKIPPED_DIRECTORIES = new Set([
  '.git', '.github', 'node_modules', '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'assets', 'images'
])

export function getSkillsRoot(): string {
  return join(app.getPath('userData'), 'skills')
}

/**
 * 从用户选择的路径安装技能。
 * 支持三种输入：包含 SKILL.md 的文件夹、zip 压缩包、单个 markdown 文件。
 */
export async function installSkillFromPath(sourcePath: string): Promise<SkillRecord> {
  const fileStat = await stat(sourcePath)
  const skillId = randomUUID()
  const installPath = join(getSkillsRoot(), skillId)

  try {
    await mkdir(installPath, { recursive: true })

    const installed = fileStat.isDirectory()
      ? await installFromFolder(sourcePath, installPath)
      : extname(sourcePath).toLowerCase() === '.zip'
        ? await installFromZip(sourcePath, installPath)
        : await installFromMarkdown(sourcePath, installPath)

    const content = await readFile(join(installPath, installed.entryFile), 'utf8')
    const meta = deriveSkillMeta(content, installed.fallbackName)
    // 登记可读子文档，Agent 之后只能读这份清单里的路径。
    const docPaths = await scanSkillDocs(installPath, installed.entryFile)

    return skillRepo.create({
      id: skillId,
      name: meta.name,
      description: meta.description,
      version: meta.version,
      install_path: installPath,
      entry_file: installed.entryFile,
      source_kind: installed.sourceKind,
      source_label: basename(sourcePath),
      content_chars: content.length,
      doc_paths: docPaths
    })
  } catch (err) {
    await rm(installPath, { recursive: true, force: true }).catch(() => {})
    throw err
  }
}

export async function uninstallSkill(id: string): Promise<void> {
  const skill = skillRepo.getById(id)
  if (!skill) return

  // 只允许删除受管目录内的路径，防止数据库被改写后误删用户文件。
  const managedRoot = resolve(getSkillsRoot())
  const target = resolve(skill.install_path)
  const relativePath = relative(managedRoot, target)
  const isInsideManagedRoot = relativePath !== '' &&
    !relativePath.startsWith('..') &&
    !relativePath.includes(sep === '\\' ? '..\\' : '../')

  skillRepo.delete(id)
  if (isInsideManagedRoot) {
    await rm(target, { recursive: true, force: true }).catch(() => {})
  }
}

/** 读取技能主文件正文；文件缺失时返回空串，让调用方安静降级。 */
export async function readSkillContent(skill: SkillRecord): Promise<string> {
  try {
    return await readFile(join(skill.install_path, skill.entry_file), 'utf8')
  } catch {
    return ''
  }
}

interface InstallResult {
  entryFile: string
  sourceKind: SkillSourceKind
  fallbackName: string
}

async function installFromFolder(sourcePath: string, installPath: string): Promise<InstallResult> {
  const budget = { bytes: 0, files: 0 }
  await copyTextTree(sourcePath, installPath, budget, 0)

  if (budget.files === 0) {
    throw new Error('这个文件夹里没有找到可导入的文本文件')
  }

  const entryFile = await findEntryFile(installPath)
  if (!entryFile) {
    throw new Error('文件夹里没有找到 SKILL.md，请选择包含 SKILL.md 的技能目录')
  }

  return { entryFile, sourceKind: 'folder', fallbackName: basename(sourcePath) }
}

async function installFromZip(sourcePath: string, installPath: string): Promise<InstallResult> {
  const fileStat = await stat(sourcePath)
  if (fileStat.size > MAX_SKILL_BYTES) {
    throw new Error('压缩包超过 30MB，请精简后重试')
  }

  const buffer = await readFile(sourcePath)
  const entries = readZipEntries(buffer, {
    maxEntries: MAX_SKILL_ZIP_ENTRIES,
    maxEntryUncompressedBytes: MAX_SKILL_ZIP_ENTRY_BYTES,
    maxTotalUncompressedBytes: MAX_SKILL_BYTES,
    maxCompressionRatio: MAX_SKILL_ZIP_COMPRESSION_RATIO
  })
  const prefix = findCommonPrefix(entries.filter(entry => !entry.isDirectory).map(entry => entry.path))

  let totalBytes = 0
  let fileCount = 0

  for (const entry of entries) {
    if (entry.isDirectory) continue

    const relativePath = entry.path.slice(prefix.length)
    if (!relativePath || !isSafeRelativePath(relativePath)) continue
    if (!ALLOWED_EXTENSIONS.has(extname(relativePath).toLowerCase())) continue
    if (relativePath.split('/').some(segment => SKIPPED_DIRECTORIES.has(segment))) continue
    if (relativePath.split('/').length - 1 > MAX_SKILL_DEPTH) continue

    fileCount += 1
    if (fileCount > MAX_SKILL_FILES) throw new Error('压缩包内文件过多，请精简后重试')

    const content = entry.read()
    if (content.length !== entry.uncompressedSize) {
      throw new Error('压缩包内文件的实际大小与目录声明不一致')
    }
    if (content.length > MAX_SKILL_ZIP_ENTRY_BYTES) {
      throw new Error('压缩包内单个文件过大，请精简后重试')
    }
    totalBytes += content.length
    if (totalBytes > MAX_SKILL_BYTES) throw new Error('压缩包解压后超过 30MB，请精简后重试')

    const targetPath = join(installPath, ...relativePath.split('/'))
    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, content)
  }

  if (fileCount === 0) {
    throw new Error('压缩包里没有找到可导入的文本文件')
  }

  const entryFile = await findEntryFile(installPath)
  if (!entryFile) {
    throw new Error('压缩包里没有找到 SKILL.md，请确认这是一个技能包')
  }

  return { entryFile, sourceKind: 'zip', fallbackName: basename(sourcePath, extname(sourcePath)) }
}

async function installFromMarkdown(sourcePath: string, installPath: string): Promise<InstallResult> {
  const ext = extname(sourcePath).toLowerCase()
  if (ext !== '.md' && ext !== '.markdown' && ext !== '.txt') {
    throw new Error('请选择文件夹、zip 压缩包或 markdown 文件')
  }

  const fileStat = await stat(sourcePath)
  if (fileStat.size > MAX_SKILL_BYTES) {
    throw new Error('技能文件超过 30MB，请精简后重试')
  }

  const content = await readFile(sourcePath, 'utf8')
  if (!content.trim()) {
    throw new Error('这个文件是空的')
  }

  await writeFile(join(installPath, 'SKILL.md'), content, 'utf8')
  return { entryFile: 'SKILL.md', sourceKind: 'markdown', fallbackName: basename(sourcePath, ext) }
}

/**
 * 递归复制文本文件。二进制、超深目录和黑名单目录都会被跳过，
 * 因为技能只需要 markdown 和少量脚本。
 */
async function copyTextTree(
  sourceDir: string,
  targetDir: string,
  budget: { bytes: number; files: number },
  depth: number
): Promise<void> {
  if (depth > MAX_SKILL_DEPTH) return

  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue

    const sourcePath = join(sourceDir, entry.name)
    const targetPath = join(targetDir, entry.name)

    if (entry.isDirectory()) {
      await mkdir(targetPath, { recursive: true })
      await copyTextTree(sourcePath, targetPath, budget, depth + 1)
      continue
    }

    if (!entry.isFile()) continue
    if (!ALLOWED_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue

    const fileStat = await stat(sourcePath)
    budget.bytes += fileStat.size
    budget.files += 1
    if (budget.bytes > MAX_SKILL_BYTES) throw new Error('技能包超过 30MB，请精简后重试')
    if (budget.files > MAX_SKILL_FILES) throw new Error('技能包内文件过多，请精简后重试')

    await mkdir(dirname(targetPath), { recursive: true })
    await writeFile(targetPath, await readFile(sourcePath))
  }
}

/**
 * 找技能主文件：优先根目录 SKILL.md，其次任意大小写变体，
 * 最后退回根目录下唯一的 markdown 文件。
 */
async function findEntryFile(installPath: string): Promise<string | null> {
  const entries = await readdir(installPath, { withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => entry.name)

  const exact = files.find(name => name === 'SKILL.md')
  if (exact) return exact

  const caseInsensitive = files.find(name => name.toLowerCase() === 'skill.md')
  if (caseInsensitive) return caseInsensitive

  const markdownFiles = files.filter(name => {
    const ext = extname(name).toLowerCase()
    return ext === '.md' || ext === '.markdown'
  })
  const readmeIndex = markdownFiles.findIndex(name => name.toLowerCase().startsWith('readme'))
  if (markdownFiles.length === 1) return markdownFiles[0]
  if (markdownFiles.length > 1) {
    // README 通常是仓库说明而不是技能本体，优先选别的。
    const preferred = markdownFiles.find((_, index) => index !== readmeIndex)
    return preferred ?? markdownFiles[0]
  }

  return null
}

/** 剥掉 GitHub zip 常见的 `repo-master/` 顶层目录。 */
function findCommonPrefix(paths: string[]): string {
  if (paths.length === 0) return ''
  const firstSegments = paths[0].split('/')
  if (firstSegments.length < 2) return ''

  const candidate = `${firstSegments[0]}/`
  return paths.every(path => path.startsWith(candidate)) ? candidate : ''
}

/** 阻断 `../` 穿越和绝对路径，避免 zip slip。 */
function isSafeRelativePath(relativePath: string): boolean {
  if (relativePath.startsWith('/') || /^[A-Za-z]:/.test(relativePath)) return false
  return !relativePath.split('/').some(segment => segment === '..' || segment === '')
}
