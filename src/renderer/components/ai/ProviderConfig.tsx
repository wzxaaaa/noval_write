import React, { useState, useEffect } from 'react'
import { useAIStore } from '../../stores/ai.store'
import type { ProviderConfig as ProviderConfigData } from '../../../preload/types'
import { ModalDialog } from '../common/ModalDialog'

interface ProviderConfigProps {
  onClose: () => void
}

type ProviderKind = ProviderConfigData['provider']

interface ProviderFormState {
  name: string
  provider: ProviderKind
  api_key: string
  base_url: string
  model: string
  parameters: string
  is_default: boolean
}

export function ProviderConfig({ onClose }: ProviderConfigProps) {
  return (
    <ModalDialog title="AI 提供商配置" onClose={onClose} className="provider-config-modal">
      <ProviderConfigContent />
    </ModalDialog>
  )
}

export function ProviderConfigContent() {
  const { providers, setProviders, addProvider, updateProvider } = useAIStore()
  const [editingProvider, setEditingProvider] = useState<string | null>(null)
  const [form, setForm] = useState<ProviderFormState>({
    name: '',
    provider: 'anthropic',
    api_key: '',
    base_url: '',
    model: '',
    parameters: '{}',
    is_default: false
  })
  const [testResult, setTestResult] = useState<string | null>(null)
  const [parameterCopied, setParameterCopied] = useState(false)

  useEffect(() => {
    window.electronAPI.ai.listProviders().then(setProviders)
  }, [])

  const handleSave = async () => {
    if (!form.name || !form.api_key || !form.model) return

    const params = {
      name: form.name,
      provider: form.provider,
      api_key: form.api_key,
      base_url: form.base_url || undefined,
      model: form.model,
      parameters: JSON.parse(form.parameters),
      is_default: form.is_default
    }

    if (editingProvider) {
      await window.electronAPI.ai.updateProvider(editingProvider, params)
      updateProvider(editingProvider, {
        name: params.name,
        provider: params.provider,
        api_key: params.api_key,
        base_url: params.base_url ?? null,
        model: params.model,
        parameters: JSON.stringify(params.parameters),
        is_default: params.is_default ? 1 : 0
      })
    } else {
      const created = await window.electronAPI.ai.createProvider(params)
      addProvider(created)
    }

    resetForm()
  }

  const handleTest = async (configId: string) => {
    setTestResult('测试中...')
    const result = await window.electronAPI.ai.testConnection(configId)
    setTestResult(result.ok ? '连接成功' : `失败: ${result.error}`)
  }

  const resetForm = () => {
    setEditingProvider(null)
    setForm({ name: '', provider: 'anthropic', api_key: '', base_url: '', model: '', parameters: '{}', is_default: false })
    setTestResult(null)
  }

  const copyParameterExample = async () => {
    try {
      await navigator.clipboard.writeText(parameterPlaceholder)
      setParameterCopied(true)
      window.setTimeout(() => setParameterCopied(false), 1600)
    } catch {
      window.alert('复制失败，请手动选择示例内容复制。')
    }
  }

  const modelOptions: Record<string, string[]> = {
    anthropic: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
    openai: ['gpt-4o', 'gpt-4-turbo', 'gpt-4', 'gpt-3.5-turbo'],
    'openai-compat': ['local-model']
  }
  const parameterPlaceholder = form.provider === 'openai-compat'
    ? `{
  "temperature": 0.82,
  "top_p": 0.92,
  "maxTokens": 8192,
  "frequency_penalty": 0.15,
  "presence_penalty": 0.25
}`
    : `{
  "temperature": 0.75,
  "top_p": 0.9,
  "maxTokens": 8192
}`

  return (
    <div className="modal-body settings-tab-body">
          <div className="provider-list">
            {providers.map(p => (
              <div key={p.id} className={`provider-card ${editingProvider === p.id ? 'editing' : ''}`}>
                <div className="provider-info">
                  <span className="provider-name">{p.name}</span>
                  <span className="provider-badge">{p.provider}</span>
                  <span className="provider-model">{p.model}</span>
                  {p.is_default === 1 && <span className="provider-default">默认</span>}
                </div>
                <div className="provider-actions">
                  <button onClick={() => {
                    setEditingProvider(p.id)
                    setForm({
                      name: p.name,
                      provider: p.provider,
                      api_key: p.api_key,
                      base_url: p.base_url || '',
                      model: p.model,
                      parameters: p.parameters,
                      is_default: p.is_default === 1
                    })
                  }}>编辑</button>
                  <button onClick={() => handleTest(p.id)}>测试</button>
                  <button onClick={async () => {
                    await window.electronAPI.ai.deleteProvider(p.id)
                    setProviders(await window.electronAPI.ai.listProviders())
                  }}>删除</button>
                </div>
              </div>
            ))}
          </div>

          <div className="provider-form">
            <h3>{editingProvider ? '编辑配置' : '新建配置'}</h3>

            <label>
              名称
              <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="我的 Claude" />
            </label>

            <label>
              提供商
              <select value={form.provider} onChange={e => setForm({ ...form, provider: e.target.value as ProviderKind, model: '' })}>
                <option value="anthropic">Anthropic (Claude)</option>
                <option value="openai">OpenAI</option>
                <option value="openai-compat">OpenAI 兼容 (Ollama/vLLM/DeepSeek)</option>
              </select>
            </label>

            <label>
              API Key
              <input type="password" value={form.api_key} onChange={e => setForm({ ...form, api_key: e.target.value })} placeholder="sk-..." />
            </label>

            {form.provider === 'openai-compat' && (
              <label>
                Base URL
                <input value={form.base_url} onChange={e => setForm({ ...form, base_url: e.target.value })} placeholder="http://localhost:11434/v1" />
              </label>
            )}

            <label>
              模型
              <select value={form.model} onChange={e => setForm({ ...form, model: e.target.value })}>
                <option value="">选择模型...</option>
                {modelOptions[form.provider].map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <input value={form.model} onChange={e => setForm({ ...form, model: e.target.value })} placeholder="或输入自定义模型名" />
            </label>

            <div className="form-field parameter-field">
              <div className="field-label-row">
                <label className="field-label-text" htmlFor="provider-parameters">参数 (JSON)</label>
                <span className="json-helper">
                  <button type="button" className="json-helper-trigger" aria-label="查看参数 JSON 示例">
                    {'{}'}
                  </button>
                  <div className="json-helper-popover" role="tooltip">
                    <span className="json-helper-title">参数示例</span>
                    <span className="json-helper-copy-note">可直接复制到下方输入框后按需调整。</span>
                    <pre>{parameterPlaceholder}</pre>
                    <button type="button" onClick={() => void copyParameterExample()}>
                      {parameterCopied ? '已复制' : '复制示例'}
                    </button>
                  </div>
                </span>
              </div>
              <textarea
                id="provider-parameters"
                value={form.parameters}
                onChange={e => setForm({ ...form, parameters: e.target.value })}
                placeholder={parameterPlaceholder}
                rows={form.provider === 'openai-compat' ? 7 : 5}
              />
            </div>

            <label className="checkbox-label">
              <input type="checkbox" checked={form.is_default} onChange={e => setForm({ ...form, is_default: e.target.checked })} />
              设为默认
            </label>

            <div className="form-actions">
              <button onClick={handleSave}>{editingProvider ? '更新' : '保存'}</button>
              {editingProvider && <button onClick={resetForm}>取消</button>}
            </div>

            {testResult && <div className="test-result">{testResult}</div>}
          </div>
    </div>
  )
}
