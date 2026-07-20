import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnowledgeDoc, ProjectOutline, SearchResult } from '../../src/preload/types'
import { KnowledgePanel } from '../../src/renderer/components/knowledge/KnowledgePanel'
import { OutlinePanel } from '../../src/renderer/components/outline/OutlinePanel'
import { ProjectManager } from '../../src/renderer/components/project/ProjectManager'
import { useKnowledgeStore } from '../../src/renderer/stores/knowledge.store'
import { useProjectStore } from '../../src/renderer/stores/project.store'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function knowledgeDoc(id: string, projectId: string, filename: string): KnowledgeDoc {
  return {
    id,
    project_id: projectId,
    filename,
    source_path: filename,
    file_type: 'txt',
    chunk_count: 1,
    char_count: 10,
    imported_at: '2026-01-01T00:00:00.000Z',
    metadata: '{}'
  }
}

function outline(id: string, projectId: string, title: string): ProjectOutline {
  return {
    id,
    project_id: projectId,
    type: 'outline',
    title,
    content: '',
    updated_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z'
  }
}

function installElectronAPI(overrides: Record<string, unknown>) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: overrides
  })
}

describe('project-scoped panels', () => {
  beforeEach(() => {
    const store = useKnowledgeStore.getState()
    store.setDocuments([])
    store.setSearchResults([])
    store.setSearchQuery('')
    store.setSearching(false)
    useProjectStore.getState().setProjects([])
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('ignores a knowledge document response from the previously selected project', async () => {
    const projectAResponse = deferred<KnowledgeDoc[]>()
    const projectBDoc = knowledgeDoc('doc-b', 'project-b', 'project-b.txt')
    const listDocuments = vi.fn((projectId: string) => (
      projectId === 'project-a' ? projectAResponse.promise : Promise.resolve([projectBDoc])
    ))

    installElectronAPI({
      file: { openFileDialog: vi.fn() },
      knowledge: {
        listDocuments,
        search: vi.fn(),
        importDocument: vi.fn(),
        deleteDocument: vi.fn()
      }
    })

    const view = render(<KnowledgePanel projectId="project-a" />)
    view.rerender(<KnowledgePanel projectId="project-b" />)

    await waitFor(() => {
      expect(useKnowledgeStore.getState().documents).toEqual([projectBDoc])
    })

    await act(async () => {
      projectAResponse.resolve([knowledgeDoc('doc-a', 'project-a', 'project-a.txt')])
      await Promise.resolve()
    })

    expect(useKnowledgeStore.getState().documents).toEqual([projectBDoc])
    expect(view.queryByText('project-a.txt')).toBeNull()
    expect(view.getByText('project-b.txt')).toBeTruthy()

    const callsBeforeStaleEvent = listDocuments.mock.calls.length
    act(() => {
      window.dispatchEvent(new CustomEvent('noval:knowledge-updated', {
        detail: { projectId: 'project-a' }
      }))
    })
    expect(listDocuments).toHaveBeenCalledTimes(callsBeforeStaleEvent)
  })

  it('does not apply search results after the project changes', async () => {
    const searchResponse = deferred<SearchResult[]>()
    const search = vi.fn(() => searchResponse.promise)

    installElectronAPI({
      file: { openFileDialog: vi.fn() },
      knowledge: {
        listDocuments: vi.fn(async () => []),
        search,
        importDocument: vi.fn(),
        deleteDocument: vi.fn()
      }
    })

    const view = render(<KnowledgePanel projectId="project-a" />)
    act(() => useKnowledgeStore.getState().setSearchQuery('needle'))
    fireEvent.click(view.container.querySelector('.knowledge-search button')!)
    expect(search).toHaveBeenCalledWith('needle', 'project-a')

    view.rerender(<KnowledgePanel projectId="project-b" />)
    await act(async () => {
      searchResponse.resolve([{
        docId: 'doc-a',
        filename: 'project-a.txt',
        fileType: 'txt',
        chunkIndex: 0,
        content: 'stale result',
        score: 1
      }])
      await Promise.resolve()
    })

    expect(useKnowledgeStore.getState().searchResults).toEqual([])
    expect(useKnowledgeStore.getState().isSearching).toBe(false)
    expect(view.queryByText('project-a.txt')).toBeNull()
  })

  it('ignores an outline response and refresh event from the previous project', async () => {
    const projectAResponse = deferred<ProjectOutline[]>()
    const projectBOutline = outline('outline-b', 'project-b', 'Project B outline')
    const list = vi.fn((projectId: string) => (
      projectId === 'project-a' ? projectAResponse.promise : Promise.resolve([projectBOutline])
    ))

    installElectronAPI({
      outline: {
        list,
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn()
      }
    })

    const view = render(<OutlinePanel projectId="project-a" />)
    view.rerender(<OutlinePanel projectId="project-b" />)

    await waitFor(() => expect(view.getByText('Project B outline')).toBeTruthy())

    await act(async () => {
      projectAResponse.resolve([outline('outline-a', 'project-a', 'Project A outline')])
      await Promise.resolve()
    })

    expect(view.queryByText('Project A outline')).toBeNull()
    expect(view.getByText('Project B outline')).toBeTruthy()

    const callsBeforeStaleEvent = list.mock.calls.length
    act(() => {
      window.dispatchEvent(new CustomEvent('noval:outline-updated', {
        detail: { projectId: 'project-a', types: ['outline'] }
      }))
    })
    expect(list).toHaveBeenCalledTimes(callsBeforeStaleEvent)
  })

  it('only accepts a picker-authorized project directory and surfaces creation errors', async () => {
    const listProjects = vi.fn(async () => [])
    const openFileDialog = vi.fn(async () => ['D:\\Authorized\\Novel'])
    const createProject = vi.fn(async () => {
      throw new Error('directory authorization expired')
    })

    installElectronAPI({
      file: {
        listProjects,
        openFileDialog,
        createProject,
        createChapter: vi.fn()
      }
    })

    const view = render(
      <ProjectManager onSelectProject={vi.fn()} onClose={vi.fn()} />
    )
    await waitFor(() => expect(listProjects).toHaveBeenCalled())

    const pathInput = view.getByLabelText('存储路径') as HTMLInputElement
    expect(pathInput.readOnly).toBe(true)
    fireEvent.change(pathInput, { target: { value: 'D:\\Unapproved' } })
    expect(pathInput.value).toBe('')

    fireEvent.click(view.getByRole('button', { name: '选择' }))
    await waitFor(() => expect(pathInput.value).toBe('D:\\Authorized\\Novel'))

    fireEvent.change(view.getByLabelText('项目名称'), { target: { value: '安全项目' } })
    fireEvent.click(view.getByRole('button', { name: '创建项目' }))

    await waitFor(() => {
      expect(createProject).toHaveBeenCalledWith('安全项目', 'D:\\Authorized\\Novel')
      expect(view.getByText('创建项目失败：directory authorization expired')).toBeTruthy()
    })
  })
})
