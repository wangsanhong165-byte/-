import { useEffect, useRef, useState } from 'react'

import { eventBus } from '../core/event-bus'
import { DrawerPanel } from './DrawerPanel'

type RequestCommand = (action: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

type MemoryItem = {
  ref: string
  summary: string
  category: string
  pinned: boolean
  formedAt: string
  updatedAt: string
  lastUsedAt: string
  formationReason?: string
  status?: 'active' | 'stale' | 'expired'
  observedAt?: string
  expiresAt?: string
}

type MemoryView = {
  selectedCategory: string
  categories: Array<{ id: string; label: string }>
  items: MemoryItem[]
}

const EMPTY_MEMORY: MemoryView = { selectedCategory: 'all', categories: [], items: [] }

type CharacterSelfView = {
  currentState: string
  recentFocus: string[]
  persistentGoals: string[]
  recentChanges: string[]
  lastInteraction?: string
  lastInteractionAt?: number
  interactionCount?: number
  relationshipSummary?: string
}

type VoiceStatusView = {
  microphone: { label: string; status: string }
  voice: { label: string; status: string; name?: string }
  outputDevice: { label: string }
  interruptible: boolean
}

type CapabilityItem = {
  name: string
  description?: string
  status: string
  permission: string
  allowedProactively: boolean
  recentlyUsedAt?: string
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="empty-copy user-view-empty">{children}</p>
}

function formatDate(value: string | number): string {
  try {
    const date = typeof value === 'number' ? new Date(value * 1000) : new Date(value)
    return date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  } catch { return value ? String(value) : '—' }
}

function categoryLabel(category: string): string {
  return ({ about_you: '关于你', shared: '共同经历', self: '角色自身', preferences: '偏好习惯', goals: '持续目标', pinned: '已置顶' })[category] || category
}

/** Split the assembled memory.md into sections by `## heading` lines. */
function parseCompiledMemory(md: string): Array<{ title: string; body: string }> {
  const sections: Array<{ title: string; body: string[] }> = []
  let current: { title: string; body: string[] } | null = null
  for (const line of md.split('\n')) {
    const match = line.match(/^##\s+(.*)$/)
    if (match) {
      if (current) sections.push(current)
      current = { title: match[1].trim(), body: [] }
    } else if (current) {
      current.body.push(line)
    }
  }
  if (current) sections.push(current)
  return sections
    .map(section => ({ title: section.title, body: section.body.join('\n').trim() }))
    .filter(section => section.body)
}

// ── Character Self Panel ─────────────────────────────────────────

export function CharacterSelfPanel({ requestCommand }: { requestCommand: RequestCommand }) {
  const [view, setView] = useState<CharacterSelfView | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const refresh = () => {
    setRefreshing(true)
    return requestCommand('get_character_self_view', {})
      .then(data => setView((data as any).view ?? null))
      .catch(() => {})
      .finally(() => setRefreshing(false))
  }

  useEffect(() => {
    const unsubTurn = eventBus.on('runtime:turn.completed', () => { void refresh() })
    void refresh()
    return () => { unsubTurn() }
  }, [])

  return (
    <DrawerPanel title="角色" action={
      <button type="button" className="drawer-text-action" disabled={refreshing} onClick={() => void refresh()}>
        {refreshing ? '更新中…' : '刷新'}
      </button>
    }>
      {!view ? <EmptyState>正在了解角色此刻的状态…</EmptyState> : (
        <div className="user-view">
          <div className="user-view-meta">
            <span>{view.lastInteractionAt ? `更新于 ${formatDate(view.lastInteractionAt)}` : '尚未记录互动'}</span>
            {!!view.interactionCount && <span>已互动 {view.interactionCount} 次</span>}
          </div>
          <ViewSection title="当前状态"><p>{view.currentState}</p></ViewSection>
          <TextList title="最近关注" items={view.recentFocus} />
          <TextList title="持续目标" items={view.persistentGoals} />
          <TextList title="最近变化" items={view.recentChanges} />
          {view.relationshipSummary && (
            <ViewSection title="与你的关系"><p>{view.relationshipSummary}</p></ViewSection>
          )}
        </div>
      )}
    </DrawerPanel>
  )
}

// ── Memory Panel ────────────────────────────────────────────────────

export function MemoryPanel({ requestCommand }: { requestCommand: RequestCommand }) {
  const [view, setView] = useState<MemoryView>(EMPTY_MEMORY)
  const [section, setSection] = useState<'library' | 'compiled'>('library')
  const [compiled, setCompiled] = useState<{ characterId: string; characterName: string; memoryMd: string; compiledAt?: number } | null>(null)
  const [compiledFailed, setCompiledFailed] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<MemoryItem | null>(null)
  const [draft, setDraft] = useState('')
  const [confirmForget, setConfirmForget] = useState(false)

  const refresh = (category = view.selectedCategory || 'all', search = query) => {
    setSelected(null)
    return requestCommand('get_memory_view', { category, query: search })
      .then(data => setView((data as any).view ?? EMPTY_MEMORY))
      .catch(() => {})
  }

  const loadCompiled = () => {
    setCompiledFailed(false)
    return requestCommand('get_compiled_memory_view', {})
      .then(data => setCompiled((data as any).view ?? null))
      .catch(() => { setCompiled(null); setCompiledFailed(true) })
  }

  const switchSection = (next: 'library' | 'compiled') => {
    setSection(next)
    if (next === 'compiled') void loadCompiled()
  }

  const regenerate = () => {
    setRegenerating(true)
    return requestCommand('regenerate_compiled_memory', {})
      .then(() => new Promise(resolve => setTimeout(resolve, 1200)))
      .then(() => loadCompiled())
      .catch(() => {})
      .finally(() => setRegenerating(false))
  }

  useEffect(() => {
    void refresh('all', '')
    const unsub = eventBus.on('connection:change', ({ connected }) => {
      if (connected) {
        void refresh(view.selectedCategory || 'all', query)
        if (section === 'compiled') void loadCompiled()
      }
    })
    return () => unsub()
  }, [])

  const choose = (item: MemoryItem) => {
    if (selected?.ref === item.ref) { setSelected(null); return }
    setSelected(item)
    setDraft(item.summary)
    setConfirmForget(false)
  }

  const closeEditor = () => setSelected(null)

  return (
    <DrawerPanel title="记忆">
      <div className="memory-view">
        <div className="memory-view-toggle" aria-label="记忆视图">
          <button type="button" className={section === 'library' ? 'is-active' : ''} onClick={() => switchSection('library')}>记忆库</button>
          <button type="button" className={section === 'compiled' ? 'is-active' : ''} onClick={() => switchSection('compiled')}>编译记忆</button>
        </div>
        {section === 'library' && (
        <>
        <form onSubmit={event => { event.preventDefault(); refresh(view.selectedCategory, query) }}>
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索记忆…" />
          <button type="submit">搜索</button>
        </form>
        <div className="memory-categories" aria-label="记忆分类">
          {view.categories.map(item => (
            <button
              type="button"
              key={item.id}
              className={view.selectedCategory === item.id ? 'is-active' : ''}
              onClick={() => refresh(item.id)}
            >{item.label}</button>
          ))}
        </div>
        <div className="memory-view-list">
          {view.items.length === 0 && <EmptyState>这个分类里暂时没有记忆。</EmptyState>}
          {view.items.map(item => (
            <div key={item.ref}>
              <button type="button" onClick={() => choose(item)}>
                <span>
                  {item.pinned ? '置顶 · ' : ''}
                  {item.status === 'expired' ? '已过期 · ' : ''}
                  {item.status === 'stale' ? '久未提及 · ' : ''}
                  {categoryLabel(item.category)}
                </span>
                <strong>{item.summary}</strong>
                <small>{formatDate(item.observedAt || item.updatedAt)}</small>
              </button>
              {selected?.ref === item.ref && (
                <section className="memory-editor">
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span className="eyebrow">记忆详情</span>
                    <button type="button" onClick={closeEditor}
                      style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: 0 }}>&times;</button>
                  </div>
                  <textarea value={draft} onChange={event => setDraft(event.target.value)} />
                  <dl className="memory-context">
                    <div><dt>观察到</dt><dd>{formatDate(selected.observedAt || selected.formedAt)}</dd></div>
                    <div><dt>形成于</dt><dd>{formatDate(selected.formedAt)}</dd></div>
                    <div><dt>最近使用</dt><dd>{formatDate(selected.lastUsedAt)}</dd></div>
                    <div><dt>形成原因</dt><dd>{selected.formationReason || '从相关对话中形成'}</dd></div>
                  </dl>
                  <div className="memory-editor-actions">
                    <button type="button" onClick={async () => {
                      await requestCommand('update_memory_view', { ref: selected.ref, content: draft })
                      setSelected(null); void refresh()
                    }}>保存修改</button>
                    <button type="button" onClick={async () => {
                      await requestCommand('update_memory_view', { ref: selected.ref, pinned: !selected.pinned })
                      setSelected(null); void refresh()
                    }}>{selected.pinned ? '取消置顶' : '置顶'}</button>
                    {!confirmForget ? (
                      <button type="button" onClick={() => setConfirmForget(true)}>遗忘…</button>
                    ) : (
                      <button type="button" className="danger" onClick={async () => {
                        await requestCommand('forget_memory_view', { ref: selected.ref })
                        setSelected(null); setConfirmForget(false); void refresh()
                      }}>确认遗忘</button>
                    )}
                  </div>
                </section>
              )}
            </div>
          ))}
        </div>
        </>
        )}
        {section === 'compiled' && (
          <div className="memory-compiled">
            {compiled ? (
              <>
                <div className="memory-compiled-meta">
                  <strong>{compiled.characterName}</strong>
                  <span className="muted">（{compiled.characterId}）· 进 LLM 提示词的编译记忆 · 只读</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', margin: '4px 0 8px' }}>
                  <span className="muted">
                    {compiled.compiledAt ? `编译于 ${formatDate(compiled.compiledAt)}` : ''}
                  </span>
                  <button
                    type="button"
                    className="drawer-text-action"
                    disabled={regenerating}
                    onClick={() => void regenerate()}
                  >{regenerating ? '重编译中…' : '重新编译'}</button>
                </div>
                {compiled.memoryMd ? (
                  <div className="memory-compiled-sections">
                    {parseCompiledMemory(compiled.memoryMd).map(({ title, body }) => (
                      <section key={title} className="memory-compiled-section">
                        <h4>{title}</h4>
                        <div className="memory-compiled-body">{body}</div>
                      </section>
                    ))}
                  </div>
                ) : (
                  <EmptyState>该角色暂无编译记忆，先对话生成。</EmptyState>
                )}
              </>
            ) : compiledFailed ? (
              <EmptyState>读取编译记忆失败，请稍后重试。</EmptyState>
            ) : (
              <EmptyState>正在读取编译记忆…</EmptyState>
            )}
          </div>
        )}
      </div>
    </DrawerPanel>
  )
}

// ── Voice Panel ──────────────────────────────────────────────────

export function VoicePanel({ requestCommand }: { requestCommand: RequestCommand }) {
  const [view, setView] = useState<VoiceStatusView | null>(null)
  useEffect(() => {
    void requestCommand('get_voice_status_view', {}).then(data => setView((data as any).view))
  }, [])
  return (
    <DrawerPanel title="语音">
      {!view ? <EmptyState>正在检查语音服务…</EmptyState> : (
        <div className="user-view status-view">
          <StatusLine label={view.microphone.label} value={statusLabel(view.microphone.status)} />
          <StatusLine label={view.voice.label} value={view.voice.name || statusLabel(view.voice.status)} />
          <StatusLine label="输出设备" value={view.outputDevice.label} />
          <StatusLine label="允许语音打断" value={view.interruptible ? '开启' : '关闭'} />
          <p className="view-note">音量和主动语音选项继续在设置中管理。</p>
        </div>
      )}
    </DrawerPanel>
  )
}

// ── Capability Panel ─────────────────────────────────────────────

export function CapabilityPanel({ requestCommand }: { requestCommand: RequestCommand }) {
  const [items, setItems] = useState<CapabilityItem[]>([])
  const [toggling, setToggling] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const refreshInFlight = useRef(false)

  const refresh = async () => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    try {
      const data = await requestCommand('get_capability_view', {})
      setItems((data as any).view?.items ?? [])
      setError('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      refreshInFlight.current = false
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 5000)
    return () => window.clearInterval(timer)
  }, [])

  const toggleCapability = async (item: CapabilityItem) => {
    setToggling(item.name)
    setItems(prev => prev.map(i =>
      i.name === item.name ? { ...i, status: i.status === 'available' ? 'disabled' : 'available' } : i
    ))
    await requestCommand('set_tool_enabled', { name: item.name, enabled: item.status !== 'available' })
    await refresh()
    setToggling(null)
  }

  return (
    <DrawerPanel title="能力">
      <div className="capability-view">
        <div className="capability-intro">
          <div>
            <span className="capability-kicker">CAPABILITIES</span>
            <p>角色可以调用的工具</p>
          </div>
          {items.length > 0 && (
            <span className="capability-count">
              {items.filter(item => item.status === 'available').length}/{items.length} 可用
            </span>
          )}
        </div>
        {items.length === 0 && (
          <EmptyState>
            {loading
              ? '正在加载外部能力…'
              : error
                ? '能力连接暂时中断，正在重试…'
                : '当前没有可用的外部能力。'}
          </EmptyState>
        )}
        {items.length > 0 && error && (
          <p className="view-note">部分能力暂时不可用，正在重试…</p>
        )}
        {items.map(item => {
          const isAvailable = item.status === 'available'
          const presentation = capabilityPresentation(item)
          return (
            <article key={item.name} className={`capability-card ${isAvailable ? 'is-available' : 'is-disabled'}`}>
              <div className="capability-card-main">
                <div className="capability-card-heading">
                  <span className="capability-mark" aria-hidden="true" />
                  <strong>{presentation.title}</strong>
                </div>
                <p>{presentation.description}</p>
                <div className="capability-meta">
                  <span>{item.permission === 'ask' ? '使用前询问' : '自动使用'}</span>
                  <span>{item.allowedProactively ? '可主动调用' : '按需调用'}</span>
                  {item.recentlyUsedAt && <span>最近使用 {formatDate(item.recentlyUsedAt)}</span>}
                </div>
              </div>
              <button
                type="button"
                className={isAvailable ? 'is-active' : ''}
                disabled={toggling === item.name}
                onClick={() => void toggleCapability(item)}
                aria-label={`${item.name}${isAvailable ? '已开启' : '已关闭'}`}
              >{isAvailable ? '已开启' : '已关闭'}</button>
            </article>
          )
        })}
      </div>
    </DrawerPanel>
  )
}

// ── Shared helpers ────────────────────────────────────────────────

function ViewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section><h3>{title}</h3>{children}</section>
}

function TextList({ title, items }: { title: string; items: string[] }) {
  return (
    <ViewSection title={title}>
      {items.length ? <ul>{items.map(item => <li key={item}>{item}</li>)}</ul> : <p>暂时没有新的内容。</p>}
    </ViewSection>
  )
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return <div className="status-line"><span>{label}</span><strong>{value}</strong></div>
}

function statusLabel(status: string) {
  return status === 'ready' ? '正常' : status === 'unavailable' ? '不可用' : status
}

function capabilityPresentation(item: CapabilityItem): { title: string; description: string } {
  const known: Record<string, { title: string; description: string }> = {
    screen_capture: { title: '屏幕截图', description: '需要时查看当前屏幕内容。' },
    get_current_time: { title: '当前时间', description: '获取现在的日期和时间。' },
    convert_time: { title: '时区转换', description: '在不同地区的时间之间进行换算。' },
    search: { title: '网页搜索', description: '搜索公开网页，找到相关资料和答案。' },
    fetch_content: { title: '阅读网页', description: '提取网页正文，方便继续阅读和整理。' },
  }
  return known[item.name] ?? {
    title: item.name,
    description: item.description || '由角色在需要时使用。',
  }
}
