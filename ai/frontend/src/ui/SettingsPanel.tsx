import { useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, ExternalLink, FileImage, FolderOpen, Info, LoaderCircle, Palette, RotateCcw, Settings2, type LucideIcon } from 'lucide-react'
import { theme } from '../core/theme'
import type { AppSettings } from '../core/store'
import { electronWindowBridge, type ElectronPerformanceDiagnostics, type WallpaperResourceResult } from '../session/electron-window-bridge'
import { eventBus, type EventMap } from '../core/event-bus'
import {
  normalizeLive2DPerformanceSettings,
  readModelPerformanceDefaults,
  type Live2DPerformanceSettings,
} from '../character/Live2DPerformanceSettings'
import { Live2DActionStudio } from './Live2DActionStudio'
import {
  getLlmProviderKeys,
  getVoiceKeys,
  LLM_ENGINE_OPTIONS,
  normalizeLlmEngine,
  VOICE_SECTION_OPTIONS,
  type LlmEngine,
  type VoiceSectionId,
} from './settings-config'

export interface SettingsPanelProps {
  open: boolean
  onClose: () => void
  embedded?: boolean
  settings: AppSettings
  onSettingChange: (key: string, value: unknown) => void
}

const LIVE2D_TOGGLES = [
  { key: 'live2dBlink' as const, label: '自动眨眼', desc: '根据模型能力自然控制双眼' },
  { key: 'live2dBreathe' as const, label: '呼吸微动', desc: '身体起伏与轻微摇摆' },
  { key: 'live2dLipSync' as const, label: '实时口型', desc: '按真实音频包络驱动开口' },
  { key: 'live2dHeadTracking' as const, label: '头部跟随', desc: '头部和视线跟随光标' },
  { key: 'live2dExpression' as const, label: '表情系统', desc: '使用模型原生表情并平滑混合' },
  { key: 'live2dIdle' as const, label: '待机动画', desc: '连续微动、呼吸与随机凝视' },
  { key: 'live2dClickFeedback' as const, label: '点击反馈', desc: '点击或拖动模型时触发互动回应' },
]

const CALIBRATION_CONTROLS = [
  { logical: 'head.x', label: '头部左右', min: -20, max: 20, step: .5 },
  { logical: 'head.y', label: '头部俯仰', min: -16, max: 16, step: .5 },
  { logical: 'head.z', label: '头部倾斜', min: -14, max: 14, step: .5 },
  { logical: 'body.x', label: '身体左右', min: -9, max: 9, step: .25 },
  { logical: 'body.y', label: '身体俯仰', min: -7, max: 7, step: .25 },
  { logical: 'eye.x', label: '视线左右', min: -1, max: 1, step: .05 },
  { logical: 'eye.y', label: '视线上下', min: -1, max: 1, step: .05 },
  { logical: 'mouth.open', label: '嘴巴张合', min: 0, max: 1, step: .05 },
  { logical: 'mouth.form', label: '嘴型变化', min: -1, max: 1, step: .05 },
] as const

type TabId = 'general' | 'appearance' | 'about'
type GeneralSectionId = 'window' | 'interaction' | 'llm' | 'voice'

interface TabDef {
  id: TabId
  label: string
  icon: LucideIcon
}

const TABS: TabDef[] = [
  { id: 'general', label: 'General', icon: Settings2 },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'about', label: 'About', icon: Info },
]

const TAB_LABELS: Record<TabId, string> = {
  general: '常规',
  appearance: '外观',
  about: '关于',
}

const GENERAL_SECTION_OPTIONS: ReadonlyArray<{
  value: GeneralSectionId
  label: string
  description: string
}> = [
  { value: 'window', label: '窗口', description: '窗口模式与置顶' },
  { value: 'interaction', label: '交互', description: '主动对话与语音输入' },
  { value: 'llm', label: '语言模型', description: '引擎、模型与密钥' },
  { value: 'voice', label: '语音服务', description: 'ASR、TTS 与 GSVI' },
]

const isElectron = electronWindowBridge.available

export function SettingsPanel({
  open,
  onClose,
  embedded = false,
  settings,
  onSettingChange,
}: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<TabId>('general')

  if (!open) return null

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose()
    }
  }

  const panel = (
      <div style={embedded ? styles.embedded : styles.modal}>
        <div style={styles.header}>
          <span style={styles.title}>设置</span>
          {!embedded && <button type="button" style={styles.closeBtn} onClick={onClose}>&times;</button>}
        </div>

        <div style={styles.body}>
          {/* Tab sidebar */}
          <div style={styles.tabBar}>
            {TABS.map((tab) => {
              const Icon = tab.icon
              return (
                <button
                  key={tab.id}
                  type="button"
                  aria-label={TAB_LABELS[tab.id]}
                  title={TAB_LABELS[tab.id]}
                  style={{
                    ...styles.tabBtn,
                    backgroundColor: activeTab === tab.id ? theme.colors.bg.surface : 'transparent',
                    borderLeft: activeTab === tab.id ? `2px solid ${theme.colors.accent}` : '2px solid transparent',
                  }}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon style={styles.tabIcon} aria-hidden="true" />
                  <span style={styles.tabLabel}>{TAB_LABELS[tab.id]}</span>
                </button>
              )
            })}
          </div>

          {/* Tab content */}
          <div style={styles.content}>
            {activeTab === 'general' && (
              <GeneralTab settings={settings} onSettingChange={onSettingChange} />
            )}
            {activeTab === 'appearance' && (
              <AppearanceTab settings={settings} onSettingChange={onSettingChange} />
            )}
            {activeTab === 'about' && <AboutTab />}
          </div>
        </div>
      </div>
  )

  if (embedded) return panel

  return (
    <div style={styles.overlay} onClick={handleOverlayClick}>
      {panel}
    </div>
  )
}

export function Live2DWorkbench({
  settings,
  onSettingChange,
  accessoryParts,
  accessoryState,
  onAccessoryToggle,
}: Pick<SettingsPanelProps, 'settings' | 'onSettingChange'> & {
  accessoryParts?: Record<string, string>
  accessoryState?: Record<string, boolean>
  onAccessoryToggle?: (label: string, enabled: boolean) => void
}) {
  return (
    <div style={{ ...styles.content, height: '100%', boxSizing: 'border-box' }}>
      <AnimationTab
        settings={settings}
        onSettingChange={onSettingChange}
        accessoryParts={accessoryParts}
        accessoryState={accessoryState}
        onAccessoryToggle={onAccessoryToggle}
      />
    </div>
  )
}

function AppearanceTab({ settings, onSettingChange }: {
  settings: AppSettings
  onSettingChange: (key: string, value: unknown) => void
}) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [mediaState, setMediaState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')

  useEffect(() => eventBus.on('background:status', ({ state, message: statusMessage }) => {
    setMediaState(state)
    if (state === 'error') setMessage(statusMessage || '背景资源加载失败，请重新选择。')
  }), [])

  const applyResult = (result: WallpaperResourceResult) => {
    if (!result.ok || !result.url || !result.type) {
      if (result.code !== 'canceled') setMessage(result.message || '无法读取这个壁纸项目。')
      return
    }
    onSettingChange('backgroundType', result.type)
    onSettingChange('backgroundUrl', result.url)
    onSettingChange('backgroundPath', result.path || '')
    onSettingChange('backgroundLabel', result.label || result.path || '')
    setMediaState('loading')
    setMessage(result.warning || (result.type === 'video' ? '已加载 Wallpaper Engine 视频壁纸。' : '已加载壁纸。'))
  }

  const selectWallpaper = async (mode: 'file' | 'directory') => {
    setBusy(true)
    try {
      applyResult(await electronWindowBridge.selectWallpaper(mode))
    } finally {
      setBusy(false)
    }
  }

  const clearWallpaper = () => {
    onSettingChange('backgroundType', 'none')
    onSettingChange('backgroundUrl', '')
    onSettingChange('backgroundPath', '')
    onSettingChange('backgroundLabel', '')
    setMediaState('idle')
    setMessage('已恢复默认背景。')
  }

  const resourceSelected = settings.backgroundType !== 'none' && Boolean(settings.backgroundUrl)
  const fitLabel = settings.backgroundFit === 'cover'
    ? '铺满裁切'
    : settings.backgroundFit === 'fill'
      ? '拉伸填充'
      : '完整显示 · 不放大'
  const statusLabel = !resourceSelected
    ? '未选择'
    : mediaState === 'loading'
      ? '加载中'
      : mediaState === 'error'
        ? '加载失败'
        : '已就绪'
  const StatusIcon = !resourceSelected
    ? FileImage
    : mediaState === 'loading'
      ? LoaderCircle
      : mediaState === 'error'
        ? AlertCircle
        : CheckCircle2

  return (
    <div style={styles.tabContent}>
      <div style={styles.backgroundCard}>
        <div style={styles.backgroundHeader}>
          <div style={styles.backgroundHeading}>
            <div style={styles.sectionLabel}>舞台背景</div>
            <div style={styles.sectionDesc}>图片和视频会保持原比例；小图不会被强制放大。</div>
          </div>
          <div style={{ ...styles.backgroundStatus, ...(mediaState === 'error' ? styles.backgroundStatusError : {}), ...(!resourceSelected ? styles.backgroundStatusIdle : {}) }}>
            <StatusIcon size={13} className={mediaState === 'loading' ? 'is-spinning' : undefined} />
            {statusLabel}
          </div>
        </div>

        <div style={styles.backgroundPreview}>
          {resourceSelected ? (
            settings.backgroundType === 'video' ? (
              <video
                src={settings.backgroundUrl}
                muted
                autoPlay
                loop
                playsInline
                preload="metadata"
                style={styles.backgroundPreviewMedia}
                onCanPlay={() => setMediaState('ready')}
                onError={() => setMediaState('error')}
              />
            ) : (
              <img
                src={settings.backgroundUrl}
                alt="背景预览"
                style={styles.backgroundPreviewMedia}
                onLoad={() => setMediaState('ready')}
                onError={() => setMediaState('error')}
              />
            )
          ) : (
            <div style={styles.backgroundEmpty}>
              <FileImage size={20} />
              <span>选择一张图片或视频作为舞台背景</span>
            </div>
          )}
        </div>

        <div style={styles.backgroundResourceRow}>
          <div style={{ minWidth: 0 }}>
            <div style={styles.cardTitle}>{settings.backgroundLabel || '未选择背景'}</div>
            <div style={styles.cardDesc}>{resourceSelected ? `${settings.backgroundType === 'video' ? '视频' : '图片'} · ${fitLabel}` : '当前使用默认舞台背景'}</div>
          </div>
          {resourceSelected && (
            <button type="button" style={styles.iconButton} onClick={clearWallpaper} title="恢复默认背景" aria-label="恢复默认背景">
              <RotateCcw size={14} />
            </button>
          )}
        </div>

        <div style={styles.backgroundActions}>
          <button type="button" style={styles.primaryButton} disabled={busy || !electronWindowBridge.available} onClick={() => void selectWallpaper('directory')}>
            <FolderOpen size={14} /> 选择 Wallpaper Engine 文件夹
          </button>
          <button type="button" style={styles.secondaryButton} disabled={busy || !electronWindowBridge.available} onClick={() => void selectWallpaper('file')}>
            <FileImage size={14} /> 选择图片 / 视频
          </button>
          <button type="button" style={styles.secondaryButton} disabled={!electronWindowBridge.available} onClick={() => void electronWindowBridge.openWallpaperWorkshop().then(result => {
            if (!result.ok) setMessage(result.message || '没有找到 Wallpaper Engine 创意工坊目录。')
          })}>
            <ExternalLink size={14} /> 打开创意工坊目录
          </button>
        </div>

        <div style={styles.backgroundSettings}>
        <SettingRow label="显示方式" desc="完整显示不放大；铺满会裁切边缘">
          <select style={styles.select} value={settings.backgroundFit} onChange={event => onSettingChange('backgroundFit', event.target.value)}>
            <option value="contain">完整显示 · 不放大</option>
            <option value="cover">铺满裁切</option>
            <option value="fill">拉伸填充</option>
          </select>
        </SettingRow>
        <RangeSetting
          label="背景透明度"
          value={settings.backgroundOpacity}
          min={0.15}
          max={1}
          step={0.05}
          onChange={value => onSettingChange('backgroundOpacity', value)}
        />
        </div>
      </div>

      {!electronWindowBridge.available && <div style={styles.backgroundHint}>请在 Electron 桌面版中选择本地 Wallpaper Engine 资源。</div>}
      {message && <div style={styles.backgroundMessage}>{message}</div>}
    </div>
  )
}

// ── Tab: General ──

function GeneralTab({ settings, onSettingChange }: {
  settings: AppSettings
  onSettingChange: (key: string, value: unknown) => void
}) {
  type EnvConfig = Record<string, Record<string, string>>
  type EnvSaveState = 'loading' | 'pending' | 'saving' | 'saved' | 'error'

  const [activeSection, setActiveSection] = useState<GeneralSectionId>('llm')
  const [voiceSection, setVoiceSection] = useState<VoiceSectionId>('asr')
  const [env, setEnv] = useState<EnvConfig>({})
  const [envSaveState, setEnvSaveState] = useState<EnvSaveState>('loading')
  const envLoadedRef = useRef(false)
  const envDirtyVersionRef = useRef(0)

  useEffect(() => {
    let disposed = false
    void fetch('/api/config/env')
      .then(r => r.ok ? r.json() : Promise.reject(new Error('env unavailable')))
      .then((body: { config?: Record<string, Record<string, string>> }) => {
        if (!body.config) throw new Error('env config missing')
        if (disposed) return
        setEnv(body.config)
        envLoadedRef.current = true
        setEnvSaveState('saved')
      })
      .catch(() => {
        if (!disposed) setEnvSaveState('error')
      })
    return () => { disposed = true }
  }, [])

  useEffect(() => {
    if (!envLoadedRef.current || envDirtyVersionRef.current === 0) return
    const timer = setTimeout(() => {
      const version = envDirtyVersionRef.current
      setEnvSaveState('saving')
      void fetch('/api/config/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: env }),
      })
        .then(r => r.ok ? r.json() : Promise.reject(new Error('save failed')))
        .then(() => {
          if (version === envDirtyVersionRef.current) setEnvSaveState('saved')
        })
        .catch(() => {
          if (version === envDirtyVersionRef.current) setEnvSaveState('error')
        })
    }, 350)
    return () => clearTimeout(timer)
  }, [env])

  const setEnvKey = (group: string, key: string, value: string) => {
    envDirtyVersionRef.current += 1
    setEnv(prev => ({ ...prev, [group]: { ...(prev[group] || {}), [key]: value } }))
    setEnvSaveState('pending')
  }

  const engine: LlmEngine = normalizeLlmEngine(env.llm?.LLM_ENGINE ?? '')
  const engineLabel = LLM_ENGINE_OPTIONS.find(option => option.value === engine)?.label ?? engine
  const llmFieldVisible = (key: string) => getLlmProviderKeys(engine).includes(key)
  const voiceFieldVisible = (key: string) => getVoiceKeys(voiceSection).includes(key)
  const envSaveLabel = envSaveState === 'loading'
    ? '读取核心配置…'
    : envSaveState === 'pending' || envSaveState === 'saving'
      ? '自动保存中…'
      : envSaveState === 'error'
        ? '自动保存失败，请再次修改'
        : '已自动保存'

  return (
    <div style={styles.tabContent}>
      <div style={styles.settingsNav} role="tablist" aria-label="常规设置分类">
        {GENERAL_SECTION_OPTIONS.map(option => (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={activeSection === option.value}
            style={{
              ...styles.settingsNavButton,
              ...(activeSection === option.value ? styles.settingsNavButtonActive : {}),
            }}
            onClick={() => setActiveSection(option.value)}
          >
            <span style={styles.settingsNavLabel}>{option.label}</span>
            <span style={styles.settingsNavDesc}>{option.description}</span>
          </button>
        ))}
      </div>

      {activeSection === 'window' && (
        <div style={styles.settingGroup}>
          <div style={styles.sectionLabel}>窗口</div>

          <SettingRow label="窗口模式" desc="桌宠模式会移除窗口边框">
            <select
              style={styles.select}
              value={settings.windowMode}
              onChange={(e) => onSettingChange('windowMode', e.target.value as 'window' | 'pet')}
            >
              <option value="window">窗口</option>
              <option value="pet">桌宠</option>
            </select>
          </SettingRow>

          <SettingRow label="窗口置顶" desc={isElectron ? '始终显示在其他窗口上方' : '仅桌面版可用'}>
            <Toggle
              checked={settings.alwaysOnTop}
              disabled={!isElectron}
              onChange={(v) => onSettingChange('alwaysOnTop', v)}
            />
          </SettingRow>
        </div>
      )}

      {activeSection === 'interaction' && (
        <div style={styles.settingGroup}>
          <div style={styles.sectionLabel}>交互</div>

          <SettingRow label="主动对话" desc="让 AI 在空闲时主动发起对话">
            <Toggle
              checked={settings.proactive}
              onChange={(v) => onSettingChange('proactive', v)}
            />
          </SettingRow>
          {settings.proactive && (
            <div style={styles.proactiveIdleRow}>
              <span style={styles.proactiveIdleLabel}>空闲时间：</span>
              <input
                type="number"
                min="10"
                max="3600"
                step="10"
                value={settings.proactiveIdleTime}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10)
                  if (!isNaN(v) && v >= 10) onSettingChange('proactiveIdleTime', v)
                }}
                style={styles.numberInput}
              />
            </div>
          )}

          <SettingRow label="语音输入" desc="启用麦克风进行语音对话">
            <Toggle
              checked={settings.voiceInputEnabled}
              onChange={(v) => onSettingChange('voiceInputEnabled', v)}
            />
          </SettingRow>
        </div>
      )}

      {activeSection === 'llm' && (
        <div style={styles.settingGroup}>
          <div style={styles.settingsGroupHeader}>
            <div>
              <div style={styles.sectionLabel}>语言模型</div>
              <div style={styles.sectionDesc}>选择引擎后只显示该引擎需要的配置；修改会自动保存到 config/.env。</div>
            </div>
            <span style={styles.profileBadge}>{envSaveLabel}</span>
          </div>

          <EnvRow
            label="当前引擎"
            desc="切换后立即使用对应引擎配置"
            group="llm"
            keyName="LLM_ENGINE"
            value={engine}
            onChange={setEnvKey}
            options={LLM_ENGINE_OPTIONS}
          />
          <div style={styles.engineSummary}>
            <span style={styles.engineSummaryLabel}>{engineLabel}</span>
            <span style={styles.engineSummaryDesc}>{LLM_ENGINE_OPTIONS.find(option => option.value === engine)?.description}</span>
          </div>

          {llmFieldVisible('LLM_BASE_URL') && (
            <EnvRow label="Base URL" group="llm" keyName="LLM_BASE_URL" value={env.llm?.LLM_BASE_URL ?? ''} onChange={setEnvKey} />
          )}
          {llmFieldVisible('LLM_MODEL') && (
            <EnvRow label="Model" group="llm" keyName="LLM_MODEL" value={env.llm?.LLM_MODEL ?? ''} onChange={setEnvKey} />
          )}
          {llmFieldVisible('DEEPSEEK_API_KEY') && (
            <EnvRow label="DeepSeek API Key" group="llm" keyName="DEEPSEEK_API_KEY" value={env.llm?.DEEPSEEK_API_KEY ?? ''} onChange={setEnvKey} type="password" />
          )}
          {llmFieldVisible('OPENAI_API_KEY') && (
            <EnvRow label="OpenAI API Key" group="llm" keyName="OPENAI_API_KEY" value={env.llm?.OPENAI_API_KEY ?? ''} onChange={setEnvKey} type="password" />
          )}
          {llmFieldVisible('OPENCODE_BASE_URL') && (
            <EnvRow label="OpenCode Base URL" group="llm" keyName="OPENCODE_BASE_URL" value={env.llm?.OPENCODE_BASE_URL ?? ''} onChange={setEnvKey} placeholder="http://127.0.0.1:4096/v1" />
          )}
          {llmFieldVisible('OPENCODE_MODEL') && (
            <EnvRow label="OpenCode Model" group="llm" keyName="OPENCODE_MODEL" value={env.llm?.OPENCODE_MODEL ?? ''} onChange={setEnvKey} placeholder="opencode" />
          )}
          {llmFieldVisible('OPENCODE_API_KEY') && (
            <EnvRow label="OpenCode API Key" group="llm" keyName="OPENCODE_API_KEY" value={env.llm?.OPENCODE_API_KEY ?? ''} onChange={setEnvKey} type="password" placeholder="local" />
          )}

          <details style={styles.advancedDetails}>
            <summary style={styles.advancedSummary}>通用生成参数</summary>
            <div style={styles.advancedContent}>
              <EnvRow label="Temperature" group="llm" keyName="LLM_TEMPERATURE" value={env.llm?.LLM_TEMPERATURE ?? ''} onChange={setEnvKey} />
              <EnvRow label="Reasoning Effort" group="llm" keyName="LLM_REASONING_EFFORT" value={env.llm?.LLM_REASONING_EFFORT ?? ''} onChange={setEnvKey} options={['low', 'medium', 'high']} />
              <EnvRow label="Timeout (s)" group="llm" keyName="LLM_TIMEOUT_SECONDS" value={env.llm?.LLM_TIMEOUT_SECONDS ?? ''} onChange={setEnvKey} />
              <EnvRow label="Max Output Tokens" group="llm" keyName="LLM_MAX_TOKENS" value={env.llm?.LLM_MAX_TOKENS ?? ''} onChange={setEnvKey} placeholder="8192" />
              <EnvRow label="Empty Reply Fallback" group="llm" keyName="LLM_EMPTY_REPLY_FALLBACK" value={env.llm?.LLM_EMPTY_REPLY_FALLBACK ?? ''} onChange={setEnvKey} placeholder="我刚才走神了，能再跟我说一遍吗？" />
            </div>
          </details>
        </div>
      )}

      {activeSection === 'voice' && (
        <div style={styles.settingGroup}>
          <div style={styles.settingsGroupHeader}>
            <div>
              <div style={styles.sectionLabel}>语音服务</div>
              <div style={styles.sectionDesc}>选择服务后只显示该服务需要的配置；修改会自动保存到 config/.env。</div>
            </div>
            <span style={styles.profileBadge}>{envSaveLabel}</span>
          </div>
          <div style={styles.inlineNav} role="tablist" aria-label="语音服务分类">
            {VOICE_SECTION_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={voiceSection === option.value}
                style={{
                  ...styles.inlineNavButton,
                  ...(voiceSection === option.value ? styles.inlineNavButtonActive : {}),
                }}
                onClick={() => setVoiceSection(option.value)}
              >
                <span>{option.label}</span>
                <small>{option.description}</small>
              </button>
            ))}
          </div>

          {voiceFieldVisible('ASR_ENGINE') && <EnvRow label="ASR Engine" group="asr" keyName="ASR_ENGINE" value={env.asr?.ASR_ENGINE ?? ''} onChange={setEnvKey} />}
          {voiceFieldVisible('ASR_BASE_URL') && <EnvRow label="ASR Base URL" group="asr" keyName="ASR_BASE_URL" value={env.asr?.ASR_BASE_URL ?? ''} onChange={setEnvKey} />}
          {voiceFieldVisible('ASR_API_KEY') && <EnvRow label="ASR API Key" group="asr" keyName="ASR_API_KEY" value={env.asr?.ASR_API_KEY ?? ''} onChange={setEnvKey} type="password" />}
          {voiceFieldVisible('TTS_ENGINE') && <EnvRow label="TTS Engine" group="tts" keyName="TTS_ENGINE" value={env.tts?.TTS_ENGINE ?? ''} onChange={setEnvKey} />}
          {voiceFieldVisible('TTS_BASE_URL') && <EnvRow label="TTS Base URL" group="tts" keyName="TTS_BASE_URL" value={env.tts?.TTS_BASE_URL ?? ''} onChange={setEnvKey} />}
          {voiceFieldVisible('TTS_API_KEY') && <EnvRow label="TTS API Key" group="tts" keyName="TTS_API_KEY" value={env.tts?.TTS_API_KEY ?? ''} onChange={setEnvKey} type="password" />}
          {voiceFieldVisible('GSVI_URL') && <EnvRow label="GSVI URL" group="gsvi" keyName="GSVI_URL" value={env.gsvi?.GSVI_URL ?? ''} onChange={setEnvKey} />}
          {voiceFieldVisible('GSVI_TEXT_LANG') && <EnvRow label="GSVI Text Lang" group="gsvi" keyName="GSVI_TEXT_LANG" value={env.gsvi?.GSVI_TEXT_LANG ?? ''} onChange={setEnvKey} />}
          {voiceFieldVisible('GSVI_PROMPT_LANG') && <EnvRow label="GSVI Prompt Lang" group="gsvi" keyName="GSVI_PROMPT_LANG" value={env.gsvi?.GSVI_PROMPT_LANG ?? ''} onChange={setEnvKey} />}
          {voiceFieldVisible('GSVI_SPEED') && <EnvRow label="GSVI Speed" group="gsvi" keyName="GSVI_SPEED" value={env.gsvi?.GSVI_SPEED ?? ''} onChange={setEnvKey} />}
          {voiceFieldVisible('GSVI_TIMEOUT') && <EnvRow label="GSVI Timeout (s)" group="gsvi" keyName="GSVI_TIMEOUT" value={env.gsvi?.GSVI_TIMEOUT ?? ''} onChange={setEnvKey} />}
        </div>
      )}
    </div>
  )
}

function EnvRow({ label, desc, group, keyName, value, onChange, options, type, placeholder }: {
  label: string
  desc?: string
  group: string
  keyName: string
  value: string
  onChange: (group: string, key: string, value: string) => void
  options?: ReadonlyArray<string | { value: string; label: string }>
  type?: string
  placeholder?: string
}) {
  return (
    <SettingRow label={label} desc={desc}>
      {options ? (
        <select
          style={styles.select}
          value={value}
          onChange={(e) => onChange(group, keyName, e.target.value)}
        >
          {options.map((option) => {
            const optionValue = typeof option === 'string' ? option : option.value
            const optionLabel = typeof option === 'string' ? option : option.label
            return <option key={optionValue} value={optionValue}>{optionLabel}</option>
          })}
        </select>
      ) : (
        <input
          style={{ ...styles.select, width: '100%', boxSizing: 'border-box' }}
          type={type || 'text'}
          value={value}
          onChange={(e) => onChange(group, keyName, e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
        />
      )}
    </SettingRow>
  )
}

// ── Tab: Animation ──

function AnimationTab({ settings, onSettingChange, accessoryParts, accessoryState, onAccessoryToggle }: {
  settings: AppSettings
  onSettingChange: (key: string, value: unknown) => void
  accessoryParts?: Record<string, string>
  accessoryState?: Record<string, boolean>
  onAccessoryToggle?: (label: string, enabled: boolean) => void
}) {
  const [calibrating, setCalibrating] = useState(false)
  const [calibrationValues, setCalibrationValues] = useState<Record<string, number>>({})
  const [audioDiagnostic, setAudioDiagnostic] = useState<{
    requestId: string
    phase: 'idle' | 'running' | 'passed' | 'failed'
    message: string
    peakVolume?: number
    peakMouth?: number
    finalMouth?: number
  }>({ requestId: '', phase: 'idle', message: '使用真实 AudioContext 验证播放、口型与中断闭嘴。' })
  const [models, setModels] = useState<string[]>([settings.live2dModel])
  useEffect(() => {
    void fetch('/api/models')
      .then(response => response.ok ? response.json() : Promise.reject(new Error('models unavailable')))
      .then((body: { models?: Array<{ name?: string }> }) => {
        const names = (body.models ?? []).map(model => String(model.name || '')).filter(Boolean)
        setModels(Array.from(new Set([settings.live2dModel, ...names])))
      })
      .catch(() => {})
  }, [settings.live2dModel])
  const fallback = readModelPerformanceDefaults(settings.live2dModel)
  const tuning = normalizeLive2DPerformanceSettings(
    settings.live2dPerformanceProfiles?.[settings.live2dModel],
    fallback,
  )
  const tuningRef = useRef(tuning)
  tuningRef.current = tuning

  useEffect(() => {
    setCalibrating(false)
    setCalibrationValues({})
    eventBus.emit('character:calibration_override', { clear: true })
  }, [settings.live2dModel])

  useEffect(() => () => {
    eventBus.emit('character:calibration_override', { clear: true })
    eventBus.emit('character:performance_tuning', tuningRef.current)
  }, [])

  useEffect(() => eventBus.on('audio:diagnostic.result', result => {
    setAudioDiagnostic(current => (
      !current.requestId || current.requestId === result.requestId
        ? { ...result }
        : current
    ))
  }), [])

  const updateTuning = (patch: Partial<Live2DPerformanceSettings>) => {
    const currentProfiles = settings.live2dPerformanceProfiles ?? {}
    onSettingChange('live2dPerformanceProfiles', {
      ...currentProfiles,
      [settings.live2dModel]: { ...tuning, ...patch },
    })
  }

  const toggleCalibration = () => {
    const next = !calibrating
    setCalibrating(next)
    setCalibrationValues({})
    eventBus.emit('character:calibration_override', { clear: true })
    eventBus.emit('character:performance_tuning', next ? { mode: 'calibration' } : tuning)
  }

  return (
    <div style={styles.tabContent}>
      <div style={styles.heroCard}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={styles.heroTitle}>Live2D 表现工作台</div>
          <div style={styles.heroDesc}>选择模型</div>
          <select
            style={styles.select}
            value={settings.live2dModel}
            onChange={(e) => onSettingChange('live2dModel', e.target.value)}
          >
            {models.map((model) => (
              <option key={model} value={model}>{model}</option>
            ))}
          </select>
        </div>
        <span style={styles.profileBadge}>模型独立配置</span>
      </div>

      {accessoryParts && Object.keys(accessoryParts).length > 0 && (
        <>
          <div style={styles.sectionDivider} />
          <div style={styles.sectionLabel}>Accessories</div>
          <div style={styles.sectionDesc}>Toggle model accessories on/off</div>
          <div style={styles.toggleCards}>
            {Object.keys(accessoryParts).map((label) => (
              <div key={label} style={styles.toggleCard}>
                <div style={styles.toggleCardInfo}>
                  <span style={styles.toggleCardLabel}>{label}</span>
                </div>
                <Toggle
                  checked={accessoryState?.[label] ?? true}
                  onChange={(enabled) => onAccessoryToggle?.(label, enabled)}
                />
              </div>
            ))}
          </div>
        </>
      )}

      <div style={styles.sectionLabel}>基础组件</div>
      <div style={styles.sectionDesc}>模型不支持的参数会由能力配置自动过滤。</div>

      <div style={styles.toggleCards}>
        {LIVE2D_TOGGLES.map(({ key, label, desc }) => (
          <div key={key} style={styles.toggleCard}>
            <div style={styles.toggleCardInfo}>
              <span style={styles.toggleCardLabel}>{label}</span>
              <span style={styles.toggleCardDesc}>{desc}</span>
            </div>
            <Toggle
              checked={settings[key]}
              onChange={(v) => onSettingChange(key, v)}
            />
          </div>
        ))}
      </div>

      <div style={styles.sectionDivider} />
      <div style={styles.sectionLabel}>表现强度</div>
      <div style={styles.sectionDesc}>按模型保存；增强模式启用连续微动和语义动作。</div>

      <div style={styles.controlCard}>
        <SettingRow label="表现模式" desc="兼容模式只保留旧控制链">
          <select
            style={styles.select}
            value={tuning.mode === 'legacy' ? 'legacy' : 'enhanced'}
            onChange={(event) => updateTuning({
              mode: event.target.value === 'legacy' ? 'legacy' : 'enhanced',
            })}
          >
            <option value="enhanced">自然增强</option>
            <option value="legacy">兼容模式</option>
          </select>
        </SettingRow>
        <RangeSetting
          label="整体动作"
          value={tuning.parameterGain}
          min={0.8}
          max={2.2}
          step={0.05}
          onChange={(parameterGain) => updateTuning({ parameterGain })}
        />
        <RangeSetting
          label="身体动作"
          value={tuning.bodyMotionGain}
          min={0.6}
          max={2}
          step={0.05}
          onChange={(bodyMotionGain) => updateTuning({ bodyMotionGain })}
        />
        <button
          type="button"
          style={styles.textButton}
          onClick={() => {
            const profiles = { ...(settings.live2dPerformanceProfiles ?? {}) }
            delete profiles[settings.live2dModel]
            onSettingChange('live2dPerformanceProfiles', profiles)
          }}
        >
          恢复该模型默认值
        </button>
        <button
          type="button"
          style={styles.textButton}
          onClick={() => eventBus.emit('character:viewport_reset', undefined)}
        >
          恢复模型默认构图
        </button>
      </div>

      <div style={styles.sectionDivider} />
      <div style={styles.sectionLabel}>快速试演</div>
      <div style={styles.buttonGrid}>
        {(['happy', 'sad', 'angry', 'surprised', 'shy', 'neutral'] as const).map(emotion => (
          <button
            type="button"
            key={emotion}
            style={styles.previewButton}
            onClick={() => eventBus.emit('character:intent', {
              emotion,
              behavior: 'react',
              intensity: 0.85,
            })}
          >
            {emotion}
          </button>
        ))}
        <button
          type="button"
          style={styles.previewButton}
          onClick={() => eventBus.emit('character:interaction', {
            type: 'touch',
            region: 'head',
            intensity: 0.8,
          })}
        >
          触摸反应
        </button>
      </div>

      <Live2DActionStudio
        model={settings.live2dModel}
        actionsByModel={settings.live2dActions ?? {}}
        onChange={actions => onSettingChange('live2dActions', actions)}
      />

      <Live2DRuntimeMonitor model={settings.live2dModel} />

      <div style={styles.controlCard}>
        <div style={styles.calibrationHeader}>
          <div>
            <div style={styles.cardTitle}>真实口型诊断</div>
            <div style={styles.cardDesc}>{audioDiagnostic.message}</div>
          </div>
          <button
            type="button"
            disabled={audioDiagnostic.phase === 'running'}
            style={{
              ...styles.calibrationButton,
              opacity: audioDiagnostic.phase === 'running' ? 0.6 : 1,
              backgroundColor: audioDiagnostic.phase === 'passed'
                ? '#246b4a'
                : audioDiagnostic.phase === 'failed'
                  ? '#7a3542'
                  : theme.colors.bg.surface,
            }}
            onClick={() => {
              const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
              setAudioDiagnostic({
                requestId,
                phase: 'running',
                message: '正在启动浏览器音频……',
              })
              eventBus.emit('audio:diagnostic.request', { requestId })
            }}
          >
            {audioDiagnostic.phase === 'running' ? '诊断中…' : '开始诊断'}
          </button>
        </div>
        {(audioDiagnostic.phase === 'passed' || audioDiagnostic.phase === 'failed') && (
          <div style={styles.sectionDesc}>
            音量峰值 {audioDiagnostic.peakVolume?.toFixed(3) ?? '—'} ·
            开口峰值 {audioDiagnostic.peakMouth?.toFixed(3) ?? '—'} ·
            结束嘴型 {audioDiagnostic.finalMouth?.toFixed(3) ?? '—'}
          </div>
        )}
      </div>

      <div style={styles.sectionDivider} />
      <div style={styles.calibrationCard}>
        <div style={styles.calibrationHeader}>
          <div>
            <div style={styles.cardTitle}>参数校准实验室</div>
            <div style={styles.cardDesc}>即时检查映射；离开页面后自动恢复，不写入模型文件。</div>
          </div>
          <button
            type="button"
            style={{
              ...styles.calibrationButton,
              backgroundColor: calibrating ? theme.colors.accent : theme.colors.bg.surface,
            }}
            onClick={toggleCalibration}
          >
            {calibrating ? '结束校准' : '开始校准'}
          </button>
        </div>
        {calibrating && (
          <div style={styles.calibrationGrid}>
            {CALIBRATION_CONTROLS.map(control => {
              const value = calibrationValues[control.logical] ?? 0
              return (
                <RangeSetting
                  key={control.logical}
                  label={control.label}
                  value={value}
                  min={control.min}
                  max={control.max}
                  step={control.step}
                  onChange={(next) => {
                    setCalibrationValues(current => ({ ...current, [control.logical]: next }))
                    eventBus.emit('character:calibration_override', {
                      logicalParameter: control.logical,
                      value: next,
                    })
                  }}
                />
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function Live2DRuntimeMonitor({ model }: { model: string }) {
  const [snapshot, setSnapshot] = useState<EventMap['character:performance_debug'] | null>(null)
  const [capability, setCapability] = useState<EventMap['character:model_capability'] | null>(null)
  const [probeId, setProbeId] = useState('')
  const [probeValue, setProbeValue] = useState(0)
  const [partProbeId, setPartProbeId] = useState('')
  const [partProbeOpacity, setPartProbeOpacity] = useState(1)
  const [renderEnvironment, setRenderEnvironment] = useState<EventMap['character:render_environment'] | null>(null)
  const [electronDiagnostics, setElectronDiagnostics] = useState<ElectronPerformanceDiagnostics | null>(null)

  const refreshEnvironment = () => {
    eventBus.emit('character:render_environment_request', undefined)
    void electronWindowBridge.getPerformanceDiagnostics().then(setElectronDiagnostics)
  }

  useEffect(() => eventBus.on('character:performance_debug', setSnapshot), [])
  useEffect(() => {
    const dispose = eventBus.on('character:render_environment', setRenderEnvironment)
    refreshEnvironment()
    return dispose
  }, [])
  useEffect(() => {
    const dispose = eventBus.on('character:model_capability', next => {
      if (next.model === model) setCapability(next)
    })
    eventBus.emit('character:model_capability_request', undefined)
    return dispose
  }, [model])
  useEffect(() => () => {
    eventBus.emit('character:parameter_probe', { clear: true })
    eventBus.emit('character:part_probe', { clear: true })
  }, [])

  const frame = snapshot?.frame
  const fps = frame?.averageIntervalMs ? 1000 / frame.averageIntervalMs : 0
  const contested = snapshot ? Object.keys(snapshot.contestedParameters).length : 0
  const motion = String(snapshot?.motion.motion ?? 'idle')
  const coverage = (snapshot?.profileCoverage.coverage ?? 0) * 100
  const probe = capability?.parameters.find(parameter => parameter.id === probeId)
  const partProbe = capability?.parts.find(part => part.id === partProbeId)
  const resolved = snapshot?.resolvedParameters ?? {}
  const director = snapshot?.director as {
    turnId?: string | null
    pendingCues?: unknown[]
    audio?: { durationMs?: number } | null
  } | undefined
  const tracking = snapshot?.tracking as {
    target?: { x?: number; y?: number }
    torsoVelocity?: { x?: number; y?: number }
  } | undefined
  const display = electronDiagnostics?.display
  const windowDiagnostics = electronDiagnostics?.window
  const refreshBudgetMs = display?.displayFrequency ? 1000 / display.displayFrequency : 0
  const acceptanceFloorFps = 110
  const pacingHealthy = frame ? fps >= acceptanceFloorFps : false
  const activeGpu = (() => {
    const info = electronDiagnostics?.gpuInfo as {
      gpuDevice?: Array<Record<string, unknown>>
      auxAttributes?: Record<string, unknown>
    } | null | undefined
    const devices = info?.gpuDevice ?? []
    const active = devices.find(device => device.active === true) ?? devices[0]
    const name = info?.auxAttributes?.glRenderer
      ?? active?.deviceString
      ?? active?.driverVendor
      ?? renderEnvironment?.webglRenderer
    return name ? String(name) : '—'
  })()
  const formatControl = (x: number | undefined, y: number | undefined) => (
    x === undefined && y === undefined ? '—' : `${(x ?? 0).toFixed(2)} / ${(y ?? 0).toFixed(2)}`
  )

  return (
    <div style={styles.runtimeMonitor}>
      <div style={styles.calibrationHeader}>
        <div>
          <div style={styles.cardTitle}>实时表现监控</div>
          <div style={styles.cardDesc}>逐帧采样控制、物理与渲染；界面以 4 Hz 汇总，不干扰动画循环。</div>
        </div>
        <span style={{ ...styles.profileBadge, color: pacingHealthy ? '#77d6a0' : theme.colors.accent }}>
          {frame ? `${fps.toFixed(0)} FPS` : '等待模型'}
        </span>
        <button type="button" style={styles.calibrationButton} onClick={refreshEnvironment}>刷新硬件数据</button>
      </div>
      <div style={styles.metricGrid}>
        <RuntimeMetric label="显示器刷新率" value={display?.displayFrequency ? `${display.displayFrequency} Hz` : '浏览器模式'} />
        <RuntimeMetric label="刷新预算" value={refreshBudgetMs ? `${refreshBudgetMs.toFixed(2)} ms` : '—'} />
        <RuntimeMetric label="110 FPS 验收线" value={frame ? (fps >= acceptanceFloorFps ? '达到' : '未达到') : '—'} />
        <RuntimeMetric label="显示刷新预算" value={frame && refreshBudgetMs ? (frame.p95IntervalMs <= refreshBudgetMs ? 'P95 达到' : 'P95 未达到') : '—'} />
        <RuntimeMetric label="帧间隔 P95" value={frame ? `${frame.p95IntervalMs.toFixed(1)} ms` : '—'} />
        <RuntimeMetric label="帧间隔 P99" value={frame ? `${frame.p99IntervalMs.toFixed(1)} ms` : '—'} />
        <RuntimeMetric label="单帧工作 P95 / P99" value={frame ? `${frame.phases.work.p95Ms.toFixed(1)} / ${frame.phases.work.p99Ms.toFixed(1)} ms` : '—'} />
        <RuntimeMetric label="控制 P95 / 物理 P95" value={frame ? `${frame.phases.controller.p95Ms.toFixed(1)} / ${frame.phases.model.p95Ms.toFixed(1)} ms` : '—'} />
        <RuntimeMetric label="提交渲染 P95 / P99" value={frame ? `${frame.phases.render.p95Ms.toFixed(1)} / ${frame.phases.render.p99Ms.toFixed(1)} ms` : '—'} />
        <RuntimeMetric label="长帧 (>33ms)" value={frame ? String(frame.longFrameCount) : '—'} />
        <RuntimeMetric label="Live2D 画布" value={renderEnvironment ? `${renderEnvironment.cssWidth}×${renderEnvironment.cssHeight} → ${renderEnvironment.pixelWidth}×${renderEnvironment.pixelHeight}` : '—'} />
        <RuntimeMetric label="渲染 DPR" value={renderEnvironment ? renderEnvironment.renderDpr.toFixed(2) : '—'} />
        <RuntimeMetric label="参数覆盖" value={snapshot ? `${coverage.toFixed(0)}%` : '—'} />
        <RuntimeMetric label="参数冲突" value={snapshot ? String(contested) : '—'} />
        <RuntimeMetric label="模型参数" value={capability ? String(capability.parameters.length) : '—'} />
        <RuntimeMetric label="模型部件" value={capability ? String(capability.parts.length) : '—'} />
      </div>
      <div style={styles.runtimeLine}>
        <span>WebGL：{renderEnvironment?.webglRenderer || '—'}</span>
        <span>Electron GPU：{activeGpu}</span>
        <span>硬件加速：{electronDiagnostics
          ? (electronDiagnostics.hardwareAccelerationEnabled === null ? 'Electron 31 未提供总开关状态' : (electronDiagnostics.hardwareAccelerationEnabled ? '开启' : '关闭'))
          : '—'}</span>
        <span>WebGL 状态：{electronDiagnostics?.gpuFeatureStatus.webgl || '—'}</span>
        <span>GPU 合成：{electronDiagnostics?.gpuFeatureStatus.gpu_compositing || '—'}</span>
        <span>高性能 GPU 开关：{electronDiagnostics ? (electronDiagnostics.forceHighPerformanceGpu ? '开启' : '关闭') : '—'}</span>
        <span>后台节流：{windowDiagnostics ? (windowDiagnostics.backgroundThrottling ? '允许' : '禁用') : '—'}</span>
        <span>动作：{motion}</span>
        <span>占用通道：{snapshot?.activeChannels.join(', ') || '无'}</span>
        <span>表情：{snapshot?.expression.name || 'neutral'}</span>
        <span>眼球 X/Y：{formatControl(resolved.ParamEyeBallX, resolved.ParamEyeBallY)}</span>
        <span>头部 X/Y：{formatControl(resolved.ParamAngleX, resolved.ParamAngleY)}</span>
        <span>躯干 X/Y/Z：{resolved.ParamBodyAngleX === undefined
          ? '—'
          : `${resolved.ParamBodyAngleX.toFixed(2)} / ${(resolved.ParamBodyAngleY ?? 0).toFixed(2)} / ${(resolved.ParamBodyAngleZ ?? 0).toFixed(2)}`}</span>
        <span>追踪目标：{formatControl(tracking?.target?.x, tracking?.target?.y)}</span>
        <span>躯干速度：{formatControl(tracking?.torsoVelocity?.x, tracking?.torsoVelocity?.y)}</span>
        <span>演出队列：{director?.turnId
          ? `${director.turnId.slice(0, 8)} · ${director.pendingCues?.length ?? 0} 个动作 · ${Math.round(director.audio?.durationMs ?? 0)} ms`
          : '空闲'}</span>
      </div>
      {snapshot && contested > 0 && (
        <details style={styles.parameterCatalog}>
          <summary style={styles.parameterSummary}>查看参数所有权冲突（{contested}）</summary>
          <div style={styles.conflictList}>
            {Object.entries(snapshot.contestedParameters).slice(0, 12).map(([parameterId, owners]) => (
              <div key={parameterId}>
                <strong>{parameterId}</strong>：{owners
                  .map(owner => `${owner.source}@${owner.priority}=${owner.value.toFixed(2)}`)
                  .join('；')}
              </div>
            ))}
          </div>
        </details>
      )}
      {capability && (
        <details style={styles.parameterCatalog}>
          <summary style={styles.parameterSummary}>模型参数目录（{capability.parameters.length}）</summary>
          <div style={styles.parameterList}>
            {capability.parameters.map(parameter => (
              <button
                type="button"
                key={parameter.id}
                title={`${parameter.minimum} … ${parameter.maximum}; default ${parameter.defaultValue}`}
                style={{ ...styles.parameterChip, borderColor: probeId === parameter.id ? theme.colors.accent : theme.colors.border }}
                onClick={() => {
                  setProbeId(parameter.id)
                  setProbeValue(parameter.value)
                }}
              >
                {parameter.displayName ? `${parameter.displayName} · ` : ''}{parameter.id}
              </button>
            ))}
          </div>
          <div style={styles.runtimeLine}>
            {capability.parts
              .filter(part => /尾|tail|尻|しっぽ/i.test(`${part.displayName ?? ''} ${part.id}`))
              .map(part => (
                <span key={part.id}>{part.displayName || part.id}：opacity {part.opacity.toFixed(2)}</span>
              ))}
          </div>
          {probe && (
            <div style={styles.probeControl}>
              <div style={styles.cardDesc}>探针仍通过统一混合器写入；物理输出参数可能在同一帧被模型物理层接管。</div>
              <RangeSetting
                label={probe.displayName || probe.id}
                value={probeValue}
                min={probe.minimum}
                max={probe.maximum}
                step={Math.max(0.001, (probe.maximum - probe.minimum) / 100)}
                onChange={value => {
                  setProbeValue(value)
                  eventBus.emit('character:parameter_probe', { parameterId: probe.id, value })
                }}
              />
              <input
                aria-label="参数探针精确值"
                type="number"
                min={probe.minimum}
                max={probe.maximum}
                step={Math.max(0.001, (probe.maximum - probe.minimum) / 100)}
                value={probeValue}
                style={styles.probeNumber}
                onChange={event => {
                  const value = Number(event.target.value)
                  if (!Number.isFinite(value)) return
                  setProbeValue(value)
                  eventBus.emit('character:parameter_probe', { parameterId: probe.id, value })
                }}
              />
              <button
                type="button"
                style={styles.textButton}
                onClick={() => {
                  eventBus.emit('character:parameter_probe', { clear: true })
                  setProbeId('')
                }}
              >
                清除参数探针
              </button>
            </div>
          )}
        </details>
      )}
      {capability && (
        <details style={styles.parameterCatalog}>
          <summary style={styles.parameterSummary}>模型部件目录（{capability.parts.length}）</summary>
          <div style={styles.parameterList}>
            {capability.parts.map(part => (
              <button
                type="button"
                key={part.id}
                title={`baseline opacity ${part.opacity}; parent ${part.parentIndex}`}
                style={{ ...styles.parameterChip, borderColor: partProbeId === part.id ? theme.colors.accent : theme.colors.border }}
                onClick={() => {
                  setPartProbeId(part.id)
                  setPartProbeOpacity(part.opacity)
                }}
              >
                {part.displayName ? `${part.displayName} · ` : ''}{part.id}
              </button>
            ))}
          </div>
          {partProbe && (
            <div style={styles.probeControl}>
              <RangeSetting
                label={partProbe.displayName || partProbe.id}
                value={partProbeOpacity}
                min={0}
                max={1}
                step={0.01}
                onChange={opacity => {
                  setPartProbeOpacity(opacity)
                  eventBus.emit('character:part_probe', { partId: partProbe.id, opacity })
                }}
              />
              <button
                type="button"
                style={styles.textButton}
                onClick={() => {
                  eventBus.emit('character:part_probe', { clear: true })
                  setPartProbeId('')
                }}
              >
                清除全部部件探针
              </button>
            </div>
          )}
        </details>
      )}
    </div>
  )
}

function RuntimeMetric({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.metricItem}>
      <span style={styles.metricLabel}>{label}</span>
      <span style={styles.metricValue}>{value}</span>
    </div>
  )
}

// ── Tab: Appearance (Accessories) ──

// ── Tab: About ──

function AboutTab() {
  return (
    <div style={styles.tabContent}>
      <div style={styles.sectionLabel}>Monika Companion</div>
      <div style={styles.aboutDesc}>
        A virtual companion powered by AI with Live2D character rendering.
      </div>
      <div style={styles.divider} />
      <div style={styles.aboutRow}>
        <span style={styles.aboutKey}>Version</span>
        <span style={styles.aboutValue}>0.1.0</span>
      </div>
      <div style={styles.aboutRow}>
        <span style={styles.aboutKey}>Renderer</span>
        <span style={styles.aboutValue}>Live2D Cubism 4</span>
      </div>
      <div style={styles.aboutRow}>
        <span style={styles.aboutKey}>Engine</span>
        <span style={styles.aboutValue}>WebGL</span>
      </div>
    </div>
  )
}

// ── Shared components ──

function SettingRow({ label, desc, children }: {
  label: string
  desc?: string
  children: React.ReactNode
}) {
  return (
    <div style={styles.settingRow}>
      <div style={styles.settingInfo}>
        <span style={styles.settingLabel}>{label}</span>
        {desc && <span style={styles.settingDesc}>{desc}</span>}
      </div>
      {children}
    </div>
  )
}

function RangeSetting({ label, value, min, max, step, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <label style={styles.rangeRow}>
      <span style={styles.rangeLabel}>{label}</span>
      <input
        aria-label={label}
        style={styles.rangeInput}
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span style={styles.rangeValue}>{value.toFixed(2)}</span>
    </label>
  )
}

function Toggle({ checked, disabled, onChange }: {
  checked: boolean
  disabled?: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label style={{ ...styles.toggleWrap, opacity: disabled ? 0.4 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}>
      <input
        type="checkbox"
        style={styles.toggleInput}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span style={{
        ...styles.toggleTrack,
        backgroundColor: checked ? theme.colors.accent : theme.colors.border,
      }}>
        <span style={{
          ...styles.toggleThumb,
          transform: checked ? 'translateX(18px)' : 'translateX(2px)',
        }} />
      </span>
    </label>
  )
}

// ── Styles ──

const styles: Record<string, React.CSSProperties> = {
  overlay: {
    position: 'fixed', inset: 0, backgroundColor: 'rgba(0, 0, 0, 0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: theme.zIndex.modal,
  },
  modal: {
    width: 560, maxWidth: '95vw', maxHeight: '85vh',
    backgroundColor: theme.colors.bg.root, border: `1px solid ${theme.colors.border}`,
    borderRadius: theme.radius.lg, display: 'flex', flexDirection: 'column', overflow: 'hidden',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)',
  },
  embedded: {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    backgroundColor: theme.colors.bg.root,
  },
  header: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: `${theme.spacing.lg}px ${theme.spacing.xl}px`,
    borderBottom: `1px solid ${theme.colors.border}`, flexShrink: 0,
  },
  title: { fontSize: theme.fontSize.lg, fontWeight: theme.fontWeight.semibold, color: theme.colors.text.primary },
  closeBtn: {
    width: 30, height: 30, borderRadius: theme.radius.sm, border: 'none',
    backgroundColor: 'transparent', color: theme.colors.text.secondary,
    fontSize: '1.3rem', cursor: 'pointer', display: 'flex', alignItems: 'center',
    justifyContent: 'center', lineHeight: 1, padding: 0,
  },
  body: {
    display: 'flex', flex: 1, overflow: 'hidden',
  },

  // ── Tab bar (left sidebar) ──
  tabBar: {
    width: 96, flexShrink: 0, display: 'flex', flexDirection: 'column',
    padding: `${theme.spacing.sm}px 0`, gap: 2,
    borderRight: `1px solid ${theme.colors.border}`,
    backgroundColor: theme.colors.bg.surface,
  },
  tabBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'flex-start', gap: 8,
    width: '100%', minHeight: 40, padding: '8px 10px', border: 'none', cursor: 'pointer',
    color: theme.colors.text.secondary, transition: 'background-color 0.1s',
  },
  tabIcon: { width: 17, height: 17, flexShrink: 0 },
  tabLabel: { fontSize: theme.fontSize.xs, fontWeight: theme.fontWeight.medium },

  // ── Content area ──
  content: {
    flex: 1, minWidth: 0, overflowY: 'auto', padding: `${theme.spacing.lg}px ${theme.spacing.lg}px ${theme.spacing.xl}px`,
    backgroundColor: theme.colors.bg.root,
  },
  tabContent: {
    display: 'flex', flexDirection: 'column', gap: theme.spacing.sm,
  },
  settingGroup: {
    display: 'flex', flexDirection: 'column', gap: 2,
    padding: `${theme.spacing.sm}px ${theme.spacing.md}px ${theme.spacing.md}px`,
    border: `1px solid ${theme.colors.border}`, borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.bg.panel, overflow: 'hidden',
  },
  settingsNav: {
    display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: theme.spacing.xs,
  },
  settingsNavButton: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
    minWidth: 0, padding: `${theme.spacing.sm}px ${theme.spacing.md}px`,
    border: `1px solid ${theme.colors.border}`, borderRadius: theme.radius.md,
    backgroundColor: theme.colors.bg.panel, color: theme.colors.text.secondary,
    textAlign: 'left' as const, cursor: 'pointer',
  },
  settingsNavButtonActive: {
    borderColor: theme.colors.accent, backgroundColor: 'rgba(217, 119, 87, 0.10)',
    color: theme.colors.text.primary,
  },
  settingsNavLabel: { fontSize: theme.fontSize.sm, fontWeight: theme.fontWeight.medium },
  settingsNavDesc: { fontSize: theme.fontSize.xs, color: theme.colors.text.muted, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%' },
  settingsGroupHeader: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: theme.spacing.md,
  },
  engineSummary: {
    display: 'flex', alignItems: 'baseline', gap: theme.spacing.sm,
    margin: `${theme.spacing.xs}px 0`, padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
    borderRadius: theme.radius.sm, backgroundColor: theme.colors.bg.surface,
  },
  engineSummaryLabel: { color: theme.colors.text.primary, fontSize: theme.fontSize.xs, fontWeight: theme.fontWeight.medium },
  engineSummaryDesc: { color: theme.colors.text.muted, fontSize: theme.fontSize.xs },
  advancedDetails: { marginTop: theme.spacing.sm, borderTop: `1px solid ${theme.colors.border}`, paddingTop: theme.spacing.sm },
  advancedSummary: { cursor: 'pointer', color: theme.colors.text.secondary, fontSize: theme.fontSize.xs, fontWeight: theme.fontWeight.medium },
  advancedContent: { marginTop: theme.spacing.xs },
  inlineNav: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: theme.spacing.xs, margin: `${theme.spacing.sm}px 0` },
  inlineNavButton: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2,
    minWidth: 0, padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
    border: `1px solid ${theme.colors.border}`, borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.bg.surface, color: theme.colors.text.secondary,
    textAlign: 'left' as const, cursor: 'pointer', fontSize: theme.fontSize.xs,
  },
  inlineNavButtonActive: { borderColor: theme.colors.accent, color: theme.colors.text.primary },

  // ── Section labels ──
  sectionLabel: {
    paddingLeft: 10, borderLeft: `2px solid ${theme.colors.accent}`,
    fontSize: theme.fontSize.xs, fontWeight: theme.fontWeight.semibold,
    color: theme.colors.text.secondary, textTransform: 'uppercase' as const,
    letterSpacing: '0.08em', marginTop: theme.spacing.sm,
  },
  sectionDesc: {
    fontSize: theme.fontSize.xs, color: theme.colors.text.muted,
    marginTop: 2, lineHeight: 1.45,
  },
  divider: {
    height: 1, backgroundColor: theme.colors.border,
    margin: `${theme.spacing.sm}px 0 ${theme.spacing.xs}px`,
  },
  emptyState: {
    fontSize: theme.fontSize.sm, color: theme.colors.text.muted,
    padding: `${theme.spacing.xl}px 0`, textAlign: 'center' as const,
  },

  // ── Setting row ──
  settingRow: {
    display: 'grid', gridTemplateColumns: 'minmax(112px, 0.9fr) minmax(0, 1.1fr)',
    alignItems: 'center', gap: theme.spacing.md, minHeight: 48,
    padding: '7px 0', borderBottom: `1px solid ${theme.colors.border}`,
  },
  settingInfo: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  settingLabel: { fontSize: theme.fontSize.sm, fontWeight: theme.fontWeight.medium, color: theme.colors.text.primary, lineHeight: 1.25 },
  settingDesc: { fontSize: theme.fontSize.xs, color: theme.colors.text.muted, marginTop: 1, lineHeight: 1.35 },
  subSectionLabel: {
    fontSize: '0.7rem', fontWeight: 600, color: '#7f899c',
    textTransform: 'uppercase', letterSpacing: '0.08em', marginTop: 10,
  },

  select: {
    padding: `${theme.spacing.xs}px ${theme.spacing.md}px`, borderRadius: theme.radius.md,
    border: `1px solid ${theme.colors.border}`, backgroundColor: theme.colors.bg.surface,
    color: theme.colors.text.primary, fontSize: theme.fontSize.sm, outline: 'none',
    cursor: 'pointer', width: '100%', minWidth: 0, maxWidth: '100%',
  },
  numberInput: {
    width: '100%', boxSizing: 'border-box', padding: `${theme.spacing.xs}px ${theme.spacing.sm}px`,
    borderRadius: theme.radius.md, border: `1px solid ${theme.colors.border}`,
    backgroundColor: theme.colors.bg.surface, color: theme.colors.text.primary,
    fontSize: theme.fontSize.sm, outline: 'none',
  },
  saveButton: {
    alignSelf: 'stretch', marginTop: theme.spacing.sm, padding: '8px 14px',
    borderRadius: theme.radius.md, border: `1px solid ${theme.colors.accent}`,
    backgroundColor: theme.colors.accent, color: '#fff', fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium, cursor: 'pointer',
  },

  // ── Toggle cards ──
  toggleCards: {
    display: 'flex', flexDirection: 'column', gap: theme.spacing.xs,
  },
  toggleCard: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: `${theme.spacing.sm}px ${theme.spacing.md}px`,
    backgroundColor: theme.colors.bg.surface,
    borderRadius: theme.radius.md,
    border: `1px solid ${theme.colors.border}`,
    gap: theme.spacing.md,
  },
  toggleCardInfo: {
    display: 'flex', flexDirection: 'column', gap: 1, flex: 1,
  },
  toggleCardLabel: {
    fontSize: theme.fontSize.sm, fontWeight: theme.fontWeight.medium,
    color: theme.colors.text.primary,
  },
  toggleCardDesc: {
    fontSize: theme.fontSize.xs, color: theme.colors.text.muted,
  },
  heroCard: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: theme.spacing.sm,
    padding: theme.spacing.md, borderRadius: theme.radius.md,
    background: `linear-gradient(135deg, ${theme.colors.bg.surface}, rgba(127, 99, 255, 0.12))`,
    border: `1px solid ${theme.colors.border}`,
  },
  heroTitle: {
    color: theme.colors.text.primary, fontSize: theme.fontSize.md,
    fontWeight: theme.fontWeight.semibold,
  },
  heroDesc: { color: theme.colors.text.muted, fontSize: theme.fontSize.xs, marginTop: 3 },
  profileBadge: {
    padding: '3px 7px', borderRadius: 999, whiteSpace: 'nowrap',
    color: theme.colors.accent, border: `1px solid ${theme.colors.accent}`,
    fontSize: theme.fontSize.xs,
  },
  sectionDivider: {
    height: 1, backgroundColor: theme.colors.border,
    margin: `${theme.spacing.sm}px 0 ${theme.spacing.xs}px`,
  },
  controlCard: {
    display: 'flex', flexDirection: 'column', gap: theme.spacing.sm,
    padding: theme.spacing.md, borderRadius: theme.radius.md,
    backgroundColor: theme.colors.bg.surface, border: `1px solid ${theme.colors.border}`,
  },
  rangeRow: {
    display: 'grid', gridTemplateColumns: '72px minmax(90px, 1fr) 42px',
    alignItems: 'center', gap: theme.spacing.sm, minHeight: 28,
  },
  rangeLabel: { color: theme.colors.text.secondary, fontSize: theme.fontSize.sm },
  rangeInput: { width: '100%', minWidth: 0, accentColor: theme.colors.accent },
  rangeValue: {
    color: theme.colors.text.primary, fontSize: theme.fontSize.xs,
    fontVariantNumeric: 'tabular-nums', textAlign: 'right',
  },
  textButton: {
    alignSelf: 'flex-start', border: 'none', padding: 0, background: 'transparent',
    color: theme.colors.accent, cursor: 'pointer', fontSize: theme.fontSize.xs,
  },
  buttonGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(78px, 1fr))',
    gap: theme.spacing.xs,
  },
  previewButton: {
    padding: '6px 8px', borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`, backgroundColor: theme.colors.bg.surface,
    color: theme.colors.text.secondary, cursor: 'pointer', fontSize: theme.fontSize.xs,
  },
  calibrationCard: {
    padding: theme.spacing.md, borderRadius: theme.radius.md,
    backgroundColor: theme.colors.bg.surface, border: `1px solid ${theme.colors.border}`,
  },
  backgroundCard: {
    display: 'flex', flexDirection: 'column', gap: theme.spacing.md,
    padding: theme.spacing.md, borderRadius: theme.radius.md,
    backgroundColor: theme.colors.bg.surface, border: `1px solid ${theme.colors.border}`,
  },
  backgroundHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing.md,
  },
  backgroundHeading: { minWidth: 0, flex: 1 },
  backgroundStatus: {
    display: 'inline-flex', alignItems: 'center', gap: 5, flexShrink: 0,
    padding: '4px 7px', borderRadius: theme.radius.full,
    color: theme.colors.status.connected, backgroundColor: 'rgba(125, 201, 160, 0.1)',
    fontSize: theme.fontSize.xs,
  },
  backgroundStatusError: { color: theme.colors.danger, backgroundColor: 'rgba(223, 133, 139, 0.1)' },
  backgroundStatusIdle: { color: theme.colors.text.muted, backgroundColor: 'rgba(127, 137, 156, 0.1)' },
  backgroundPreview: {
    position: 'relative', height: 132, overflow: 'hidden', borderRadius: theme.radius.md,
    border: `1px solid ${theme.colors.border}`, backgroundColor: theme.colors.bg.root,
    backgroundImage: 'linear-gradient(135deg, rgba(217,119,87,0.08), transparent 48%), linear-gradient(45deg, rgba(255,255,255,0.03) 25%, transparent 25%, transparent 75%, rgba(255,255,255,0.03) 75%)',
    backgroundSize: 'auto, 16px 16px',
  },
  backgroundPreviewMedia: { width: '100%', height: '100%', objectFit: 'contain' as const, display: 'block' },
  backgroundEmpty: {
    height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
    gap: 7, color: theme.colors.text.muted, fontSize: theme.fontSize.xs,
  },
  backgroundResourceRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: theme.spacing.md,
  },
  backgroundSettings: { display: 'flex', flexDirection: 'column', gap: 2, paddingTop: theme.spacing.xs, borderTop: `1px solid ${theme.colors.border}` },
  backgroundActions: {
    display: 'flex', flexDirection: 'column', gap: theme.spacing.xs,
  },
  primaryButton: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '7px 10px', borderRadius: theme.radius.sm, border: 'none',
    backgroundColor: theme.colors.accent, color: '#fff', cursor: 'pointer', fontSize: theme.fontSize.xs,
  },
  secondaryButton: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '7px 10px', borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`, backgroundColor: theme.colors.bg.panel,
    color: theme.colors.text.secondary, cursor: 'pointer', fontSize: theme.fontSize.xs,
  },
  iconButton: {
    display: 'grid', placeItems: 'center', width: 28, height: 28,
    borderRadius: theme.radius.sm, border: `1px solid ${theme.colors.border}`,
    backgroundColor: 'transparent', color: theme.colors.text.secondary, cursor: 'pointer',
  },
  backgroundMessage: {
    padding: '8px 10px', borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.bg.surface, color: theme.colors.text.muted,
    fontSize: theme.fontSize.xs, lineHeight: 1.45,
  },
  backgroundHint: { color: theme.colors.text.muted, fontSize: theme.fontSize.xs, lineHeight: 1.45 },
  calibrationHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: theme.spacing.md,
  },
  cardTitle: {
    color: theme.colors.text.primary, fontWeight: theme.fontWeight.medium,
    fontSize: theme.fontSize.sm,
  },
  cardDesc: {
    color: theme.colors.text.muted, fontSize: theme.fontSize.xs,
    marginTop: 2, lineHeight: 1.45,
  },
  calibrationButton: {
    flexShrink: 0, padding: '5px 8px', borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`, color: theme.colors.text.primary,
    cursor: 'pointer', fontSize: theme.fontSize.xs,
  },
  calibrationGrid: {
    display: 'flex', flexDirection: 'column', gap: 5,
    marginTop: theme.spacing.md, paddingTop: theme.spacing.md,
    borderTop: `1px solid ${theme.colors.border}`,
  },
  runtimeMonitor: {
    display: 'flex', flexDirection: 'column', gap: theme.spacing.md,
    padding: theme.spacing.md, borderRadius: theme.radius.md,
    backgroundColor: theme.colors.bg.surface, border: `1px solid ${theme.colors.border}`,
  },
  metricGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 6,
  },
  metricItem: {
    display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0,
    padding: '7px 8px', borderRadius: theme.radius.sm,
    backgroundColor: theme.colors.bg.elevated,
  },
  metricLabel: { color: theme.colors.text.muted, fontSize: theme.fontSize.xs },
  metricValue: {
    color: theme.colors.text.primary, fontSize: theme.fontSize.sm,
    fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
  },
  runtimeLine: {
    display: 'flex', flexWrap: 'wrap', gap: '5px 12px',
    color: theme.colors.text.secondary, fontSize: theme.fontSize.xs,
  },
  parameterCatalog: {
    borderTop: `1px solid ${theme.colors.border}`, paddingTop: theme.spacing.sm,
  },
  parameterSummary: {
    cursor: 'pointer', color: theme.colors.text.secondary, fontSize: theme.fontSize.xs,
  },
  parameterList: {
    display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 180, overflow: 'auto',
    marginTop: theme.spacing.sm, color: theme.colors.text.muted, fontSize: 10,
  },
  conflictList: {
    display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 150, overflow: 'auto',
    marginTop: theme.spacing.sm, color: theme.colors.text.muted, fontSize: 10,
    fontVariantNumeric: 'tabular-nums', lineHeight: 1.45,
  },
  parameterChip: {
    padding: '2px 4px', borderRadius: 4, border: `1px solid ${theme.colors.border}`,
    background: 'transparent', color: theme.colors.text.muted, fontSize: 10, cursor: 'pointer',
  },
  probeControl: {
    display: 'flex', flexDirection: 'column', gap: theme.spacing.sm,
    marginTop: theme.spacing.sm, paddingTop: theme.spacing.sm,
    borderTop: `1px solid ${theme.colors.border}`,
  },
  probeNumber: {
    width: 96, padding: '4px 6px', borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`, background: theme.colors.bg.panel,
    color: theme.colors.text.primary, fontSize: theme.fontSize.xs,
  },

  // ── About tab ──
  aboutDesc: {
    fontSize: theme.fontSize.sm, color: theme.colors.text.secondary,
    lineHeight: 1.5,
  },
  aboutRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '6px 0',
  },
  aboutKey: { fontSize: theme.fontSize.sm, color: theme.colors.text.secondary },
  aboutValue: { fontSize: theme.fontSize.sm, color: theme.colors.text.primary, fontWeight: theme.fontWeight.medium },

  // ── Proactive idle time ──
  proactiveIdleRow: {
    display: 'grid', gridTemplateColumns: 'minmax(112px, 0.9fr) minmax(0, 1.1fr)',
    alignItems: 'center', gap: theme.spacing.md, padding: '5px 0 5px 0',
    borderBottom: `1px solid ${theme.colors.border}`,
  },
  proactiveIdleLabel: {
    fontSize: theme.fontSize.xs, color: theme.colors.text.muted, whiteSpace: 'nowrap',
  },
  proactiveIdleButtons: {
    display: 'flex', gap: 4,
  },
  proactiveIdleBtn: {
    padding: '3px 8px', borderRadius: theme.radius.sm,
    border: `1px solid ${theme.colors.border}`,
    fontSize: theme.fontSize.xs, cursor: 'pointer',
    transition: 'all 0.12s',
  },

  // ── Toggle switch ──
  toggleWrap: { position: 'relative' as const, display: 'inline-block', justifySelf: 'end', flexShrink: 0 },
  toggleInput: { position: 'absolute' as const, opacity: 0, width: 0, height: 0, margin: 0 },
  toggleTrack: {
    display: 'inline-block', width: 40, height: 22, borderRadius: 11,
    transition: 'background-color 0.15s', position: 'relative' as const,
  },
  toggleThumb: {
    display: 'inline-block', width: 18, height: 18, borderRadius: '50%',
    backgroundColor: theme.colors.text.primary, position: 'absolute' as const, top: 2, left: 0,
    transition: 'transform 0.15s', boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
  },
}
