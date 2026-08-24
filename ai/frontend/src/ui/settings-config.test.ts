import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getLlmProviderKeys,
  getVoiceKeys,
  normalizeLlmEngine,
} from './settings-config.ts'

test('engine selection exposes only the selected provider fields', () => {
  assert.deepEqual(getLlmProviderKeys('deepseek'), ['LLM_BASE_URL', 'LLM_MODEL', 'DEEPSEEK_API_KEY'])
  assert.deepEqual(getLlmProviderKeys('openai'), ['LLM_BASE_URL', 'LLM_MODEL', 'OPENAI_API_KEY'])
  assert.deepEqual(getLlmProviderKeys('opencode'), ['OPENCODE_BASE_URL', 'OPENCODE_MODEL', 'OPENCODE_API_KEY'])
  assert.deepEqual(getLlmProviderKeys('local'), ['LLM_BASE_URL', 'LLM_MODEL'])
})

test('unknown persisted engine values fall back to the supported default', () => {
  assert.equal(normalizeLlmEngine('unknown'), 'deepseek')
  assert.equal(normalizeLlmEngine('opencode'), 'opencode')
})

test('voice selection exposes only the selected service fields', () => {
  assert.deepEqual(getVoiceKeys('asr'), ['ASR_ENGINE', 'ASR_BASE_URL', 'ASR_API_KEY'])
  assert.deepEqual(getVoiceKeys('tts'), ['TTS_ENGINE', 'TTS_BASE_URL', 'TTS_API_KEY'])
  assert.deepEqual(getVoiceKeys('gsvi'), ['GSVI_URL', 'GSVI_TEXT_LANG', 'GSVI_PROMPT_LANG', 'GSVI_SPEED', 'GSVI_TIMEOUT'])
})
