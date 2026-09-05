export type PromptMessageLike = {
  role: string
  content?: unknown
  source_id?: string
}

export type PromptSectionKind =
  | 'language'
  | 'persona'
  | 'override'
  | 'memory'
  | 'state'
  | 'protocol'
  | 'user'
  | 'assistant'
  | 'tool'
  | 'system'

export type PromptMessageDescriptor = {
  kind: PromptSectionKind
  title: string
  badge: string
  summary: string
  defaultOpen: boolean
}

export type PromptSourceMode = 'default' | 'replace' | 'disabled'

export type PromptSourceView = {
  id: string
  title: string
  description: string
  dynamic: boolean
  editable: boolean
  mode: PromptSourceMode
  content: string
  default_content?: string
  last_content: string
}

export type PromptSourcePreview = {
  label: string
  content: string
}

export function promptSourceEditorSeed(source: PromptSourceView): string {
  return source.content || source.default_content || source.last_content
}

export function promptSourcePreview(source: PromptSourceView): PromptSourcePreview | null {
  if (source.mode === 'replace' && source.default_content) {
    return { label: '替换前的默认原文', content: source.default_content }
  }
  if (source.default_content) {
    return { label: '当前默认原文', content: source.default_content }
  }
  if (source.last_content) {
    return {
      label: source.dynamic ? '上一轮动态内容' : '上一轮实际内容',
      content: source.last_content,
    }
  }
  return null
}

export type PromptConfigView = {
  character_id: string
  sources: PromptSourceView[]
  addition: string
}

const PREFIXES_TO_HIDE = [
  'LANGUAGE LOCK:',
  'Additional project instructions for this character:',
  '[固定记忆]',
  'Compiled memory context:',
  'Relevant past context:',
  'Current emotion:',
  '[Dynamic character state]',
  '[Output Instructions]',
]

export function formatPromptContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (content === undefined || content === null) return ''
  try {
    return JSON.stringify(content, null, 2)
  } catch {
    return String(content)
  }
}

export function summarizePromptContent(content: unknown, maxLength = 92): string {
  let summary = formatPromptContent(content).trim()
  for (const prefix of PREFIXES_TO_HIDE) {
    if (summary.startsWith(prefix)) {
      summary = summary.slice(prefix.length).trim()
      break
    }
  }
  summary = summary.replace(/\s+/g, ' ')
  if (!summary) return '无文本内容'
  if (summary.length <= maxLength) return summary
  return `${summary.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`
}

export function describePromptMessage(message: PromptMessageLike): PromptMessageDescriptor {
  const content = formatPromptContent(message.content).trim()

  const sourceDescriptors: Record<string, Omit<PromptMessageDescriptor, 'summary'>> = {
    language: { kind: 'language', title: '语言规则', badge: '规则', defaultOpen: false },
    persona: { kind: 'persona', title: '角色设定', badge: '角色', defaultOpen: false },
    addition: { kind: 'override', title: '附加提示词', badge: '自定义', defaultOpen: false },
    pinned: { kind: 'memory', title: '固定记忆', badge: '记忆', defaultOpen: false },
    memory_summary: { kind: 'memory', title: '记忆摘要', badge: '记忆', defaultOpen: false },
    relevant_memory: { kind: 'memory', title: '相关记忆', badge: '记忆', defaultOpen: false },
    temporal: { kind: 'state', title: '时间感知', badge: '时间', defaultOpen: false },
    emotion: { kind: 'state', title: '当前情绪', badge: '状态', defaultOpen: false },
    character_state: { kind: 'state', title: '角色状态', badge: '状态', defaultOpen: false },
    output_protocol: { kind: 'protocol', title: '输出协议', badge: '协议', defaultOpen: false },
    user_input: { kind: 'user', title: '本轮输入', badge: '输入', defaultOpen: true },
    user_history: { kind: 'user', title: '历史输入', badge: '历史', defaultOpen: false },
    assistant_history: { kind: 'assistant', title: '历史回复', badge: '回复', defaultOpen: false },
    assistant_tool_call: { kind: 'assistant', title: '工具调用请求', badge: '工具', defaultOpen: false },
    tool_result: { kind: 'tool', title: '工具结果', badge: '工具', defaultOpen: false },
    tool_budget_instruction: { kind: 'protocol', title: '工具轮次限制', badge: '协议', defaultOpen: false },
    repair_instruction: { kind: 'protocol', title: '格式修复指令', badge: '协议', defaultOpen: false },
  }
  const sourceDescriptor = message.source_id ? sourceDescriptors[message.source_id] : undefined
  if (sourceDescriptor) {
    return { ...sourceDescriptor, summary: summarizePromptContent(content) }
  }

  if (message.role === 'user') {
    return { kind: 'user', title: '本轮输入', badge: '输入', summary: summarizePromptContent(content), defaultOpen: true }
  }
  if (message.role === 'assistant') {
    return { kind: 'assistant', title: '历史回复', badge: '回复', summary: summarizePromptContent(content), defaultOpen: false }
  }
  if (message.role === 'tool') {
    return { kind: 'tool', title: '工具结果', badge: '工具', summary: summarizePromptContent(content), defaultOpen: false }
  }
  if (message.role !== 'system') {
    return { kind: 'system', title: '其他消息', badge: message.role, summary: summarizePromptContent(content), defaultOpen: false }
  }

  if (content.startsWith('LANGUAGE LOCK:')) {
    return { kind: 'language', title: '语言规则', badge: '规则', summary: summarizePromptContent(content), defaultOpen: false }
  }
  if (content.startsWith('Additional project instructions for this character:')) {
    return { kind: 'override', title: '自定义提示词', badge: '自定义', summary: summarizePromptContent(content), defaultOpen: false }
  }
  if (content.startsWith('Compiled memory context:')) {
    return { kind: 'memory', title: '记忆摘要', badge: '记忆', summary: summarizePromptContent(content), defaultOpen: false }
  }
  if (content.startsWith('Relevant past context:')) {
    return { kind: 'memory', title: '相关记忆', badge: '记忆', summary: summarizePromptContent(content), defaultOpen: false }
  }
  if (content.startsWith('[当前时间]')) {
    return { kind: 'state', title: '时间感知', badge: '时间', summary: summarizePromptContent(content), defaultOpen: false }
  }
  if (content.startsWith('Current emotion:')) {
    return { kind: 'state', title: '当前情绪', badge: '状态', summary: summarizePromptContent(content), defaultOpen: false }
  }
  if (content.startsWith('[Dynamic character state]')) {
    return { kind: 'state', title: '角色状态', badge: '状态', summary: summarizePromptContent(content), defaultOpen: false }
  }
  if (content.startsWith('[Output Instructions]')) {
    return { kind: 'protocol', title: '输出协议', badge: '协议', summary: summarizePromptContent(content), defaultOpen: false }
  }

  return { kind: 'persona', title: '角色设定', badge: '角色', summary: summarizePromptContent(content), defaultOpen: false }
}

export function promptMessageStats(messages: PromptMessageLike[]) {
  return messages.reduce((stats, message) => {
    if (message.role === 'system') stats.context += 1
    else if (message.role === 'user') stats.user += 1
    else stats.other += 1
    return stats
  }, { context: 0, user: 0, other: 0 })
}

export function buildPromptConfigPayload(config: PromptConfigView) {
  return {
    character_id: config.character_id,
    addition: config.addition,
    sources: Object.fromEntries(config.sources.map(source => [
      source.id,
      { mode: source.mode, content: source.mode === 'replace' ? source.content : '' },
    ])),
  }
}

export function promptConfigsEqual(left: PromptConfigView | null, right: PromptConfigView | null): boolean {
  if (!left || !right) return left === right
  return JSON.stringify(buildPromptConfigPayload(left)) === JSON.stringify(buildPromptConfigPayload(right))
}
