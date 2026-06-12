import React, { useState, useEffect } from 'react'
import { useKnowledgeStore } from '../../stores/knowledge.store'

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

  useEffect(() => {
    if (projectId) {
      window.electronAPI.knowledge.listDocuments(projectId).then(setDocuments)
    }
  }, [projectId])

  useEffect(() => {
    const handleKnowledgeUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail
      if (!projectId || (detail?.projectId && detail.projectId !== projectId)) return
      window.electronAPI.knowledge.listDocuments(projectId).then(setDocuments)
    }

    window.addEventListener('noval:knowledge-updated', handleKnowledgeUpdated)
    return () => window.removeEventListener('noval:knowledge-updated', handleKnowledgeUpdated)
  }, [projectId, setDocuments])

  const handleImport = async () => {
    const files = await window.electronAPI.file.openFileDialog({
      filters: [
        { name: '文档', extensions: ['txt', 'md'] }
      ],
      properties: ['openFile', 'multiSelections']
    })
    if (!files || files.length === 0) return

    setImportStatus(`准备导入 ${files.length} 个文件...`)
    let successCount = 0
    let failCount = 0

    for (const filePath of files) {
      const fileName = filePath.split(/[/\\]/).pop()
      setImportStatus(`导入中 (${successCount + failCount + 1}/${files.length}): ${fileName}`)
      try {
        const doc = await window.electronAPI.knowledge.importDocument(filePath, projectId!)
        addDocument(doc)
        successCount++
      } catch (err) {
        console.error(`导入失败: ${fileName}`, err)
        failCount++
      }
    }

    setImportStatus(`导入完成: 成功 ${successCount} 个${failCount > 0 ? `, 失败 ${failCount} 个` : ''}`)
    setTimeout(() => setImportStatus(null), 3000)
  }

  const handleSearch = async () => {
    if (!searchQuery.trim() || !projectId) return
    setSearching(true)
    const results = await window.electronAPI.knowledge.search(searchQuery, projectId)
    setSearchResults(results)
    setSearching(false)
  }

  return (
    <div className="knowledge-panel">
      <div className="panel-header">
        <h3>知识库</h3>
        <button onClick={handleImport} disabled={!projectId} title="导入文档">+</button>
      </div>

      {importStatus && <div className="import-status">{importStatus}</div>}

      <div className="knowledge-search">
        <input
          type="text"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="搜索知识库..."
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
        />
        <button onClick={handleSearch} disabled={isSearching || !searchQuery.trim()}>
          {isSearching ? '...' : '搜索'}
        </button>
      </div>

      {searchResults.length > 0 && (
        <div className="search-results">
          <h4>搜索结果 ({searchResults.length})</h4>
          {searchResults.map((r, i) => (
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
        <h4>已导入文档 ({documents.length})</h4>
        {documents.map(doc => (
          <div key={doc.id} className="knowledge-doc-item">
            <div className="doc-info">
              <span className="doc-name">{doc.filename}</span>
              <span className="doc-type">{doc.file_type}</span>
            </div>
            <div className="doc-meta">
              {doc.char_count} 字符 · {doc.chunk_count} 块
            </div>
            <button
              onClick={async () => {
                await window.electronAPI.knowledge.deleteDocument(doc.id)
                removeDocument(doc.id)
              }}
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
