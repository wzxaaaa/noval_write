import { ipcMain } from 'electron'
import { existsSync, statSync } from 'fs'
import { extname, isAbsolute, relative, resolve } from 'path'
import { knowledgeDocRepo } from '../db/repositories/knowledge-doc.repo'
import { projectRepo } from '../db/repositories/project.repo'
import { retrieverService } from '../services/knowledge/retriever'
import { isApprovedPath } from '../utils/approved-paths'

export function registerKnowledgeHandlers(): void {
  ipcMain.handle('knowledge:importDocument', async (_event, filePath: string, projectId: string) => {
    const project = projectRepo.getById(projectId)
    if (!project) throw new Error('Project not found')

    const normalizedPath = resolve(filePath)
    const projectRoot = resolve(project.root_path)
    const relativeToProject = relative(projectRoot, normalizedPath)
    const isInsideProject = relativeToProject !== '' && !relativeToProject.startsWith('..') && !isAbsolute(relativeToProject)
    if (!isApprovedPath(normalizedPath) && !isInsideProject) {
      throw new Error('File path was not selected by the user')
    }

    if (!existsSync(normalizedPath) || !statSync(normalizedPath).isFile()) {
      throw new Error('Selected path is not a file')
    }

    const ext = extname(normalizedPath).toLowerCase()
    if (!['.txt', '.md'].includes(ext)) {
      throw new Error('Only .txt and .md files are supported')
    }

    const doc = await retrieverService.indexDocument(normalizedPath, projectId)
    return doc
  })

  ipcMain.handle('knowledge:search', async (_event, query: string, projectId: string, options?: { limit?: number }) => {
    return retrieverService.search(query, projectId, options)
  })

  ipcMain.handle('knowledge:searchContext', async (_event, query: string, projectId: string) => {
    return retrieverService.searchContext(query, projectId)
  })

  ipcMain.handle('knowledge:listDocuments', async (_event, projectId: string) => {
    return knowledgeDocRepo.listByProject(projectId)
  })

  ipcMain.handle('knowledge:deleteDocument', async (_event, docId: string) => {
    await retrieverService.removeDocument(docId)
    knowledgeDocRepo.delete(docId)
  })
}
