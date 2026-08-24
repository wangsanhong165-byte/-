import assert from 'node:assert/strict'
import test from 'node:test'

import { formatServiceDetail, getServiceHealthRows } from './developer-health.ts'

test('developer health prefers the active runtime engine and model', () => {
  const rows = getServiceHealthRows({
    providers: [{
      name: 'llm',
      status: 'ready',
      adapter: 'OpenAILLMProvider',
      engine: 'opencode',
      model: 'mimo-v2.5-free',
    }],
  }, [{ name: 'llm', status: 'ready', provider: 'DeepSeek' }])

  assert.equal(formatServiceDetail(rows[0]), 'OpenCode · mimo-v2.5-free')
})

test('developer health keeps the adapter fallback when runtime metadata is absent', () => {
  const rows = getServiceHealthRows({
    providers: [{ name: 'llm', status: 'ready', adapter: 'OpenAILLMProvider' }],
  }, [])

  assert.equal(formatServiceDetail(rows[0]), 'OpenAILLMProvider')
})
