import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from './types'

const api: ElectronAPI = {
  file: {
    createProject: (name, rootPath, agentGroupId) => ipcRenderer.invoke('file:createProject', name, rootPath, agentGroupId),
    listProjects: () => ipcRenderer.invoke('file:listProjects'),
    getProject: (id) => ipcRenderer.invoke('file:getProject', id),
    deleteProject: (id) => ipcRenderer.invoke('file:deleteProject', id),
    listChapters: (projectId) => ipcRenderer.invoke('file:listChapters', projectId),
    createChapter: (params) => ipcRenderer.invoke('file:createChapter', params),
    saveChapter: (id, content) => ipcRenderer.invoke('file:saveChapter', id, content),
    renameChapter: (id, title) => ipcRenderer.invoke('file:renameChapter', id, title),
    deleteChapter: (id) => ipcRenderer.invoke('file:deleteChapter', id),
    updateChapterOrder: (chapterIds) => ipcRenderer.invoke('file:updateChapterOrder', chapterIds),
    listChapterVersions: (chapterId) => ipcRenderer.invoke('file:listChapterVersions', chapterId),
    exportProjectTxt: (projectId) => ipcRenderer.invoke('file:exportProjectTxt', projectId),
    onExportProgress: (callback) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('file:exportProgress', handler)
      return () => ipcRenderer.removeListener('file:exportProgress', handler)
    },
    openFileDialog: (options) => ipcRenderer.invoke('file:openFileDialog', options),
    saveFileDialog: (options) => ipcRenderer.invoke('file:saveFileDialog', options),
  },
  ai: {
    listProviders: () => ipcRenderer.invoke('ai:listProviders'),
    getProvider: (id) => ipcRenderer.invoke('ai:getProvider', id),
    createProvider: (params) => ipcRenderer.invoke('ai:createProvider', params),
    updateProvider: (id, updates) => ipcRenderer.invoke('ai:updateProvider', id, updates),
    deleteProvider: (id) => ipcRenderer.invoke('ai:deleteProvider', id),
    testConnection: (configId) => ipcRenderer.invoke('ai:testConnection', configId),
    createConversation: (projectId, chapterId, title, providerConfigId) =>
      ipcRenderer.invoke('ai:createConversation', projectId, chapterId, title, providerConfigId),
    listConversations: (projectId) => ipcRenderer.invoke('ai:listConversations', projectId),
    getMessages: (conversationId) => ipcRenderer.invoke('ai:getMessages', conversationId),
    sendMessage: (params) => ipcRenderer.invoke('ai:sendMessage', params),
    sendMessageSync: (params) => ipcRenderer.invoke('ai:sendMessageSync', params),
    planChapterEdit: (params) => ipcRenderer.invoke('ai:planChapterEdit', params),
    onToken: (callback) => {
      const handler = (_event: any, data: { conversationId: string; token: string }) => callback(data)
      ipcRenderer.on('ai:token', handler)
      return () => ipcRenderer.removeListener('ai:token', handler)
    },
  },
  appAgent: {
    sendMessage: (params) => ipcRenderer.invoke('appAgent:sendMessage', params),
    onAction: (callback) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('appAgent:action', handler)
      return () => ipcRenderer.removeListener('appAgent:action', handler)
    },
  },
  settings: {
    getAppearance: () => ipcRenderer.invoke('settings:getAppearance'),
    updateAppearance: (updates) => ipcRenderer.invoke('settings:updateAppearance', updates),
    importBackgroundImage: (filePath) => ipcRenderer.invoke('settings:importBackgroundImage', filePath),
    clearBackgroundImage: () => ipcRenderer.invoke('settings:clearBackgroundImage'),
  },
  knowledge: {
    importDocument: (filePath, projectId) => ipcRenderer.invoke('knowledge:importDocument', filePath, projectId),
    search: (query, projectId, options) => ipcRenderer.invoke('knowledge:search', query, projectId, options),
    searchContext: (query, projectId) => ipcRenderer.invoke('knowledge:searchContext', query, projectId),
    listDocuments: (projectId) => ipcRenderer.invoke('knowledge:listDocuments', projectId),
    deleteDocument: (docId) => ipcRenderer.invoke('knowledge:deleteDocument', docId),
  },
  outline: {
    list: (projectId) => ipcRenderer.invoke('outline:list', projectId),
    get: (id) => ipcRenderer.invoke('outline:get', id),
    create: (params) => ipcRenderer.invoke('outline:create', params),
    update: (id, updates) => ipcRenderer.invoke('outline:update', id, updates),
    saveContent: (id, content) => ipcRenderer.invoke('outline:saveContent', id, content),
    delete: (id) => ipcRenderer.invoke('outline:delete', id),
  },
  agent: {
    list: () => ipcRenderer.invoke('agent:list'),
    get: (id) => ipcRenderer.invoke('agent:get', id),
    create: (params) => ipcRenderer.invoke('agent:create', params),
    update: (id, updates) => ipcRenderer.invoke('agent:update', id, updates),
    delete: (id) => ipcRenderer.invoke('agent:delete', id),
    listCategories: () => ipcRenderer.invoke('agent:listCategories'),
    createCategory: (name) => ipcRenderer.invoke('agent:createCategory', name),
    updateCategory: (id, name) => ipcRenderer.invoke('agent:updateCategory', id, name),
    deleteCategory: (id) => ipcRenderer.invoke('agent:deleteCategory', id),
    listGroups: (projectId) => ipcRenderer.invoke('agent:listGroups', projectId),
    listAllGroups: () => ipcRenderer.invoke('agent:listAllGroups'),
    createGroup: (name, projectId, collaborationMode) => ipcRenderer.invoke('agent:createGroup', name, projectId, collaborationMode),
    updateGroup: (id, updates) => ipcRenderer.invoke('agent:updateGroup', id, updates),
    getGroup: (id) => ipcRenderer.invoke('agent:getGroup', id),
    getGroupMembers: (groupId) => ipcRenderer.invoke('agent:getGroupMembers', groupId),
    addGroupMember: (groupId, agentId, turnOrder, canInitiate, isModerator) => ipcRenderer.invoke('agent:addGroupMember', groupId, agentId, turnOrder, canInitiate, isModerator),
    removeGroupMember: (groupId, agentId) => ipcRenderer.invoke('agent:removeGroupMember', groupId, agentId),
    deleteGroup: (groupId) => ipcRenderer.invoke('agent:deleteGroup', groupId),
    bindProjectGroup: (projectId, groupId) => ipcRenderer.invoke('agent:bindProjectGroup', projectId, groupId),
    runWorkflow: (groupId, projectId, inputContext) => ipcRenderer.invoke('agent:runWorkflow', groupId, projectId, inputContext),
    stopWorkflow: () => ipcRenderer.invoke('agent:stopWorkflow'),
    sendWorkflowMessage: (message) => ipcRenderer.invoke('agent:sendWorkflowMessage', message),
    onWorkflowEvent: (callback) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('agent:workflowEvent', handler)
      return () => ipcRenderer.removeListener('agent:workflowEvent', handler)
    },
    onChapterUpdate: (callback) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('agent:chapterUpdate', handler)
      return () => ipcRenderer.removeListener('agent:chapterUpdate', handler)
    },
    onChapterCreated: (callback) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('agent:chapterCreated', handler)
      return () => ipcRenderer.removeListener('agent:chapterCreated', handler)
    },
  }
}

contextBridge.exposeInMainWorld('electronAPI', api)
