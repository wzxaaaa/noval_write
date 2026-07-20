import { app, ipcMain, dialog, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { chapterRepo } from '../db/repositories/chapter.repo'
import { projectRepo } from '../db/repositories/project.repo'
import {
  approvePath,
  assertTrustedIpcSender,
  consumeApprovedPath,
  type ApprovedPathPurpose
} from '../utils/approved-paths'
import { htmlToPlainText } from '../../shared/textMetrics'
import { createWriteStream } from 'fs'
import { mkdir, stat } from 'fs/promises'
import { once } from 'events'
import { basename, extname, isAbsolute, join } from 'path'

export function registerFileHandlers(): void {
  handleTrusted('file:createProject', async (_event, name: string, rootPath: string) => {
    const cleanName = typeof name === 'string' ? name.trim() : ''
    if (!cleanName) throw new Error('Project name is required')
    const approvedRoot = await resolveProjectRoot(cleanName, rootPath)
    const project = projectRepo.create(cleanName, approvedRoot)
    return project
  })

  handleTrusted('file:listProjects', async () => {
    return projectRepo.list()
  })

  handleTrusted('file:getProject', async (_event, id: string) => {
    return projectRepo.getById(id)
  })

  handleTrusted('file:deleteProject', async (_event, id: string) => {
    projectRepo.delete(id)
  })

  handleTrusted('file:getChapterWordTarget', async (_event, projectId: string) => {
    return projectRepo.getChapterWordTarget(projectId)
  })

  handleTrusted('file:setChapterWordTarget', async (_event, projectId: string, value: number | null) => {
    return projectRepo.setChapterWordTarget(projectId, value ?? null)
  })

  handleTrusted('file:listChapters', async (_event, projectId: string) => {
    return chapterRepo.listByProject(projectId)
  })

  handleTrusted('file:createChapter', async (_event, params: {
    projectId: string
    parentId?: string | null
    title: string
    content?: string
  }) => {
    const chapters = chapterRepo.listByProject(params.projectId)
    const nextOrder = chapters.reduce((max, chapter) => Math.max(max, chapter.sort_order), -1) + 1
    return chapterRepo.create({
      project_id: params.projectId,
      parent_id: params.parentId ?? null,
      title: params.title,
      content: params.content,
      sort_order: nextOrder
    })
  })

  handleTrusted('file:saveChapter', async (_event, id: string, content: string) => {
    return chapterRepo.updateContent(id, content)
  })

  handleTrusted('file:renameChapter', async (_event, id: string, title: string) => {
    chapterRepo.updateTitle(id, title)
  })

  handleTrusted('file:deleteChapter', async (_event, id: string) => {
    chapterRepo.delete(id)
  })

  handleTrusted('file:updateChapterOrder', async (_event, chapterIds: string[]) => {
    return chapterRepo.reorder(chapterIds)
  })

  handleTrusted('file:listChapterVersions', async (_event, chapterId: string) => {
    return chapterRepo.listVersions(chapterId)
  })

  handleTrusted('file:exportProjectTxt', async (event, projectId: string) => {
    const project = projectRepo.getById(projectId)
    if (!project) throw new Error('Project not found')

    const chapters = chapterRepo.listByProject(projectId)
    if (chapters.length === 0) throw new Error('No chapters to export')

    const win = BrowserWindow.fromWebContents(event.sender) ?? BrowserWindow.getFocusedWindow()
    if (!win) return { canceled: true as const }

    const result = await dialog.showSaveDialog(win, {
      defaultPath: join(project.root_path || '', `${sanitizeFileName(project.name || 'novel')}.txt`),
      filters: [{ name: 'Text', extensions: ['txt'] }]
    })
    if (result.canceled || !result.filePath) return { canceled: true as const }

    const stream = createWriteStream(result.filePath, { encoding: 'utf8' })
    event.sender.send('file:exportProgress', { projectId, done: 0, total: chapters.length, percent: 0, status: 'started' })

    try {
      await writeChunk(stream, `${project.name}\n${'='.repeat(Math.max(4, Array.from(project.name).length))}\n\n`)
      for (let index = 0; index < chapters.length; index++) {
        const chapter = chapters[index]
        const title = cleanTitle(chapter.title) || `Chapter ${index + 1}`
        const body = htmlToPlainText(chapter.content)
        const chunk = `${title}\n${'-'.repeat(Math.max(4, Array.from(title).length))}\n\n${body}\n\n`
        await writeChunk(stream, chunk)
        event.sender.send('file:exportProgress', {
          projectId,
          done: index + 1,
          total: chapters.length,
          percent: Math.round(((index + 1) / chapters.length) * 100),
          status: 'writing'
        })
      }
      stream.end()
      await once(stream, 'finish')
      event.sender.send('file:exportProgress', { projectId, done: chapters.length, total: chapters.length, percent: 100, status: 'done' })
      return { canceled: false as const, filePath: result.filePath, fileName: basename(result.filePath), chapterCount: chapters.length }
    } catch (err) {
      stream.destroy()
      event.sender.send('file:exportProgress', { projectId, done: 0, total: chapters.length, percent: 0, status: 'error', message: (err as Error).message })
      throw err
    }
  })

  handleTrusted('file:openFileDialog', async (_event, options: {
    filters?: { name: string; extensions: string[] }[]
    properties?: Array<'openFile' | 'openDirectory' | 'multiSelections'>
  }) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null

    const result = await dialog.showOpenDialog(win, {
      properties: options.properties || ['openFile'],
      filters: options.filters
    })

    if (result.canceled) return null
    await approveDialogPaths(result.filePaths)
    return result.filePaths
  })

  handleTrusted('file:saveFileDialog', async (_event, options: {
    defaultPath?: string
    filters?: { name: string; extensions: string[] }[]
  }) => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return null

    const result = await dialog.showSaveDialog(win, {
      defaultPath: options.defaultPath,
      filters: options.filters
    })

    return result.canceled ? null : result.filePath
  })
}

type TrustedIpcHandler = (event: IpcMainInvokeEvent, ...args: any[]) => any

function handleTrusted(channel: string, handler: TrustedIpcHandler): void {
  ipcMain.handle(channel, (event, ...args) => {
    assertTrustedIpcSender(event)
    return handler(event, ...args)
  })
}

async function resolveProjectRoot(projectName: string, requestedRootPath: string): Promise<string> {
  const managedProjectsDirectory = join(app.getPath('userData'), 'projects')
  await mkdir(managedProjectsDirectory, { recursive: true })

  if (typeof requestedRootPath === 'string' && isAbsolute(requestedRootPath)) {
    const approvedRoot = consumeApprovedPath(requestedRootPath, 'project-root')
    if (!approvedRoot) {
      throw new Error('Project directory must be selected with the folder picker')
    }
    const rootStat = await stat(approvedRoot)
    if (!rootStat.isDirectory()) throw new Error('Selected project path is not a directory')
    return approvedRoot
  }

  // The existing UI sends the project name when the optional path is empty.
  // Resolve that case into an app-owned directory instead of the process cwd.
  const directoryName = sanitizeDirectoryName(projectName)
  const managedProjectPath = join(managedProjectsDirectory, directoryName)
  await mkdir(managedProjectPath, { recursive: true })
  return managedProjectPath
}

async function approveDialogPaths(paths: string[]): Promise<void> {
  for (const path of paths) {
    try {
      const fileStat = await stat(path)
      const purposes: ApprovedPathPurpose[] = []

      if (fileStat.isDirectory()) {
        // A directory can be either a project root or a skill package; the
        // consumer decides which, and each approval is consumed only once.
        purposes.push('project-root', 'skill-package')
      } else if (fileStat.isFile()) {
        const ext = extname(path).toLowerCase()
        if (['.txt', '.md'].includes(ext)) purposes.push('knowledge-document', 'skill-package')
        if (['.markdown', '.zip'].includes(ext)) purposes.push('skill-package')
        if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) purposes.push('background-image')
      }

      for (const purpose of purposes) approvePath(path, purpose)
    } catch {
      // A picker result may disappear before it can be approved. The consumer
      // will reject it and ask the user to select it again.
    }
  }
}

async function writeChunk(stream: NodeJS.WritableStream, chunk: string): Promise<void> {
  if (!stream.write(chunk)) {
    await once(stream, 'drain')
  }
}

function cleanTitle(title: string): string {
  return htmlToPlainText(title).replace(/\s+/g, ' ').trim()
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, '_').trim() || 'novel'
}

function sanitizeDirectoryName(value: string): string {
  return value
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[. ]+$/g, '')
    .trim() || 'novel'
}
