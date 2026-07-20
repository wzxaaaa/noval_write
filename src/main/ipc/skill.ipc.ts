import { ipcMain } from 'electron'
import { skillRepo } from '../db/repositories/skill.repo'
import { installSkillFromPath, uninstallSkill } from '../services/skills/skill-installer'
import { assertTrustedIpcSender, consumeApprovedPath } from '../utils/approved-paths'
import type { SkillBindings } from '../../shared/skills'

export function registerSkillHandlers(): void {
  ipcMain.handle('skill:list', async (event) => {
    assertTrustedIpcSender(event)
    return skillRepo.list()
  })

  ipcMain.handle('skill:import', async (event, sourcePath: string) => {
    assertTrustedIpcSender(event)
    const approvedPath = consumeApprovedPath(sourcePath, 'skill-package')
    if (!approvedPath) {
      throw new Error('技能路径不是用户刚刚选择的，请重新选择')
    }
    return installSkillFromPath(approvedPath)
  })

  ipcMain.handle('skill:rename', async (event, id: string, name: string) => {
    assertTrustedIpcSender(event)
    skillRepo.rename(id, name)
    return skillRepo.getById(id)
  })

  ipcMain.handle('skill:delete', async (event, id: string) => {
    assertTrustedIpcSender(event)
    await uninstallSkill(id)
  })

  ipcMain.handle('skill:getBindings', async (event) => {
    assertTrustedIpcSender(event)
    return skillRepo.getBindings()
  })

  ipcMain.handle('skill:setBindings', async (event, bindings: SkillBindings) => {
    assertTrustedIpcSender(event)
    return skillRepo.setBindings(bindings)
  })
}
