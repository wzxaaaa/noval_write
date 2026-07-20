import { ipcMain } from 'electron'
import { outlineRepo, type OutlineType } from '../db/repositories/outline.repo'
import { assertTrustedIpcSender } from '../utils/approved-paths'

export function registerOutlineHandlers(): void {
  ipcMain.handle('outline:list', async (event, projectId: string) => {
    assertTrustedIpcSender(event)
    return outlineRepo.listByProject(projectId)
  })

  ipcMain.handle('outline:get', async (event, id: string) => {
    assertTrustedIpcSender(event)
    return outlineRepo.getById(id)
  })

  ipcMain.handle('outline:create', async (event, params: {
    projectId: string
    type: OutlineType
    title: string
    content?: string
  }) => {
    assertTrustedIpcSender(event)
    return outlineRepo.create(params.projectId, params.type, params.title, params.content)
  })

  ipcMain.handle('outline:update', async (event, id: string, updates: { title?: string; content?: string }) => {
    assertTrustedIpcSender(event)
    outlineRepo.update(id, updates)
  })

  ipcMain.handle('outline:saveContent', async (event, id: string, content: string) => {
    assertTrustedIpcSender(event)
    outlineRepo.updateContent(id, content)
  })

  ipcMain.handle('outline:delete', async (event, id: string) => {
    assertTrustedIpcSender(event)
    outlineRepo.delete(id)
  })
}
