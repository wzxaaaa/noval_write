import type { AIAdapter } from './types'
import type { ProviderConfigRow } from '../../db/repositories/provider-config.repo'
import { providerConfigRepo } from '../../db/repositories/provider-config.repo'
import { AnthropicAdapter } from './anthropic.adapter'
import { OpenAIAdapter } from './openai.adapter'
import { OpenAICompatAdapter } from './openai-compat.adapter'

export function createAdapter(config: ProviderConfigRow): AIAdapter {
  switch (config.provider) {
    case 'anthropic':
      return new AnthropicAdapter(config)
    case 'openai':
      return new OpenAIAdapter(config)
    case 'openai-compat':
      return new OpenAICompatAdapter(config)
    default:
      throw new Error(`Unknown provider: ${config.provider}`)
  }
}

export function createAdapterById(configId: string): AIAdapter {
  const config = providerConfigRepo.getById(configId)
  if (!config) {
    throw new Error(`Provider config not found: ${configId}`)
  }
  return createAdapter(config)
}
