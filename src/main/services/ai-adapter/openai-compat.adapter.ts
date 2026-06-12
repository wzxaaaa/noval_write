import { OpenAIAdapter } from './openai.adapter'
import type { ProviderConfigRow } from '../../db/repositories/provider-config.repo'
import type { AIParams } from './types'

export class OpenAICompatAdapter extends OpenAIAdapter {
  constructor(config: ProviderConfigRow) {
    super(config, {
      provider: 'openai-compat',
      apiKey: config.api_key || 'not-needed',
      baseURL: config.base_url || 'http://localhost:11434/v1'
    })
  }

  protected normalizeCompletionParams(params: AIParams): AIParams {
    if (!isKimiCompatibleConfig(this.config.base_url, this.model)) {
      return params
    }

    return normalizeKimiCompletionParams(params, this.model)
  }
}

export function normalizeKimiCompletionParams(params: AIParams, model: string): AIParams {
  const normalized: AIParams = { ...params }

  if (isKimiFixedTemperatureModel(model)) {
    deleteFixedKimiSamplingParams(normalized)
    return normalized
  }

  const temperature = normalized.temperature
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
    delete normalized.temperature
    return normalized
  }

  normalized.temperature = Math.min(1, Math.max(0, temperature))
  return normalized
}

export function isKimiCompatibleConfig(baseUrl: string | null | undefined, model: string): boolean {
  return isKimiBaseUrl(baseUrl) || isKimiModel(model)
}

function isKimiBaseUrl(baseUrl: string | null | undefined): boolean {
  if (!baseUrl) return false
  return /(moonshot|kimi)/i.test(baseUrl)
}

function isKimiModel(model: string): boolean {
  return /(^|[-_])kimi($|[-_])|moonshot/i.test(model)
}

function isKimiFixedTemperatureModel(model: string): boolean {
  return /kimi-k2\.(5|6)/i.test(model)
}

function deleteFixedKimiSamplingParams(params: AIParams): void {
  delete params.temperature
  delete params.topP
  delete params.top_p
  delete params.frequencyPenalty
  delete params.frequency_penalty
  delete params.presencePenalty
  delete params.presence_penalty
}
