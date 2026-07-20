import { knowledgeDocRepo, type KnowledgeDocRow } from '../../db/repositories/knowledge-doc.repo'
import { chunkText, parseDocument, type TextChunk } from './document-parser'
import { tokenizeSearchText } from '../../../shared/searchTerms'

export interface SearchResult {
  docId: string
  filename: string
  fileType: string
  chunkIndex: number
  chapterLabel: string
  content: string
  score: number
}

export interface SearchOptions {
  limit?: number
  threshold?: number
}

const STOP_WORDS = new Set([
  '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
  '自己', '这', '他', '她', '它', '们', '那', '什么', '这个', '那个', '可以',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'must', 'shall', 'can', 'need', 'dare', 'ought', 'used',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into',
  'through', 'during', 'before', 'after', 'above', 'below', 'between', 'out',
  'off', 'over', 'under', 'again', 'further', 'then', 'once', 'here', 'there',
  'when', 'where', 'why', 'how', 'all', 'each', 'few', 'more', 'most', 'other',
  'some', 'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than',
  'too', 'very', 'just', 'because', 'but', 'and', 'or', 'if'
])

function tokenize(text: string): string[] {
  return tokenizeSearchText(text)
    .filter(w => w.length >= 2 && !STOP_WORDS.has(w))
}

function extractQueryTerms(query: string): { tokens: string[]; rawTerms: string[] } {
  const rawTerms = tokenizeSearchText(query).filter(w => w.length >= 1)
  const tokens = rawTerms.filter(w => w.length >= 2 && !STOP_WORDS.has(w))
  return { tokens, rawTerms }
}

class RetrieverService {
  private chunkCache: Map<string, TextChunk[]> = new Map()
  private idfCache: Map<string, Map<string, number>> = new Map()

  async indexDocument(filePath: string, projectId: string): Promise<KnowledgeDocRow> {
    const parsed = parseDocument(filePath)
    const filename = filePath.split(/[/\\]/).pop() || filePath
    const fileType = filePath.split('.').pop() || 'txt'

    const doc = knowledgeDocRepo.create(
      projectId,
      filename,
      filePath,
      fileType,
      parsed.charCount,
      parsed.metadata
    )

    const chunks = chunkText(parsed.text)
    this.chunkCache.set(doc.id, chunks)
    const plainChunks = chunks.map(c => c.content)
    knowledgeDocRepo.replaceChunks(doc.id, plainChunks)
    knowledgeDocRepo.updateChunkCount(doc.id, plainChunks.length)

    this.invalidateIdf(projectId)

    return doc
  }

  private invalidateIdf(projectId: string): void {
    this.idfCache.delete(projectId)
  }

  private computeIdf(projectId: string): Map<string, number> {
    if (this.idfCache.has(projectId)) return this.idfCache.get(projectId)!

    const docs = knowledgeDocRepo.listByProject(projectId)
    const totalChunks = docs.reduce((sum, d) => sum + Math.max(d.chunk_count, 1), 0)

    if (totalChunks === 0) return new Map()

    const df: Map<string, number> = new Map()
    for (const doc of docs) {
      const chunks = this.getDocChunks(doc)
      for (const chunk of chunks) {
        const seenTerms = new Set(tokenize(chunk.content))
        for (const term of seenTerms) {
          df.set(term, (df.get(term) || 0) + 1)
        }
      }
    }

    const idf = new Map<string, number>()
    for (const [term, docFreq] of df) {
      idf.set(term, Math.log((totalChunks + 1) / (docFreq + 0.5)) + 1)
    }

    this.idfCache.set(projectId, idf)
    return idf
  }

  private getDocChunks(doc: KnowledgeDocRow): TextChunk[] {
    let cached = this.chunkCache.get(doc.id)
    if (!cached) {
      const rawChunks = knowledgeDocRepo.getChunks(doc.id)
      if (rawChunks.length === 0) {
        try {
          const parsed = parseDocument(doc.source_path)
          const textChunks = chunkText(parsed.text)
          this.chunkCache.set(doc.id, textChunks)
          knowledgeDocRepo.replaceChunks(doc.id, textChunks.map(c => c.content))
          knowledgeDocRepo.updateChunkCount(doc.id, textChunks.length)
          cached = textChunks
        } catch {
          cached = []
        }
      } else {
        cached = rawChunks.map((c, i) => ({
          content: c,
          chapterLabel: '',
          chunkIndex: i
        }))
        this.chunkCache.set(doc.id, cached)
      }
    }
    return cached
  }

  private bm25Score(
    queryTokens: string[],
    chunkContent: string,
    idf: Map<string, number>
  ): number {
    const chunkLen = Math.max(chunkContent.length, 1)
    const avgDl = 500
    const k1 = 1.5
    const b = 0.75

    let score = 0
    let matchedTerms = 0

    const tfMap = new Map<string, number>()
    for (const term of tokenize(chunkContent)) {
      tfMap.set(term, (tfMap.get(term) || 0) + 1)
    }

    for (const term of queryTokens) {
      const freq = tfMap.get(term) || 0
      if (freq > 0) {
        const idfVal = idf.get(term) || 1
        const tfNorm = (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (chunkLen / avgDl)))
        score += idfVal * tfNorm
        matchedTerms++
      }
    }

    if (matchedTerms > 0 && queryTokens.length > 0) {
      const coverageRatio = matchedTerms / queryTokens.length
      score *= (0.6 + coverageRatio * 0.4)
    }

    return score
  }

  private substringFallback(
    rawQueryTerms: string[],
    doc: KnowledgeDocRow,
    docChunks: TextChunk[],
    existingResults: Set<string>,
    limit: number
  ): SearchResult[] {
    const results: SearchResult[] = []

    for (let i = 0; i < docChunks.length && results.length < limit; i++) {
      const chunk = docChunks[i]
      const content = chunk.content

      let hitCount = 0
      for (const term of rawQueryTerms) {
        if (term.length >= 1 && content.includes(term)) {
          hitCount++
        }
      }

      if (hitCount > 0 && !existingResults.has(`${doc.id}:${i}`)) {
        const baseScore = hitCount / rawQueryTerms.length
        results.push({
          docId: doc.id,
          filename: doc.filename,
          fileType: doc.file_type,
          chunkIndex: i,
          chapterLabel: chunk.chapterLabel || `第${i + 1}块`,
          content,
          score: Math.round(baseScore * 100) / 100
        })
      }
    }

    return results
  }

  async search(query: string, projectId: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const { limit = 3, threshold = 0.05 } = options
    const docs = knowledgeDocRepo.listByProject(projectId)
    if (docs.length === 0) return []

    const { tokens: queryTokens, rawTerms: rawQueryTerms } = extractQueryTerms(query)

    if (rawQueryTerms.length === 0) return []

    const idf = this.computeIdf(projectId)
    const results: SearchResult[] = []

    if (queryTokens.length > 0) {
      for (const doc of docs) {
        const docChunks = this.getDocChunks(doc)

        for (let i = 0; i < docChunks.length; i++) {
          const chunk = docChunks[i]
          const score = this.bm25Score(queryTokens, chunk.content, idf)

          if (score >= threshold) {
            results.push({
              docId: doc.id,
              filename: doc.filename,
              fileType: doc.file_type,
              chunkIndex: i,
              chapterLabel: chunk.chapterLabel || `第${i + 1}块`,
              content: chunk.content,
              score: Math.round(score * 100) / 100
            })
          }
        }
      }
    }

    results.sort((a, b) => b.score - a.score)

    if (results.length < limit && rawQueryTerms.length > 0) {
      const existingKeys = new Set(results.map(r => `${r.docId}:${r.chunkIndex}`))
      for (const doc of docs) {
        const docChunks = this.getDocChunks(doc)
        const fallbackResults = this.substringFallback(
          rawQueryTerms, doc, docChunks, existingKeys, limit - results.length
        )
        for (const fr of fallbackResults) {
          fr.score = Math.min(fr.score, 0.9)
          results.push(fr)
          existingKeys.add(`${fr.docId}:${fr.chunkIndex}`)
        }
        if (results.length >= limit) break
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  async searchContext(query: string, projectId: string, options?: SearchOptions): Promise<string> {
    const results = await this.search(query, projectId, options)
    if (results.length === 0) return ''

    return results
      .map(r =>
        `[来源: ${r.filename} | ${r.chapterLabel} | 相关度: ${Math.round(r.score * 100)}%]\n${r.content.slice(0, 800)}`
      )
      .join('\n\n---\n\n')
  }

  async removeDocument(docId: string): Promise<void> {
    this.chunkCache.delete(docId)
    knowledgeDocRepo.deleteChunks(docId)
  }

  isInitialized(): boolean {
    return false
  }
}

export const retrieverService = new RetrieverService()
