import { registerFileHandlers } from './file.ipc'
import { registerAIHandlers } from './ai.ipc'
import { registerKnowledgeHandlers } from './knowledge.ipc'
import { registerAgentHandlers } from './agent.ipc'
import { registerOutlineHandlers } from './outline.ipc'
import { registerAppAgentHandlers } from './app-agent.ipc'
import { registerSettingsHandlers } from './settings.ipc'
import { registerSkillHandlers } from './skill.ipc'
import { registerLifecycleHandlers } from './lifecycle.ipc'

export function registerAllHandlers(): void {
  registerFileHandlers()
  registerAIHandlers()
  registerKnowledgeHandlers()
  registerAgentHandlers()
  registerOutlineHandlers()
  registerAppAgentHandlers()
  registerSettingsHandlers()
  registerSkillHandlers()
  registerLifecycleHandlers()
}
