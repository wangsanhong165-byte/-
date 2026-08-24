// Centralized state store with selector hooks
// Uses useReducer internally for predictable state transitions

import {
  createContext,
  useContext,
  useReducer,
  useRef,
  useEffect,
  type ReactNode,
  type Context,
} from 'react'
import type { ConnectionState, AiActivity, CharacterState, ChatMessage, AudioState } from './types'
import type { Live2DPerformanceProfileOverrides } from '../character/Live2DPerformanceSettings'
import type { Live2DActionsByModel } from '../character/MotionAction'

// ── History Types ──

export interface HistoryEntry {
  uid: string
  latest_message: string
  timestamp: string
}

// ── Settings ──

export interface AppSettings {
  alwaysOnTop: boolean
  voiceInputEnabled: boolean
  activeCharacterId: string
  live2dModel: string
  windowMode: 'window' | 'pet'
  proactive: boolean
  proactiveIdleTime: number  // seconds before AI proactively speaks
  // Live2D component toggles
  live2dBlink: boolean
  live2dBreathe: boolean
  live2dLipSync: boolean
  live2dHeadTracking: boolean
  live2dExpression: boolean
  live2dIdle: boolean
  live2dClickFeedback: boolean
  live2dPerformanceProfiles: Live2DPerformanceProfileOverrides
  live2dActions: Live2DActionsByModel
  backgroundType: 'none' | 'image' | 'video'
  backgroundUrl: string
  backgroundPath: string
  backgroundLabel: string
  backgroundFit: 'cover' | 'contain' | 'fill'
  backgroundOpacity: number
}

// ── Conversation State ──

export interface ConversationState {
  historyUid: string
  histories: HistoryEntry[]
  loading: boolean
}

// ── Root State ──

export interface AppState {
  connection: ConnectionState
  activity: AiActivity
  statusMessage: string
  ttsActive: boolean
  character: CharacterState
  messages: ChatMessage[]
  audio: AudioState
  settings: AppSettings
  conversation: ConversationState
}

const INITIAL_CHARACTER: CharacterState = {
  emotion: 'neutral',
  intensity: 0.5,
  activity: 'idle',
  expression: 'neutral',
  motion: '',
  idlePose: 'default',
  active: true,
}

const INITIAL_SETTINGS: AppSettings = {
  alwaysOnTop: false,
  voiceInputEnabled: true,
  activeCharacterId: 'monika',
  live2dModel: 'shirone',
  windowMode: 'window',
  proactive: true,
  proactiveIdleTime: 120,  // default 2 min
  // Live2D components default: all enabled
  live2dBlink: true,
  live2dBreathe: true,
  live2dLipSync: true,
  live2dHeadTracking: true,
  live2dExpression: true,
  live2dIdle: true,
  live2dClickFeedback: true,
  live2dPerformanceProfiles: {},
  live2dActions: {},
  backgroundType: 'none',
  backgroundUrl: '',
  backgroundPath: '',
  backgroundLabel: '',
  // Preserve the source ratio and avoid enlarging small background assets.
  backgroundFit: 'contain',
  backgroundOpacity: 1,
}

export const INITIAL_STATE: AppState = {
  connection: 'disconnected',
  activity: 'idle',
  statusMessage: '',
  ttsActive: false,
  character: INITIAL_CHARACTER,
  messages: [],
  audio: { isPlaying: false, isQueued: false },
  settings: INITIAL_SETTINGS,
  conversation: { historyUid: '', histories: [], loading: false },
}

// ── Action Types ──

type Action =
  | { type: 'SET_CONNECTION'; connection: ConnectionState }
  | { type: 'SET_ACTIVITY'; activity: AiActivity }
  | { type: 'SET_STATUS_MESSAGE'; message: string }
  | { type: 'SET_CHARACTER'; emotion: string; intensity: number; expression?: string; motion?: string }
  | { type: 'SET_CHARACTER_ACTIVITY'; activity: AiActivity }
  | { type: 'SET_CHARACTER_FIELD'; key: string; value: unknown }
  | { type: 'ADD_MESSAGE'; message: ChatMessage }
  | { type: 'UPDATE_LAST_ASSISTANT'; text: string; reasoning?: string }
  | { type: 'CLEAR_MESSAGES' }
  | { type: 'SET_MESSAGES'; messages: ChatMessage[] }
  | { type: 'SET_TTS_PLAYING'; playing: boolean }
  | { type: 'SET_SETTING'; key: keyof AppSettings; value: unknown }
  | { type: 'SET_HISTORIES'; histories: HistoryEntry[] }
  | { type: 'SET_HISTORY_UID'; uid: string }
  | { type: 'SET_CONVERSATION_LOADING'; loading: boolean }
  | { type: 'RESET_CHARACTER' }

// ── Reducer ──

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_CONNECTION':
      return { ...state, connection: action.connection }

    case 'SET_ACTIVITY':
      return { ...state, activity: action.activity }

    case 'SET_STATUS_MESSAGE':
      return { ...state, statusMessage: action.message }

    case 'SET_CHARACTER':
      return {
        ...state,
        character: {
          ...state.character,
          emotion: action.emotion,
          intensity: action.intensity,
          expression: action.expression ?? action.emotion,
          motion: action.motion ?? state.character.motion,
        },
      }

    case 'SET_CHARACTER_ACTIVITY':
      return { ...state, character: { ...state.character, activity: action.activity } }

    case 'SET_CHARACTER_FIELD':
      return { ...state, character: { ...state.character, [action.key]: action.value } as CharacterState }

    case 'ADD_MESSAGE': {
      const msgs = [...state.messages, action.message]
      // Cap at 200 messages to prevent memory issues
      const capped = msgs.length > 200 ? msgs.slice(-200) : msgs
      return { ...state, messages: capped }
    }

    case 'UPDATE_LAST_ASSISTANT': {
      const msgs = [...state.messages]
      let found = false
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].role === 'assistant') {
          msgs[i] = { ...msgs[i], text: action.text, reasoning: action.reasoning ?? msgs[i].reasoning }
          found = true
          break
        }
      }
      if (!found && action.text) {
        msgs.push({
          id: `assistant_${Date.now()}`,
          role: 'assistant',
          text: action.text,
          reasoning: action.reasoning,
          timestamp: Date.now(),
        })
      }
      return { ...state, messages: msgs }
    }

    case 'CLEAR_MESSAGES':
      return { ...state, messages: [] }

    case 'SET_MESSAGES':
      return { ...state, messages: action.messages }

    case 'SET_TTS_PLAYING':
      return {
        ...state,
        ttsActive: action.playing,
        audio: { ...state.audio, isPlaying: action.playing },
      }

    case 'SET_SETTING':
      return { ...state, settings: { ...state.settings, [action.key]: action.value as never } }

    case 'SET_HISTORIES':
      return { ...state, conversation: { ...state.conversation, histories: action.histories } }

    case 'SET_HISTORY_UID':
      return { ...state, conversation: { ...state.conversation, historyUid: action.uid } }

    case 'SET_CONVERSATION_LOADING':
      return { ...state, conversation: { ...state.conversation, loading: action.loading } }

    case 'RESET_CHARACTER':
      return { ...state, character: INITIAL_CHARACTER }

    default:
      return state
  }
}

// ── Context ──

interface StoreContextValue {
  state: AppState
  dispatch: React.Dispatch<Action>
}

const StoreContext: Context<StoreContextValue | null> = createContext<StoreContextValue | null>(null)

// ── Provider ──

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE)
  return <StoreContext.Provider value={{ state, dispatch }}>{children}</StoreContext.Provider>
}

// ── Selector Hook ──

export function useSelector<T>(selector: (state: AppState) => T): T {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useSelector must be used within StoreProvider')
  return selector(ctx.state)
}

// ── Dispatch Hook ──

export function useDispatch() {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useDispatch must be used within StoreProvider')
  return ctx.dispatch
}

// ── Convenience Selectors ──

export const selectConnection = (s: AppState) => s.connection
export const selectActivity = (s: AppState) => s.activity
export const selectStatusMessage = (s: AppState) => s.statusMessage
export const selectCharacter = (s: AppState) => s.character
export const selectMessages = (s: AppState) => s.messages
export const selectAudioState = (s: AppState) => s.audio
export const selectTtsActive = (s: AppState) => s.ttsActive
export const selectSettings = (s: AppState) => s.settings
export const selectConversation = (s: AppState) => s.conversation
export const selectHistories = (s: AppState) => s.conversation.histories
export const selectHistoryUid = (s: AppState) => s.conversation.historyUid

// ── Action Helpers ──

export function useActions() {
  const dispatch = useDispatch()

  return useRef({
    setConnection: (connection: ConnectionState) =>
      dispatch({ type: 'SET_CONNECTION', connection }),

    setActivity: (activity: AiActivity) =>
      dispatch({ type: 'SET_ACTIVITY', activity }),

    setStatusMessage: (message: string) =>
      dispatch({ type: 'SET_STATUS_MESSAGE', message }),

    setCharacter: (emotion: string, intensity: number, expression?: string, motion?: string) =>
      dispatch({ type: 'SET_CHARACTER', emotion, intensity, expression, motion }),

    setCharacterActivity: (activity: AiActivity) =>
      dispatch({ type: 'SET_CHARACTER_ACTIVITY', activity }),

    addMessage: (msg: ChatMessage) =>
      dispatch({ type: 'ADD_MESSAGE', message: msg }),

    updateLastAssistant: (text: string, reasoning?: string) =>
      dispatch({ type: 'UPDATE_LAST_ASSISTANT', text, reasoning }),

    clearMessages: () =>
      dispatch({ type: 'CLEAR_MESSAGES' }),

    setMessages: (messages: ChatMessage[]) =>
      dispatch({ type: 'SET_MESSAGES', messages }),

    setAudioPlaying: (playing: boolean) =>
      dispatch({ type: 'SET_TTS_PLAYING', playing }),

    setSetting: (key: keyof AppSettings, value: unknown) =>
      dispatch({ type: 'SET_SETTING', key, value }),

    setHistories: (histories: HistoryEntry[]) =>
      dispatch({ type: 'SET_HISTORIES', histories }),

    setHistoryUid: (uid: string) =>
      dispatch({ type: 'SET_HISTORY_UID', uid }),

    setConversationLoading: (loading: boolean) =>
      dispatch({ type: 'SET_CONVERSATION_LOADING', loading }),
  }).current
}

// ── useAutoCleanup Effect ──

export function useStoreCleanup(cleanup: () => void, deps: unknown[]) {
  const hasRun = useRef(false)

  useEffect(() => {
    if (!hasRun.current) {
      hasRun.current = true
      return
    }
    return cleanup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
