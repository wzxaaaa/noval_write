import { ipcMain, dialog, BrowserWindow } from 'electron'
import { chapterRepo } from '../db/repositories/chapter.repo'
import { projectRepo } from '../db/repositories/project.repo'
import { approvePaths } from '../utils/approved-paths'
import { htmlToPlainText } from '../../shared/textMetrics'
import { createWriteStream } from 'fs'
import { once } from 'events'
import { basename, join } from 'path'

export function registerFileHandlers(): void {
  ipcMain.handle('file:createProject', async (_event, name: string, rootPath: string, agentGroupId?: string | null) => {
    const project = projectRepo.create(name, rootPath, agentGroupId ? { default_agent_group_id: agentGroupId } : {})
    return project
  })

  ipcMain.handle('file:listProjects', async () => {
    return projectRepo.list()
  })

  ipcMain.handle('file:getProject', async (_event, id: string) => {
    return projectRepo.getById(id)
  })

  ipcMain.handle('file:deleteProject', async (_event, id: string) => {
    projectRepo.delete(id)
  })

  ipcMain.handle('file:listChapters', async (_event, projectId: string) => {
    return chapterRepo.listByProject(projectId)
  })

  ipcMain.handle('file:createChapter', async (_event, params: {
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

  ipcMain.handle('file:saveChapter', async (_event, id: string, content: string) => {
    return chapterRepo.updateContent(id, content)
  })

  ipcMain.handle('file:renameChapter', async (_event, id: string, title: string) => {
    chapterRepo.updateTitle(id, title)
  })

  ipcMain.handle('file:deleteChapter', async (_event, id: string) => {
    chapterRepo.delete(id)
  })

  ipcMain.handle('file:updateChapterOrder', async (_event, chapterIds: string[]) => {
    return chapterRepo.reorder(chapterIds)
  })

  ipcMain.handle('file:listChapterVersions', async (_event, chapterId: string) => {
    return chapterRepo.listVersions(chapterId)
  })

  ipcMain.handle('file:exportProjectTxt', async (event, projectId: string) => {
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

  ipcMain.handle('file:openFileDialog', async (_event, options: {
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
    approvePaths(result.filePaths)
    return result.filePaths
  })

  ipcMain.handle('file:saveFileDialog', async (_event, options: {
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
