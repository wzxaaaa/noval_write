import { ipcMain } from 'electron'
import { stat } from 'fs/promises'
import { extname } from 'path'
import { knowledgeDocRepo } from '../db/repositories/knowledge-doc.repo'
import { projectRepo } from '../db/repositories/project.repo'
import { retrieverService } from '../services/knowledge/retriever'
import { MAX_KNOWLEDGE_DOCUMENT_BYTES } from '../services/knowledge/document-parser'
import { assertTrustedIpcSender, consumeApprovedPath } from '../utils/approved-paths'

export function registerKnowledgeHandlers(): void {
  ipcMain.handle('knowledge:importDocument', async (event, filePath: string, projectId: string) => {
    assertTrustedIpcSender(event)
    const project = projectRepo.getById(projectId)
    if (!project) throw new Error('Project not found')

    const normalizedPath = consumeApprovedPath(filePath, 'knowledge-document')
    if (!normalizedPath) {
      throw new Error('File path was not selected by the user')
    }

    const fileStat = await stat(normalizedPath)
    if (!fileStat.isFile()) {
      throw new Error('Selected path is not a file')
    }
    if (fileStat.size > MAX_KNOWLEDGE_DOCUMENT_BYTES) {
      throw new Error(`Knowledge documents cannot exceed ${MAX_KNOWLEDGE_DOCUMENT_BYTES / 1024 / 1024}MB`)
    }

    const ext = extname(normalizedPath).toLowerCase()
    if (!['.txt', '.md'].includes(ext)) {
      throw new Error('Only .txt and .md files are supported')
    }

    const doc = await retrieverService.indexDocument(normalizedPath, projectId)
    return doc
  })

  ipcMain.handle('knowledge:search', async (event, query: string, projectId: string, options?: { limit?: number }) => {
    assertTrustedIpcSender(event)
    return retrieverService.search(query, projectId, options)
  })

  ipcMain.handle('knowledge:searchContext', async (event, query: string, projectId: string) => {
    assertTrustedIpcSender(event)
    return retrieverService.searchContext(query, projectId)
  })

  ipcMain.handle('knowledge:listDocuments', async (event, projectId: string) => {
    assertTrustedIpcSender(event)
    return knowledgeDocRepo.listByProject(projectId)
  })

  ipcMain.handle('knowledge:deleteDocument', async (event, docId: string) => {
    assertTrustedIpcSender(event)
    await retrieverService.removeDocument(docId)
    knowledgeDocRepo.delete(docId)
  })
}
