import { contextBridge, ipcRenderer } from 'electron'
import type { ElectronAPI } from './types'

const api: ElectronAPI = {
  lifecycle: {
    onBeforeClose: (callback) => {
      const handler = () => callback()
      ipcRenderer.on('app:beforeClose', handler)
      return () => ipcRenderer.removeListener('app:beforeClose', handler)
    },
    completeClose: (saved) => ipcRenderer.invoke('app:completeClose', saved),
  },
  file: {
    createProject: (name, rootPath) => ipcRenderer.invoke('file:createProject', name, rootPath),
    listProjects: () => ipcRenderer.invoke('file:listProjects'),
    getProject: (id) => ipcRenderer.invoke('file:getProject', id),
    deleteProject: (id) => ipcRenderer.invoke('file:deleteProject', id),
    getChapterWordTarget: (projectId) => ipcRenderer.invoke('file:getChapterWordTarget', projectId),
    setChapterWordTarget: (projectId, value) => ipcRenderer.invoke('file:setChapterWordTarget', projectId, value),
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
    deleteConversation: (conversationId) => ipcRenderer.invoke('ai:deleteConversation', conversationId),
    getMessages: (conversationId) => ipcRenderer.invoke('ai:getMessages', conversationId),
    sendMessage: (params) => ipcRenderer.invoke('ai:sendMessage', params),
    abortStream: (conversationId) => ipcRenderer.invoke('ai:abortStream', conversationId),
    sendMessageSync: (params) => ipcRenderer.invoke('ai:sendMessageSync', params),
    planChapterEdit: (params) => ipcRenderer.invoke('ai:planChapterEdit', params),
    onToken: (callback) => {
      const handler = (_event: any, data: { conversationId: string; token: string }) => callback(data)
      ipcRenderer.on('ai:token', handler)
      return () => ipcRenderer.removeListener('ai:token', handler)
    },
    onThinking: (callback) => {
      const handler = (_event: any, data: { conversationId: string; thinking: string }) => callback(data)
      ipcRenderer.on('ai:thinking', handler)
      return () => ipcRenderer.removeListener('ai:thinking', handler)
    },
  },
  appAgent: {
    sendMessage: (params) => ipcRenderer.invoke('appAgent:sendMessage', params),
    abortMessage: (conversationId) => ipcRenderer.invoke('appAgent:abortMessage', conversationId),
    onAction: (callback) => {
      const handler = (_event: any, data: any) => callback(data)
      ipcRenderer.on('appAgent:action', handler)
      return () => ipcRenderer.removeListener('appAgent:action', handler)
    },
  },
  skill: {
    list: () => ipcRenderer.invoke('skill:list'),
    import: (sourcePath) => ipcRenderer.invoke('skill:import', sourcePath),
    rename: (id, name) => ipcRenderer.invoke('skill:rename', id, name),
    delete: (id) => ipcRenderer.invoke('skill:delete', id),
    getBindings: () => ipcRenderer.invoke('skill:getBindings'),
    setBindings: (bindings) => ipcRenderer.invoke('skill:setBindings', bindings),
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
    getWritingTeam: () => ipcRenderer.invoke('agent:getWritingTeam'),
    updateWritingAgent: (role, updates) => ipcRenderer.invoke('agent:updateWritingAgent', role, updates),
    runWritingWorkflow: (projectId, inputContext, chapterId) => ipcRenderer.invoke('agent:runWritingWorkflow', projectId, inputContext, chapterId),
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
