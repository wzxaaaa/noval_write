import { getDb } from '../connection'
import { randomUUID } from 'crypto'

export interface ProviderConfigRow {
  id: string
  name: string
  provider: 'anthropic' | 'openai' | 'openai-compat'
  api_key: string
  base_url: string | null
  model: string
  parameters: string
  is_default: number
  created_at: string
}

export interface ProviderConfigCreate {
  name: string
  provider: 'anthropic' | 'openai' | 'openai-compat'
  api_key: string
  base_url?: string
  model: string
  parameters?: Record<string, unknown>
  is_default?: boolean
}

export class ProviderConfigRepo {
  create(params: ProviderConfigCreate): ProviderConfigRow {
    const db = getDb()
    const id = randomUUID()
    if (params.is_default) {
      db.prepare('UPDATE provider_configs SET is_default = 0').run()
    }
    const stmt = db.prepare(
      'INSERT INTO provider_configs (id, name, provider, api_key, base_url, model, parameters, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    stmt.run(
      id,
      params.name,
      params.provider,
      params.api_key,
      params.base_url ?? null,
      params.model,
      JSON.stringify(params.parameters ?? {}),
      params.is_default ? 1 : 0
    )
    return this.getById(id)!
  }

  getById(id: string): ProviderConfigRow | undefined {
    return getDb().prepare('SELECT * FROM provider_configs WHERE id = ?').get(id) as ProviderConfigRow | undefined
  }

  getDefault(): ProviderConfigRow | undefined {
    return getDb()
      .prepare('SELECT * FROM provider_configs WHERE is_default = 1 LIMIT 1')
      .get() as ProviderConfigRow | undefined
  }

  list(): ProviderConfigRow[] {
    return getDb().prepare('SELECT * FROM provider_configs ORDER BY created_at DESC').all() as ProviderConfigRow[]
  }

  update(id: string, updates: Partial<Omit<ProviderConfigCreate, 'id'>>): void {
    const db = getDb()
    const fields: string[] = []
    const values: unknown[] = []

    if (updates.name !== undefined) { fields.push('name = ?'); values.push(updates.name) }
    if (updates.provider !== undefined) { fields.push('provider = ?'); values.push(updates.provider) }
    if (updates.api_key !== undefined) { fields.push('api_key = ?'); values.push(updates.api_key) }
    if (updates.base_url !== undefined) { fields.push('base_url = ?'); values.push(updates.base_url) }
    if (updates.model !== undefined) { fields.push('model = ?'); values.push(updates.model) }
    if (updates.parameters !== undefined) { fields.push('parameters = ?'); values.push(JSON.stringify(updates.parameters)) }
    if (updates.is_default !== undefined) {
      if (updates.is_default) {
        db.prepare('UPDATE provider_configs SET is_default = 0').run()
      }
      fields.push('is_default = ?'); values.push(updates.is_default ? 1 : 0)
    }
    fields.push("updated_at = datetime('now')")
    values.push(id)

    db.prepare(`UPDATE provider_configs SET ${fields.join(', ')} WHERE id = ?`).run(...values)
  }

  delete(id: string): void {
    getDb().prepare('DELETE FROM provider_configs WHERE id = ?').run(id)
  }
}

export const providerConfigRepo = new ProviderConfigRepo()
