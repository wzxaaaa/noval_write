import { ipcMain } from 'electron'
import { outlineRepo, type OutlineType } from '../db/repositories/outline.repo'

export function registerOutlineHandlers(): void {
  ipcMain.handle('outline:list', async (_event, projectId: string) => {
    return outlineRepo.listByProject(projectId)
  })

  ipcMain.handle('outline:get', async (_event, id: string) => {
    return outlineRepo.getById(id)
  })

  ipcMain.handle('outline:create', async (_event, params: {
    projectId: string
    type: OutlineType
    title: string
    content?: string
  }) => {
    return outlineRepo.create(params.projectId, params.type, params.title, params.content)
  })

  ipcMain.handle('outline:update', async (_event, id: string, updates: { title?: string; content?: string }) => {
    outlineRepo.update(id, updates)
  })

  ipcMain.handle('outline:saveContent', async (_event, id: string, content: string) => {
    outlineRepo.updateContent(id, content)
  })

  ipcMain.handle('outline:delete', async (_event, id: string) => {
    outlineRepo.delete(id)
  })
}
