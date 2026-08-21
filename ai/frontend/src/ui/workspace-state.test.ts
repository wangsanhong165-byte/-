import assert from 'node:assert/strict'
import test from 'node:test'
import './character-catalog.test.ts'

import {
  clampDrawerWidth,
  createInitialDrawerState,
  MAX_DRAWER_WIDTH,
  MIN_DRAWER_WIDTH,
  reduceDrawerState,
  type DrawerState,
} from './workspace-state.ts'
import {
  isStageSubtitleVisible,
  stageSubtitleAutoHideDelay,
  toStageSubtitle,
} from './stage-subtitle.ts'
import { resolveHistoryCommand } from '../conversation/history-command.ts'
import { observeElementResize } from '../character/observe-resize.ts'
import {
  buildPromptConfigPayload,
  describePromptMessage,
  promptSourceEditorSeed,
  promptSourcePreview,
  promptConfigsEqual,
  promptMessageStats,
  summarizePromptContent,
} from './prompt-view.ts'

test('navigation selects content without closing the drawer', () => {
  const initial: DrawerState = { section: 'history', expanded: true, width: 380 }

  assert.deepEqual(reduceDrawerState(initial, { type: 'select', section: 'history' }), {
    section: 'history',
    expanded: true,
    width: 380,
  })
  assert.deepEqual(reduceDrawerState(initial, { type: 'select', section: 'settings' }), {
    section: 'settings',
    expanded: true,
    width: 380,
  })
})

test('prompt is a valid drawer section', () => {
  assert.deepEqual(createInitialDrawerState('prompt', MIN_DRAWER_WIDTH), {
    section: 'prompt',
    expanded: true,
    width: MIN_DRAWER_WIDTH,
  })
})

test('character library is a valid drawer section', () => {
  assert.deepEqual(createInitialDrawerState('characters', MIN_DRAWER_WIDTH), {
    section: 'characters', expanded: true, width: MIN_DRAWER_WIDTH,
  })
})

test('drawer expansion changes only through the dedicated toggle action', () => {
  const initial: DrawerState = { section: 'history', expanded: true, width: 380 }

  assert.deepEqual(reduceDrawerState(initial, { type: 'toggle' }), {
    section: 'history',
    expanded: false,
    width: 380,
  })
  assert.deepEqual(
    reduceDrawerState({ ...initial, expanded: false }, { type: 'select', section: 'memory' }),
    { section: 'memory', expanded: true, width: 380 },
  )
})

test('drawer width stays inside the supported stage-safe range', () => {
  assert.equal(clampDrawerWidth(240), MIN_DRAWER_WIDTH)
  assert.equal(clampDrawerWidth(420), 420)
  assert.equal(clampDrawerWidth(700), MAX_DRAWER_WIDTH)
})

test('invalid persisted drawer preferences fall back to safe defaults', () => {
  assert.deepEqual(createInitialDrawerState('unknown', 900), {
    section: 'history',
    expanded: true,
    width: MAX_DRAWER_WIDTH,
  })
})

test('persisted closed drawer restores as closed', () => {
  assert.deepEqual(createInitialDrawerState('closed', MIN_DRAWER_WIDTH), {
    section: 'history',
    expanded: false,
    width: MIN_DRAWER_WIDTH,
  })
})

test('stage subtitle remains visible for 4.5 seconds after the last update', () => {
  assert.equal(isStageSubtitleVisible(10_000, 14_499), true)
  assert.equal(isStageSubtitleVisible(10_000, 14_500), false)
})

test('stage subtitle shows the complete reply at once', () => {
  assert.equal(
    toStageSubtitle('第一句已经说完。现在显示整段回复。'),
    '第一句已经说完。现在显示整段回复。',
  )
})

test('stage subtitle does not auto-hide while speech is playing', () => {
  assert.equal(stageSubtitleAutoHideDelay(true), null)
  assert.equal(stageSubtitleAutoHideDelay(false), 4500)
})

test('history loading only completes after a matching command response', () => {
  assert.deepEqual(resolveHistoryCommand('load_history', {
    history_uid: 'hist_1',
    messages: [{ role: 'assistant', content: '你好' }],
  }), {
    activeUid: 'hist_1',
    clearMessages: false,
    messages: [{ role: 'assistant', content: '你好' }],
    refreshHistories: false,
  })

  assert.deepEqual(resolveHistoryCommand('create_history', {
    history_uid: 'hist_2',
  }), {
    activeUid: 'hist_2',
    clearMessages: true,
    messages: null,
    refreshHistories: true,
  })
})

test('element resize observer reports layout changes and disconnects on cleanup', () => {
  let observed: object | null = null
  let disconnected = false
  let resized = 0
  class FakeResizeObserver {
    private readonly callback: () => void
    constructor(callback: () => void) {
      this.callback = callback
    }
    observe(element: object) {
      observed = element
      this.callback()
    }
    disconnect() {
      disconnected = true
    }
  }
  const element = {}
  const cleanup = observeElementResize(
    element,
    () => { resized += 1 },
    FakeResizeObserver,
  )

  assert.equal(observed, element)
  assert.equal(resized, 1)
  cleanup()
  assert.equal(disconnected, true)
})

test('prompt messages receive semantic labels instead of repeated system labels', () => {
  assert.deepEqual(
    describePromptMessage({ role: 'system', content: 'LANGUAGE LOCK: Reply in English.' }),
    {
      kind: 'language',
      title: '语言规则',
      badge: '规则',
      summary: 'Reply in English.',
      defaultOpen: false,
    },
  )
  assert.equal(
    describePromptMessage({ role: 'system', content: 'Additional project instructions for this character: Keep it short.' }).title,
    '自定义提示词',
  )
  assert.equal(
    describePromptMessage({ role: 'system', content: 'Compiled memory context: remembered fact' }).title,
    '记忆摘要',
  )
  assert.equal(
    describePromptMessage({ role: 'system', content: '[Output Instructions]\nReturn valid JSON.' }).title,
    '输出协议',
  )
  assert.equal(describePromptMessage({ role: 'system', content: 'You are Monika.' }).title, '角色设定')
  assert.equal(describePromptMessage({ role: 'user', content: 'Hello' }).defaultOpen, true)
  assert.equal(
    describePromptMessage({ role: 'system', source_id: 'language', content: '完全替换后的文本' }).title,
    '语言规则',
  )
  assert.equal(
    describePromptMessage({ role: 'user', source_id: 'user_history', content: 'Earlier question' }).title,
    '历史输入',
  )
})

test('prompt summaries collapse whitespace and truncate long content', () => {
  assert.equal(summarizePromptContent('Compiled memory context:\n  first\n\nsecond'), 'first second')
  assert.equal(summarizePromptContent('123456789', 6), '12345…')
})

test('prompt stats separate system context from user turns', () => {
  assert.deepEqual(promptMessageStats([
    { role: 'system' },
    { role: 'system' },
    { role: 'user' },
    { role: 'assistant' },
  ]), { context: 2, user: 1, other: 1 })
})

test('static prompt replacement starts from the current default without a request snapshot', () => {
  const source = {
    id: 'language',
    title: 'Language',
    description: '',
    dynamic: false,
    editable: true,
    mode: 'default' as const,
    content: '',
    default_content: 'LANGUAGE LOCK: Reply in English.',
    last_content: '',
  }

  assert.equal(promptSourceEditorSeed(source), source.default_content)
  assert.deepEqual(promptSourcePreview(source), {
    label: '当前默认原文',
    content: source.default_content,
  })
})

test('prompt config payload is explicit about character and source policy', () => {
  const draft = {
    character_id: 'other',
    addition: '角色附加内容',
    sources: [{
      id: 'persona',
      title: '角色设定',
      description: '',
      dynamic: false,
      editable: true,
      mode: 'replace' as const,
      content: '替换后的角色设定',
      last_content: '旧角色设定',
    }],
  }

  assert.deepEqual(buildPromptConfigPayload(draft), {
    character_id: 'other',
    addition: '角色附加内容',
    sources: {
      persona: { mode: 'replace', content: '替换后的角色设定' },
    },
  })
  assert.equal(promptConfigsEqual(draft, { ...draft }), true)
  assert.equal(promptConfigsEqual(draft, { ...draft, addition: '已修改' }), false)
})
