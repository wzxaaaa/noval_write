import { getDb } from '../connection'

export class SettingsRepo {
  get(key: string): string | undefined {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value
  }

  getJson<T = unknown>(key: string): T | undefined {
    const value = this.get(key)
    if (value !== undefined) {
      try {
        return JSON.parse(value) as T
      } catch {
        return undefined
      }
    }
    return undefined
  }

  set(key: string, value: string | object): void {
    const val = typeof value === 'string' ? value : JSON.stringify(value)
    getDb().prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(key, val)
  }

  delete(key: string): void {
    getDb().prepare('DELETE FROM settings WHERE key = ?').run(key)
  }

  getAll(): Record<string, string> {
    const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
    const result: Record<string, string> = {}
    for (const row of rows) {
      result[row.key] = row.value
    }
    return result
  }
}

export const settingsRepo = new SettingsRepo()
