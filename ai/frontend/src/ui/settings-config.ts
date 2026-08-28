export type LlmProviderKind = 'openai' | 'opencode'

export interface LlmProvider {
  id: string
  name: string
  kind: LlmProviderKind
  base_url: string
  model: string
  api_key: string
  temperature: number | null
  reasoning_effort: string | null
  timeout: number | null
  max_tokens: number | null
}

export interface LlmProvidersResponse {
  active: string
  providers: LlmProvider[]
}

export const LLM_PROVIDER_KIND_OPTIONS: ReadonlyArray<{
  value: LlmProviderKind
  label: string
}> = [
  { value: 'openai', label: 'OpenAI 兼容' },
  { value: 'opencode', label: 'OpenCode' },
]

export function emptyLlmProvider(id: string): LlmProvider {
  return {
    id,
    name: '新供应商',
    kind: 'openai',
    base_url: '',
    model: '',
    api_key: '',
    temperature: null,
    reasoning_effort: null,
    timeout: null,
    max_tokens: null,
  }
}

export function nextLlmProviderId(existingIds: string[]): string {
  let i = 1
  while (existingIds.includes(`provider-${i}`)) i += 1
  return `provider-${i}`
}

export type VoiceSectionId = 'asr' | 'tts' | 'gsvi'

export const VOICE_SECTION_OPTIONS: ReadonlyArray<{
  value: VoiceSectionId
  label: string
  description: string
}> = [
  { value: 'asr', label: 'ASR', description: '语音识别' },
  { value: 'tts', label: 'TTS', description: '语音合成' },
  { value: 'gsvi', label: 'GSVI', description: 'GPT-SoVITS 服务' },
]

export function getVoiceKeys(section: VoiceSectionId): readonly string[] {
  switch (section) {
    case 'asr':
      return ['ASR_ENGINE', 'ASR_BASE_URL', 'ASR_API_KEY']
    case 'tts':
      return ['TTS_ENGINE', 'TTS_BASE_URL', 'TTS_API_KEY']
    case 'gsvi':
      return ['GSVI_URL', 'GSVI_TEXT_LANG', 'GSVI_PROMPT_LANG', 'GSVI_SPEED', 'GSVI_TIMEOUT']
  }
}