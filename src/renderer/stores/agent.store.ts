import { create } from 'zustand'
import type { AgentConfig, AgentGroup, AgentGroupMember, AgentCategory, WorkflowEvent } from '../../preload/types'

interface CompletedSnapshot {
  tokens: string
  thinking: string
}

interface AgentState {
  agents: AgentConfig[]
  categories: AgentCategory[]
  groups: AgentGroup[]
  groupMembers: Record<string, AgentGroupMember[]>
  workflowEvents: WorkflowEvent[]
  isRunning: boolean

  inputContext: string
  runtimeInput: string
  selectedGroupId: string | null
  agentTokenBuffer: Record<string, string>
  agentThinkingBuffer: Record<string, string>
  completedSnapshots: Record<number, CompletedSnapshot>
  expandedThinking: Record<string, boolean>
  proposalStatus: string | null

  setAgents: (agents: AgentConfig[]) => void
  addAgent: (agent: AgentConfig) => void
  updateAgent: (id: string, updates: Partial<AgentConfig>) => void
  removeAgent: (id: string) => void
  setCategories: (categories: AgentCategory[]) => void
  addCategory: (category: AgentCategory) => void
  updateCategory: (id: string, name: string) => void
  removeCategory: (id: string) => void
  setGroups: (groups: AgentGroup[]) => void
  addGroup: (group: AgentGroup) => void
  removeGroup: (id: string) => void
  setGroupMembers: (groupId: string, members: AgentGroupMember[]) => void
  addWorkflowEvent: (event: WorkflowEvent) => void
  clearWorkflowEvents: () => void
  setRunning: (running: boolean) => void

  setInputContext: (value: string) => void
  setRuntimeInput: (value: string) => void
  setSelectedGroupId: (id: string | null) => void
  setAgentTokenBuffer: (buffer: Record<string, string>) => void
  setAgentThinkingBuffer: (buffer: Record<string, string>) => void
  setCompletedSnapshots: (snapshots: Record<number, CompletedSnapshot>) => void
  setExpandedThinking: (state: Record<string, boolean>) => void
  setProposalStatus: (status: string | null) => void
  resetRuntimeState: () => void
  resetBuffers: () => void
}

export const useAgentStore = create<AgentState>((set) => ({
  agents: [],
  categories: [],
  groups: [],
  groupMembers: {},
  workflowEvents: [],
  isRunning: false,

  inputContext: '',
  runtimeInput: '',
  selectedGroupId: null,
  agentTokenBuffer: {},
  agentThinkingBuffer: {},
  completedSnapshots: {},
  expandedThinking: {},
  proposalStatus: null,

  setAgents: (agents) => set({ agents }),
  addAgent: (agent) => set((s) => ({ agents: [...s.agents, agent] })),
  updateAgent: (id, updates) => set((s) => ({
    agents: s.agents.map(a => a.id === id ? { ...a, ...updates } : a)
  })),
  removeAgent: (id) => set((s) => ({
    agents: s.agents.filter(a => a.id !== id)
  })),
  setCategories: (categories) => set({ categories }),
  addCategory: (category) => set((s) => ({ categories: [...s.categories, category] })),
  updateCategory: (id, name) => set((s) => ({
    categories: s.categories.map(c => c.id === id ? { ...c, name } : c)
  })),
  removeCategory: (id) => set((s) => ({
    categories: s.categories.filter(c => c.id !== id)
  })),
  setGroups: (groups) => set({ groups }),
  addGroup: (group) => set((s) => ({ groups: [...s.groups, group] })),
  removeGroup: (id) => set((s) => ({
    groups: s.groups.filter(g => g.id !== id)
  })),
  setGroupMembers: (groupId, members) => set((s) => ({
    groupMembers: { ...s.groupMembers, [groupId]: members }
  })),
  addWorkflowEvent: (event) => set((s) => ({
    workflowEvents: [...s.workflowEvents, event]
  })),
  clearWorkflowEvents: () => set({ workflowEvents: [] }),
  setRunning: (running) => set({ isRunning: running }),

  setInputContext: (inputContext) => set({ inputContext }),
  setRuntimeInput: (runtimeInput) => set({ runtimeInput }),
  setSelectedGroupId: (selectedGroupId) => set({ selectedGroupId }),
  setAgentTokenBuffer: (agentTokenBuffer) => set({ agentTokenBuffer }),
  setAgentThinkingBuffer: (agentThinkingBuffer) => set({ agentThinkingBuffer }),
  setCompletedSnapshots: (completedSnapshots) => set({ completedSnapshots }),
  setExpandedThinking: (expandedThinking) => set({ expandedThinking }),
  setProposalStatus: (proposalStatus) => set({ proposalStatus }),

  resetRuntimeState: () => set({
    agentTokenBuffer: {},
    agentThinkingBuffer: {},
    completedSnapshots: {},
    expandedThinking: {},
    proposalStatus: null,
    runtimeInput: '',
    inputContext: '',
    selectedGroupId: null,
    isRunning: false,
    workflowEvents: []
  }),

  resetBuffers: () => set({
    agentTokenBuffer: {},
    agentThinkingBuffer: {},
    completedSnapshots: {},
    expandedThinking: {},
    proposalStatus: null,
    workflowEvents: []
  })
}))
