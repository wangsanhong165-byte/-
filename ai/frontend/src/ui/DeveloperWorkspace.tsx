import { useEffect, useState } from 'react'

import { eventBus } from '../core/event-bus'
import { selectConnection, useSelector } from '../core/store'
import { electronWindowBridge } from '../session/electron-window-bridge'
import { DrawerPanel } from './DrawerPanel'
import {
  formatServiceDetail,
  getServiceHealthRows,
} from './developer-health'

type TurnSummary = {
  turnId: string
  createdAt: string
  phase: string
  origin: string
  summary: string
}

type TurnDetail = {
  turnId: string
  readOnly: boolean
  createdAt: string
  phase: string
  origin: string
  input: { text: string; inputMode?: string; visual?: Record<string, unknown> }
  response: { text: string; segments: Array<Record<string, string>> }
  performance: Record<string, unknown>
  memory: { retrieved: Array<Record<string, string>>; committed: Array<Record<string, string>> }
  tools: Array<Record<string, unknown>>
  prompt: { view: string; contextBudget: Record<string, unknown> }
  usage: Record<string, unknown>
  timeline: Array<{ event: string; offsetMs: number; durationMs?: number }>
  warnings: string[]
  error?: { code: string; message: string } | null
  retention: { days: number; maximumTurns: number }
  visual?: Record<string, unknown>
}

export function DeveloperWorkspace({
  requestCommand,
}: {
  requestCommand: (action: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
}) {
  const [turns, setTurns] = useState<TurnSummary[]>([])
  const [detail, setDetail] = useState<TurnDetail | null>(null)
  const [diagnostics, setDiagnostics] = useState<any>(null)
  const connected = useSelector(selectConnection) === 'connected'
  const [errors, setErrors] = useState<Array<{ code: string; message: string }>>([])
  const [services, setServices] = useState<any[]>([])
  const [phaseFilter, setPhaseFilter] = useState<'all' | 'completed' | 'failed'>('all')

  const recordRequestError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    setErrors(items => [
      { code: 'DIAGNOSTICS_REQUEST_FAILED', message },
      ...items,
    ].slice(0, 20))
  }

  const refresh = () => {
    electronWindowBridge.getStatus()
      .then((result: any) => setServices(result?.services ?? []))
      .catch(() => setServices([]))
    if (!connected) return

    void requestCommand('get_turns', { limit: 100 }).then(data => {
      const next = Array.isArray((data as any).turns) ? (data as any).turns : []
      setTurns(next)
      if (!detail && next[0]) {
        void requestCommand('get_turn_detail', { turn_id: next[0].turnId })
          .then(turnData => setDetail((turnData as any).turn ?? null))
          .catch(recordRequestError)
      }
    }).catch(recordRequestError)
    void requestCommand('get_runtime_diagnostics', {})
      .then(setDiagnostics)
      .catch(recordRequestError)
  }

  useEffect(() => {
    const unsubError = eventBus.on('runtime:error', error =>
      setErrors(items => [error, ...items].slice(0, 20))
    )
    refresh()
    return unsubError
  }, [connected])

  return (
    <DrawerPanel
      title="开发者工作台"
      action={<button type="button" className="drawer-text-action" onClick={refresh}>刷新</button>}
    >
      <div className="developer-workspace">
        <div className="developer-intro">
          <div>
            <span className="developer-kicker">RUNTIME INSPECTOR</span>
            <p>只读诊断 · 记录、时间线与服务状态</p>
          </div>
          <span className="developer-retention-badge">保留 30 天 / 500 条</span>
        </div>
        <section className="developer-overview">
          <DevMetric label="WebSocket" value={connected ? '已连接' : '未连接'} />
          <DevMetric label="Runtime" value={diagnostics?.runtime?.idle ? '空闲' : '处理中'} />
          <DevMetric
            label="Turn"
            value={diagnostics?.runtime?.activeTurn?.turnId?.slice(0, 8)
              ?? String(diagnostics?.runtime?.turnCount ?? turns.length)}
          />
          <DevMetric label="服务" value={services.length ? `${services.filter(isHealthy).length}/${services.length}` : '浏览器预览'} />
        </section>

        <VisualRoute diagnostics={diagnostics} />

        <section className="turn-browser">
          <div className="turn-list">
            <div className="developer-section-heading">
              <div><span className="developer-kicker">ACTIVITY</span><h3>CharacterTurn</h3></div>
              <small>{turns.length} 条</small>
            </div>
            <div className="turn-filters">
              {(['all', 'completed', 'failed'] as const).map(filter => (
                <button
                  key={filter}
                  type="button"
                  className={phaseFilter === filter ? 'is-active' : ''}
                  onClick={() => setPhaseFilter(filter)}
                >
                  {{ all: '全部', completed: '成功', failed: '失败' }[filter]}
                </button>
              ))}
            </div>
            {turns.length === 0 && <p className="empty-copy">完成一次对话后会生成只读记录。</p>}
            {turns
              .filter(turn => phaseFilter === 'all' || turn.phase === phaseFilter)
              .map(turn => (
              <button
                type="button"
                key={turn.turnId}
                className={detail?.turnId === turn.turnId ? 'is-active' : ''}
                onClick={() => void requestCommand('get_turn_detail', { turn_id: turn.turnId })
                  .then(data => setDetail((data as any).turn ?? null))
                  .catch(recordRequestError)}
              >
                <span>{formatPhase(turn.phase)} · {formatOrigin(turn.origin)}</span>
                <strong>{turn.summary || '语音输入'}</strong>
                <small>{new Date(turn.createdAt).toLocaleString('zh-CN')}</small>
              </button>
            ))}
          </div>
          <div className="turn-detail">
            {!detail ? <p className="empty-copy">选择一条 Turn 查看详情。</p> : (
              <>
                <DevSection title="当前回合">
                  <p>{detail.input.text || (detail.input.visual?.hasVisionInput ? `视觉输入 · ${detail.input.visual.imageCount ?? 0} 张图片` : '语音输入')} → {detail.response.text || '无文本响应'}</p>
                  <small>只读 · {detail.phase} · {detail.turnId.slice(0, 8)}</small>
                </DevSection>
                {detail.input.visual?.hasVisionInput && (
                  <DevSection title="视觉链路" collapsible>
                    <VisualFacts value={detail.visual ?? detail.input.visual} />
                  </DevSection>
                )}
                <DevSection title="状态时间线">
                  <ol className="trace-timeline">
                    {detail.timeline.map((item, index) => (
                      <li key={`${item.event}-${index}`}>
                        <span>{item.event}</span>
                        <small>{Math.round(item.offsetMs)} ms{item.durationMs != null ? ` · ${Math.round(item.durationMs)} ms` : ''}</small>
                      </li>
                    ))}
                  </ol>
                </DevSection>
                <DevSection title="PromptBundle" collapsible>
                  <p>内容已脱敏；仅显示上下文预算。</p>
                  <KeyValues value={detail.prompt.contextBudget} />
                </DevSection>
                <DevSection title="模型响应与解析" collapsible>
                  <p>{detail.response.text || '无文本响应'}</p>
                  <KeyValues value={detail.usage} />
                </DevSection>
                <DevSection title="PerformancePlan" collapsible>
                  <KeyValues value={detail.performance} />
                </DevSection>
                <DevSection title="Memory Retrieve / Commit" collapsible>
                  <p>检索 {detail.memory.retrieved.length} 条 · 提交 {detail.memory.committed.length} 条</p>
                  {[...detail.memory.retrieved, ...detail.memory.committed].map((item, index) =>
                    <small key={index}>{item.type || 'memory'} · {item.summary}</small>
                  )}
                </DevSection>
                <DevSection title="ASR / TTS" collapsible>
                  <p>{detail.timeline.some(item => item.event.includes('ASR')) ? '包含 ASR 生命周期' : '文本输入'}</p>
                  <p>{detail.timeline.some(item => item.event.includes('TTS')) ? 'TTS 已生成音频' : '本轮无 TTS 音频'}</p>
                </DevSection>
                {(detail.warnings.length > 0 || detail.error) && (
                  <DevSection title="错误与警告">
                    {detail.error && <p>{detail.error.code} · {detail.error.message}</p>}
                    {detail.warnings.map(item => <small key={item}>{item}</small>)}
                  </DevSection>
                )}
              </>
            )}
          </div>
        </section>

        <div className="developer-lower-grid">
        <ServiceHealth diagnostics={diagnostics} services={services} />
        {errors.length > 0 && (
          <DevSection title="本次连接的错误">
            {errors.map((error, index) => <small key={`${error.code}-${index}`}>{error.code} · {error.message}</small>)}
          </DevSection>
        )}
        </div>
        <p className="developer-retention">
          Turn 记录默认保留 30 天、最多 500 条；只读查询，不提供 Runtime 状态修改或逐帧参数回放。
        </p>
      </div>
    </DrawerPanel>
  )
}

function DevMetric({ label, value }: { label: string; value: string }) {
  return <div><span>{label}</span><strong>{value}</strong></div>
}

function DevSection({ title, children, collapsible = false }: { title: string; children: React.ReactNode; collapsible?: boolean }) {
  if (collapsible) {
    return <details className="dev-section dev-section-collapsible"><summary>{title}</summary><div className="dev-section-content">{children}</div></details>
  }
  return <section className="dev-section"><h3>{title}</h3>{children}</section>
}

function ServiceHealth({ diagnostics, services }: { diagnostics: any; services: any[] }) {
  const rows = getServiceHealthRows(diagnostics, services)
  const healthyCount = rows.filter(row => isHealthy(row)).length

  return (
    <section className="dev-section service-health">
      <div className="service-health-heading">
        <div>
          <span className="developer-kicker">SYSTEM STATUS</span>
          <h3>服务健康</h3>
        </div>
        <span className="service-health-summary">
          {rows.length ? `${healthyCount}/${rows.length} 正常` : '等待状态'}
        </span>
      </div>
      {rows.length ? (
        <div className="service-health-list">
          {rows.map(row => {
            const tone = getServiceStatusTone(row.status)
            return (
              <div className="service-health-row" key={row.name}>
                <div className="service-health-service">
                  <strong>{row.name}</strong>
                  <small>{formatServiceDetail(row)}</small>
                </div>
                <span className={`service-health-status is-${tone}`}>
                  <i aria-hidden="true" />
                  {getServiceStatusLabel(row.status)}
                </span>
              </div>
            )
          })}
        </div>
      ) : (
        <p className="empty-copy service-health-empty">暂时没有可用的服务状态。</p>
      )}
    </section>
  )
}

function VisualRoute({ diagnostics }: { diagnostics: any }) {
  const provider = (diagnostics?.providers ?? []).find((item: any) => item.name === 'llm')
    ?? (diagnostics?.providers ?? []).find((item: any) => item.visionEnabled != null)
  const recent = diagnostics?.visual
  if (!provider && !recent) return null
  const enabled = provider?.visionEnabled === true
  const policy = provider?.visualPolicy
  return (
    <section className="dev-section visual-route">
      <div className="service-health-heading">
        <div><span className="developer-kicker">VISION ROUTE</span><h3>视觉模型实际状态</h3></div>
        <span className={`service-health-status is-${enabled ? 'healthy' : 'pending'}`}>
          <i aria-hidden="true" />{enabled ? '视觉已启用' : '视觉已关闭'}
        </span>
      </div>
      <p>{provider ? `${provider.engine || '?'} · ${provider.model || '—'}` : '—'}</p>
      <small>{provider?.base_url || '未返回 provider 地址'}</small>
      {!enabled && <small className="visual-route-hint">总开关已关闭：图片不会发送给模型</small>}
      {policy && (
        <dl className="dev-key-values">
          <div><dt>最多图片</dt><dd>{policy.maxImages ?? '—'} 张</dd></div>
          <div><dt>单张上限</dt><dd>{formatMegabytes(Number(policy.maxImageBytes))}</dd></div>
          <div><dt>像素上限</dt><dd>{formatMegapixels(Number(policy.maxImagePixels))}</dd></div>
          <div><dt>最长边</dt><dd>{policy.maxImageEdge ?? '—'} px</dd></div>
          <div><dt>支持格式</dt><dd>{formatMimeTypes(policy.supportedMimeTypes)}</dd></div>
        </dl>
      )}
      <div className={`visual-recent${recent?.providerSuccess === false ? ' is-error' : ''}`}>
        {recent ? (
          <>
            <strong>最近视觉回合 · {recent.imageCount ?? 0} 张 · {recent.providerSuccess === false ? '失败' : '成功'}</strong>
            {recent.visualError && <small>错误码：{String(recent.visualError)}</small>}
            {recent.createdAt && <small>{new Date(recent.createdAt).toLocaleString('zh-CN')}</small>}
          </>
        ) : (
          <small>尚无视觉回合</small>
        )}
      </div>
    </section>
  )
}

function formatMegabytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—'
  const mb = bytes / (1024 * 1024)
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`
}

function formatMegapixels(pixels: number): string {
  if (!Number.isFinite(pixels) || pixels <= 0) return '—'
  const mp = pixels / 1_000_000
  return `${Number.isInteger(mp) ? mp : mp.toFixed(1)} MP`
}

function formatMimeTypes(mimeTypes: unknown): string {
  if (!Array.isArray(mimeTypes) || mimeTypes.length === 0) return '—'
  return mimeTypes.map((item: string) => String(item).replace('image/', '').toUpperCase()).join(' / ')
}

const VISUAL_FACT_LABELS: Record<string, string> = {
  hasVisionInput: '视觉输入',
  protocol: '协议',
  imageCount: '图片数',
  imageBytes: '图片大小',
  mimeTypes: '格式',
  dimensions: '尺寸',
  providerSuccess: '模型处理',
  visualError: '错误码',
  finishReason: '结束原因',
  turnId: '回合',
  createdAt: '时间',
  compression: '压缩',
}

function formatVisualValue(key: string, value: unknown): string {
  switch (key) {
    case 'hasVisionInput':
      return value ? '是' : '否'
    case 'imageCount':
      return `${Number(value) || 0} 张`
    case 'imageBytes':
      return formatMegabytes(Number(value))
    case 'mimeTypes':
      return formatMimeTypes(value)
    case 'dimensions':
      return Array.isArray(value) && value[0]
        ? `${value[0].width}×${value[0].height}`
        : '—'
    case 'providerSuccess':
      return value === false ? '失败' : '成功'
    case 'turnId':
      return String(value ?? '—').slice(0, 12)
    case 'createdAt':
      return value ? new Date(String(value)).toLocaleString('zh-CN') : '—'
    default:
      if (value == null) return '—'
      if (typeof value === 'object') return JSON.stringify(value)
      return String(value)
  }
}

function VisualFacts({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value ?? {})
  return (
    <dl className="dev-key-values">
      {entries.map(([key, item]) => (
        <div key={key}><dt>{VISUAL_FACT_LABELS[key] ?? key}</dt><dd>{formatVisualValue(key, item)}</dd></div>
      ))}
    </dl>
  )
}

function formatPhase(phase: string) {
  return { completed: '已完成', failed: '失败', running: '进行中' }[phase] ?? phase
}

function formatOrigin(origin: string) {
  return { user: '用户', initiative: '主动', voice: '语音' }[origin] ?? origin
}

function getServiceStatusTone(status: string) {
  const normalized = status.toLowerCase()
  if (isHealthy({ status })) return 'healthy'
  if (['starting', 'loading', 'busy', 'degraded', 'unknown'].includes(normalized)) return 'pending'
  return 'error'
}

function getServiceStatusLabel(status: string) {
  const normalized = status.toLowerCase()
  return {
    ready: '就绪',
    running: '运行中',
    healthy: '健康',
    ok: '正常',
    starting: '启动中',
    loading: '加载中',
    busy: '处理中',
    degraded: '降级',
    unknown: '未知',
    error: '异常',
    failed: '失败',
    offline: '离线',
  }[normalized] ?? status
}

function KeyValues({ value }: { value: Record<string, unknown> }) {
  return (
    <dl className="dev-key-values">
      {Object.entries(value ?? {}).map(([key, item]) => (
        <div key={key}><dt>{key}</dt><dd>{String(item ?? '—')}</dd></div>
      ))}
    </dl>
  )
}

function isHealthy(service: any) {
  return ['running', 'healthy', 'ok', 'ready'].includes(String(service.status).toLowerCase())
}
