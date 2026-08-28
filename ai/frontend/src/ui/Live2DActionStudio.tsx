import { useEffect, useRef, useState } from 'react'
import { eventBus } from '../core/event-bus'
import { theme } from '../core/theme'
import {
  MOTION_PRIMITIVES,
  normalizeMotionAction,
  normalizeMotionActions,
  type Live2DActionsByModel,
  type MotionActionDefinition,
  type MotionActionStep,
  type MotionPrimitive,
} from '../character/MotionAction'

interface Live2DActionStudioProps {
  model: string
  actionsByModel: Live2DActionsByModel
  onChange: (actions: Live2DActionsByModel) => void
}

const PRIMITIVE_LABELS: Partial<Record<MotionPrimitive, string>> = {
  nod: '点头',
  tilt_left: '向左歪头',
  tilt_right: '向右歪头',
  lean_forward: '身体前倾',
  lean_back: '身体后仰',
  sway: '自然摇摆',
  look_left: '看向左侧',
  look_right: '看向右侧',
  breathe: '呼吸起伏',
  shrug: '耸肩',
}

function createAction(index = 1): MotionActionDefinition {
  return {
    version: 1,
    id: `custom_action_${index}`,
    name: `自定义动作 ${index}`,
    durationMs: 1200,
    recoveryMs: 220,
    steps: [{ atMs: 0, durationMs: 800, primitive: 'nod', intensity: 0.55 }],
  }
}

export function Live2DActionStudio({
  model,
  actionsByModel,
  onChange,
}: Live2DActionStudioProps) {
  const actions = normalizeMotionActions(actionsByModel?.[model])
  const [open, setOpen] = useState(false)
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<MotionActionDefinition>(() => createAction())
  const [message, setMessage] = useState('动作按当前模型独立保存；大模型只能调用同一套安全原语。')
  const importRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const first = actions[0]
    setSelectedId(first?.id ?? '')
    setDraft(first ?? createAction(actions.length + 1))
    setMessage('动作按当前模型独立保存；大模型只能调用同一套安全原语。')
  }, [model])

  const persist = (next: MotionActionDefinition[]) => {
    onChange({ ...actionsByModel, [model]: normalizeMotionActions(next) })
  }

  const selectAction = (id: string) => {
    const selected = actions.find(action => action.id === id)
    if (!selected) return
    setSelectedId(id)
    setDraft(selected)
    setMessage('已载入动作草稿。')
  }

  const updateStep = (index: number, patch: Partial<MotionActionStep>) => {
    setDraft(current => ({
      ...current,
      steps: current.steps.map((step, stepIndex) => (
        stepIndex === index ? { ...step, ...patch } : step
      )),
    }))
  }

  const save = () => {
    try {
      const normalized = normalizeMotionAction(draft)
      const next = actions.filter(action => action.id !== selectedId && action.id !== normalized.id)
      next.push(normalized)
      persist(next)
      setSelectedId(normalized.id)
      setDraft(normalized)
      setMessage(`已保存“${normalized.name}”。`)
    } catch (error) {
      setMessage(`无法保存：${error instanceof Error ? error.message : '动作配置无效'}`)
    }
  }

  const preview = () => {
    try {
      const normalized = normalizeMotionAction(draft)
      eventBus.emit('character:action_preview', { action: normalized })
      setMessage(`正在试演“${normalized.name}”。`)
    } catch (error) {
      setMessage(`无法试演：${error instanceof Error ? error.message : '动作配置无效'}`)
    }
  }

  const importActions = async (file?: File) => {
    if (!file) return
    try {
      const parsed = JSON.parse(await file.text()) as unknown
      const candidates = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && 'actions' in parsed
          ? (parsed as { actions: unknown }).actions
          : [parsed]
      const imported = normalizeMotionActions(candidates)
      if (!imported.length) throw new Error('文件中没有有效动作')
      const merged = new Map(actions.map(action => [action.id, action]))
      imported.forEach(action => merged.set(action.id, action))
      persist([...merged.values()])
      setSelectedId(imported[0].id)
      setDraft(imported[0])
      setMessage(`已导入 ${imported.length} 个动作；同名 ID 已安全覆盖。`)
    } catch (error) {
      setMessage(`导入失败：${error instanceof Error ? error.message : 'JSON 无效'}`)
    } finally {
      if (importRef.current) importRef.current.value = ''
    }
  }

  const exportActions = () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      model,
      actions,
    }, null, 2)
    const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${model}-live2d-actions.json`
    anchor.click()
    URL.revokeObjectURL(url)
    setMessage(`已导出 ${actions.length} 个动作。`)
  }

  return (
    <div style={studioStyles.shell}>
      <button type="button" style={studioStyles.header} onClick={() => setOpen(value => !value)}>
        <span>
          <strong style={studioStyles.title}>动作工作台</strong>
          <span style={studioStyles.summary}>{actions.length} 个模型专属动作</span>
        </span>
        <span>{open ? '收起' : '打开'}</span>
      </button>

      {open && (
        <div style={studioStyles.body}>
          <div style={studioStyles.toolbar}>
            <select
              aria-label="已保存动作"
              style={studioStyles.input}
              value={selectedId}
              onChange={event => selectAction(event.target.value)}
            >
              <option value="">新动作草稿</option>
              {actions.map(action => <option key={action.id} value={action.id}>{action.name}</option>)}
            </select>
            <button type="button" style={studioStyles.button} onClick={() => {
              setSelectedId('')
              setDraft(createAction(actions.length + 1))
              setMessage('已创建未保存的动作草稿。')
            }}>新建</button>
            <button type="button" style={studioStyles.button} onClick={exportActions}>导出</button>
            <button type="button" style={studioStyles.button} onClick={() => importRef.current?.click()}>导入</button>
            <input
              ref={importRef}
              type="file"
              accept="application/json,.json"
              hidden
              onChange={event => void importActions(event.target.files?.[0])}
            />
          </div>

          <div style={studioStyles.twoColumns}>
            <label style={studioStyles.field}>
              <span>动作 ID</span>
              <input style={studioStyles.input} value={draft.id} onChange={event => {
                setDraft(current => ({ ...current, id: event.target.value }))
              }} />
            </label>
            <label style={studioStyles.field}>
              <span>显示名称</span>
              <input style={studioStyles.input} value={draft.name} onChange={event => {
                setDraft(current => ({ ...current, name: event.target.value }))
              }} />
            </label>
            <label style={studioStyles.field}>
              <span>总时长（ms）</span>
              <input type="number" min={300} max={8000} style={studioStyles.input} value={draft.durationMs}
                onChange={event => setDraft(current => ({ ...current, durationMs: Number(event.target.value) }))} />
            </label>
            <label style={studioStyles.field}>
              <span>恢复时间（ms）</span>
              <input type="number" min={0} max={1500} style={studioStyles.input} value={draft.recoveryMs ?? 220}
                onChange={event => setDraft(current => ({ ...current, recoveryMs: Number(event.target.value) }))} />
            </label>
          </div>

          <div style={studioStyles.stepsHeader}>
            <strong>动作步骤</strong>
            <button
              type="button"
              style={studioStyles.button}
              disabled={draft.steps.length >= 16}
              onClick={() => setDraft(current => ({
                ...current,
                steps: [...current.steps, {
                  atMs: Math.min(current.durationMs - 120, current.steps.length * 300),
                  durationMs: Math.min(600, current.durationMs),
                  primitive: 'sway',
                  intensity: 0.45,
                }],
              }))}
            >
              添加步骤
            </button>
          </div>

          <div style={studioStyles.stepList}>
            {draft.steps.map((step, index) => (
              <div key={`${index}-${step.primitive}`} style={studioStyles.step}>
                <select
                  aria-label={`步骤 ${index + 1} 动作`}
                  style={studioStyles.input}
                  value={step.primitive}
                  onChange={event => updateStep(index, { primitive: event.target.value as MotionPrimitive })}
                >
                  {MOTION_PRIMITIVES.map(primitive => (
                    <option key={primitive} value={primitive}>{PRIMITIVE_LABELS[primitive] ?? primitive}</option>
                  ))}
                </select>
                <NumberField label="开始" value={step.atMs} min={0} max={8000}
                  onChange={atMs => updateStep(index, { atMs })} />
                <NumberField label="持续" value={step.durationMs} min={120} max={2500}
                  onChange={durationMs => updateStep(index, { durationMs })} />
                <NumberField label="强度" value={step.intensity} min={0} max={1} step={0.05}
                  onChange={intensity => updateStep(index, { intensity })} />
                <button type="button" style={studioStyles.removeButton} onClick={() => {
                  setDraft(current => ({
                    ...current,
                    steps: current.steps.filter((_, stepIndex) => stepIndex !== index),
                  }))
                }}>删除</button>
              </div>
            ))}
          </div>

          <div style={studioStyles.footer}>
            <span style={studioStyles.message}>{message}</span>
            <span style={studioStyles.actions}>
              {selectedId && (
                <button type="button" style={studioStyles.dangerButton} onClick={() => {
                  persist(actions.filter(action => action.id !== selectedId))
                  setSelectedId('')
                  setDraft(createAction(Math.max(1, actions.length)))
                  setMessage('动作已删除。')
                }}>删除动作</button>
              )}
              <button type="button" style={studioStyles.button} onClick={preview}>试演</button>
              <button type="button" style={studioStyles.primaryButton} onClick={save}>保存</button>
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
}) {
  return (
    <label style={studioStyles.miniField}>
      <span>{label}</span>
      <input
        aria-label={label}
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        style={studioStyles.numberInput}
        onChange={event => onChange(Number(event.target.value))}
      />
    </label>
  )
}

const studioStyles: Record<string, React.CSSProperties> = {
  shell: {
    border: `1px solid ${theme.colors.border}`,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    backgroundColor: theme.colors.bg.surface,
  },
  header: {
    width: '100%',
    border: 0,
    padding: theme.spacing.md,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: 'transparent',
    color: theme.colors.text.secondary,
    cursor: 'pointer',
  },
  title: { display: 'block', color: theme.colors.text.primary, fontSize: theme.fontSize.sm, textAlign: 'left' },
  summary: { display: 'block', color: theme.colors.text.muted, fontSize: theme.fontSize.xs, marginTop: 3 },
  body: {
    padding: theme.spacing.md,
    paddingTop: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing.md,
    borderTop: `1px solid ${theme.colors.border}`,
  },
  toolbar: { display: 'flex', gap: 6, flexWrap: 'wrap', paddingTop: theme.spacing.md },
  twoColumns: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 },
  field: { display: 'flex', flexDirection: 'column', gap: 4, color: theme.colors.text.muted, fontSize: theme.fontSize.xs },
  input: {
    minWidth: 0,
    padding: '5px 7px',
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`,
    backgroundColor: theme.colors.bg.root,
    color: theme.colors.text.primary,
    fontSize: theme.fontSize.xs,
  },
  button: {
    padding: '5px 8px',
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`,
    backgroundColor: theme.colors.bg.root,
    color: theme.colors.text.secondary,
    cursor: 'pointer',
    fontSize: theme.fontSize.xs,
  },
  primaryButton: {
    padding: '5px 10px',
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.accent}`,
    backgroundColor: theme.colors.accent,
    color: '#fff',
    cursor: 'pointer',
    fontSize: theme.fontSize.xs,
  },
  dangerButton: {
    padding: '5px 8px',
    borderRadius: theme.radius.sm,
    border: '1px solid color-mix(in srgb, var(--danger) 45%, var(--line))',
    backgroundColor: 'transparent',
    color: theme.colors.danger,
    cursor: 'pointer',
    fontSize: theme.fontSize.xs,
  },
  stepsHeader: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: theme.colors.text.primary, fontSize: theme.fontSize.xs },
  stepList: { display: 'flex', flexDirection: 'column', gap: 6 },
  step: {
    display: 'grid',
    gridTemplateColumns: 'minmax(100px, 1.4fr) repeat(3, minmax(58px, .7fr)) auto',
    alignItems: 'end',
    gap: 5,
    padding: 7,
    borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.bg.root,
  },
  miniField: { display: 'flex', flexDirection: 'column', gap: 3, color: theme.colors.text.muted, fontSize: '0.65rem' },
  numberInput: {
    width: '100%',
    minWidth: 0,
    boxSizing: 'border-box',
    padding: '5px',
    borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`,
    backgroundColor: theme.colors.bg.surface,
    color: theme.colors.text.primary,
    fontSize: theme.fontSize.xs,
  },
  removeButton: {
    padding: '5px',
    border: 0,
    background: 'transparent',
    color: theme.colors.danger,
    cursor: 'pointer',
    fontSize: theme.fontSize.xs,
  },
  footer: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  message: { flex: 1, color: theme.colors.text.muted, fontSize: theme.fontSize.xs, lineHeight: 1.4 },
  actions: { display: 'flex', gap: 6, flexShrink: 0 },
}
