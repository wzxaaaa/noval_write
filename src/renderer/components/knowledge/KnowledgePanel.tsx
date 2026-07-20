import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useKnowledgeStore } from '../../stores/knowledge.store'
import type { KnowledgeDoc } from '../../../preload/types'

interface KnowledgePanelProps {
  projectId: string | null
}

export function KnowledgePanel({ projectId }: KnowledgePanelProps) {
  const {
    documents,
    searchResults,
    searchQuery,
    isSearching,
    setDocuments,
    addDocument,
    removeDocument,
    setSearchResults,
    setSearchQuery,
    setSearching
  } = useKnowledgeStore()
  const [importStatus, setImportStatus] = useState<string | null>(null)
  const [importStatusProjectId, setImportStatusProjectId] = useState<string | null>(null)
  const [searchResultsProjectId, setSearchResultsProjectId] = useState<string | null>(null)
  const projectIdRef = useRef(projectId)
  const documentsRequestRef = useRef(0)
  const searchRequestRef = useRef(0)
  const importRequestRef = useRef(0)
  const importStatusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  projectIdRef.current = projectId

  const loadDocuments = useCallback(async (targetProjectId: string) => {
    const requestId = ++documentsRequestRef.current
    const docs = await window.electronAPI.knowledge.listDocuments(targetProjectId)
    if (requestId !== documentsRequestRef.current || projectIdRef.current !== targetProjectId) return
    setDocuments(docs)
  }, [setDocuments])

  useEffect(() => {
    documentsRequestRef.current += 1
    searchRequestRef.current += 1
    importRequestRef.current += 1
    if (importStatusTimerRef.current) clearTimeout(importStatusTimerRef.current)

    setDocuments([])
    setSearchResults([])
    setSearchResultsProjectId(null)
    setSearching(false)
    setImportStatus(null)
    setImportStatusProjectId(null)

    if (projectId) {
      void loadDocuments(projectId).catch((err) => {
        if (projectIdRef.current === projectId) {
          console.error('Failed to load knowledge documents:', err)
        }
      })
    }
  }, [loadDocuments, projectId, setDocuments, setSearchResults, setSearching])

  useEffect(() => {
    const handleKnowledgeUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail
      if (!projectId || detail?.projectId !== projectId) return
      void loadDocuments(projectId).catch((err) => {
        if (projectIdRef.current === projectId) {
          console.error('Failed to refresh knowledge documents:', err)
        }
      })
    }

    window.addEventListener('noval:knowledge-updated', handleKnowledgeUpdated)
    return () => window.removeEventListener('noval:knowledge-updated', handleKnowledgeUpdated)
  }, [loadDocuments, projectId])

  const handleImport = async () => {
    if (!projectId) return
    const targetProjectId = projectId
    const importRequestId = ++importRequestRef.current
    const files = await window.electronAPI.file.openFileDialog({
      filters: [
        { name: '文档', extensions: ['txt', 'md'] }
      ],
      properties: ['openFile', 'multiSelections']
    })
    if (
      !files ||
      files.length === 0 ||
      importRequestId !== importRequestRef.current ||
      projectIdRef.current !== targetProjectId
    ) return

    setImportStatus(`准备导入 ${files.length} 个文件...`)
    setImportStatusProjectId(targetProjectId)
    let successCount = 0
    let failCount = 0

    for (const filePath of files) {
      if (importRequestId !== importRequestRef.current || projectIdRef.current !== targetProjectId) return
      const fileName = filePath.split(/[/\\]/).pop()
      setImportStatus(`导入中 (${successCount + failCount + 1}/${files.length}): ${fileName}`)
      try {
        const doc = await window.electronAPI.knowledge.importDocument(filePath, targetProjectId)
        if (importRequestId !== importRequestRef.current || projectIdRef.current !== targetProjectId) return
        addDocument(doc)
        successCount++
      } catch (err) {
        console.error(`导入失败: ${fileName}`, err)
        failCount++
      }
    }

    if (importRequestId !== importRequestRef.current || projectIdRef.current !== targetProjectId) return
    setImportStatus(`导入完成: 成功 ${successCount} 个${failCount > 0 ? `, 失败 ${failCount} 个` : ''}`)
    if (importStatusTimerRef.current) clearTimeout(importStatusTimerRef.current)
    importStatusTimerRef.current = setTimeout(() => {
      if (importRequestId === importRequestRef.current && projectIdRef.current === targetProjectId) {
        setImportStatus(null)
        setImportStatusProjectId(null)
      }
    }, 3000)
  }

  const handleSearch = async () => {
    if (!searchQuery.trim() || !projectId) return
    const targetProjectId = projectId
    const query = searchQuery.trim()
    const requestId = ++searchRequestRef.current
    setSearching(true)
    try {
      const results = await window.electronAPI.knowledge.search(query, targetProjectId)
      if (requestId !== searchRequestRef.current || projectIdRef.current !== targetProjectId) return
      setSearchResults(results)
      setSearchResultsProjectId(targetProjectId)
    } catch (err) {
      if (requestId === searchRequestRef.current && projectIdRef.current === targetProjectId) {
        console.error('Knowledge search failed:', err)
      }
    } finally {
      if (requestId === searchRequestRef.current && projectIdRef.current === targetProjectId) {
        setSearching(false)
      }
    }
  }

  const handleDelete = async (doc: KnowledgeDoc) => {
    const targetProjectId = projectId
    if (!targetProjectId || doc.project_id !== targetProjectId || projectIdRef.current !== targetProjectId) return
    await window.electronAPI.knowledge.deleteDocument(doc.id)
    if (projectIdRef.current === targetProjectId) {
      removeDocument(doc.id)
    }
  }

  useEffect(() => () => {
    projectIdRef.current = null
    documentsRequestRef.current += 1
    searchRequestRef.current += 1
    importRequestRef.current += 1
    if (importStatusTimerRef.current) clearTimeout(importStatusTimerRef.current)
  }, [])

  const visibleDocuments = documents.filter(doc => doc.project_id === projectId)
  const visibleSearchResults = searchResultsProjectId === projectId ? searchResults : []

  return (
    <div className="knowledge-panel">
      <div className="panel-header">
        <h3>知识库</h3>
        <button onClick={handleImport} disabled={!projectId} title="导入文档">+</button>
      </div>

      {importStatus && importStatusProjectId === projectId && <div className="import-status">{importStatus}</div>}

      <div className="knowledge-search">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="搜索知识库..."
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
        />
        <button onClick={handleSearch} disabled={!projectId || isSearching || !searchQuery.trim()}>
          {isSearching ? '...' : '搜索'}
        </button>
      </div>

      {visibleSearchResults.length > 0 && (
        <div className="search-results">
          <h4>搜索结果 ({visibleSearchResults.length})</h4>
          {visibleSearchResults.map((r, i) => (
            <div key={i} className="search-result-item">
              <div className="result-header">
                <span className="result-filename">{r.filename}</span>
                <span className="result-score">{Math.round(r.score * 100)}%</span>
              </div>
              <p className="result-snippet">{r.content.slice(0, 300)}...</p>
            </div>
          ))}
        </div>
      )}

      <div className="knowledge-docs">
        <h4>已导入文档 ({visibleDocuments.length})</h4>
        {visibleDocuments.map(doc => (
          <div key={doc.id} className="knowledge-doc-item">
            <div className="doc-info">
              <span className="doc-name">{doc.filename}</span>
              <span className="doc-type">{doc.file_type}</span>
            </div>
            <div className="doc-meta">
              {doc.char_count} 字符 · {doc.chunk_count} 块
            </div>
            <button
              onClick={() => void handleDelete(doc)}
              className="doc-delete"
            >
              删除
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
