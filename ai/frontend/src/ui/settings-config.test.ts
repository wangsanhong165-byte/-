import assert from 'node:assert/strict'
import test from 'node:test'
import {
  emptyLlmProvider,
  getVoiceKeys,
  nextLlmProviderId,
} from './settings-config.ts'

test('new provider ids avoid collisions', () => {
  assert.equal(nextLlmProviderId([]), 'provider-1')
  assert.equal(nextLlmProviderId(['provider-1', 'provider-2']), 'provider-3')
  assert.equal(nextLlmProviderId(['provider-2']), 'provider-1')
})

test('an empty provider starts as an openai-compatible profile', () => {
  const p = emptyLlmProvider('provider-1')
  assert.equal(p.id, 'provider-1')
  assert.equal(p.kind, 'openai')
  assert.equal(p.base_url, '')
  assert.equal(p.model, '')
  assert.equal(p.api_key, '')
  assert.equal(p.temperature, null)
  assert.equal(p.reasoning_effort, null)
  assert.equal(p.timeout, null)
  assert.equal(p.max_tokens, null)
})

test('voice selection exposes only the selected service fields', () => {
  assert.deepEqual(getVoiceKeys('asr'), ['ASR_ENGINE', 'ASR_BASE_URL', 'ASR_API_KEY'])
  assert.deepEqual(getVoiceKeys('tts'), ['TTS_ENGINE', 'TTS_BASE_URL', 'TTS_API_KEY'])
  assert.deepEqual(getVoiceKeys('gsvi'), ['GSVI_URL', 'GSVI_TEXT_LANG', 'GSVI_PROMPT_LANG', 'GSVI_SPEED', 'GSVI_TIMEOUT'])
})