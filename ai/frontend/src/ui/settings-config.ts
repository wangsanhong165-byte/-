export type LlmEngine = 'deepseek' | 'openai' | 'opencode' | 'local'

export const LLM_ENGINE_OPTIONS: ReadonlyArray<{
  value: LlmEngine
  label: string
  description: string
}> = [
  { value: 'deepseek', label: 'DeepSeek', description: 'DeepSeek API 或兼容接口' },
  { value: 'openai', label: 'OpenAI', description: 'OpenAI 或兼容接口' },
  { value: 'opencode', label: 'OpenCode · Ox Alpha', description: 'OpenCode 免费视觉模型服务' },
  { value: 'local', label: 'Local', description: '本地或自定义兼容接口' },
]

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

export function normalizeLlmEngine(value: string): LlmEngine {
  return LLM_ENGINE_OPTIONS.some(option => option.value === value)
    ? value as LlmEngine
    : 'deepseek'
}

export function getLlmProviderKeys(engine: LlmEngine): readonly string[] {
  switch (engine) {
    case 'deepseek':
      return ['LLM_BASE_URL', 'LLM_MODEL', 'DEEPSEEK_API_KEY']
    case 'openai':
      return ['LLM_BASE_URL', 'LLM_MODEL', 'OPENAI_API_KEY']
    case 'opencode':
      return ['OPENCODE_BASE_URL', 'OPENCODE_MODEL', 'OPENCODE_API_KEY']
    case 'local':
      return ['LLM_BASE_URL', 'LLM_MODEL']
  }
}

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
