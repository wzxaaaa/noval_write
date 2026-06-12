import { OpenAIAdapter } from './openai.adapter'
import type { ProviderConfigRow } from '../../db/repositories/provider-config.repo'

export class OpenAICompatAdapter extends OpenAIAdapter {
  constructor(config: ProviderConfigRow) {
    super(config, {
      provider: 'openai-compat',
      apiKey: config.api_key || 'not-needed',
      baseURL: config.base_url || 'http://localhost:11434/v1'
    })
  }
}
