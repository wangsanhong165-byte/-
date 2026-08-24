// Core type definitions for the Companion frontend

// === Connection ===

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

// === AI Activity State ===

export type AiActivity =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'processing'

// === Character State ===

export interface CharacterState {
  /** Current emotion name (e.g. "happy", "sad") */
  emotion: string
  /** Emotion intensity 0–1 */
  intensity: number
  /** Current activity (drives animation) */
  activity: AiActivity
  /** Specific expression name (may differ from emotion, e.g. "smile") */
  expression: string
  /** Current behavior/motion name (e.g. "wave", "nod") */
  motion: string
  /** Idle animation variant */
  idlePose: string
  /** Whether character is "active"/present */
  active: boolean
}

// === Chat Message ===

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  reasoning?: string
  timestamp: number
}

// === Audio State ===

export interface AudioState {
  isPlaying: boolean
  isQueued: boolean
}

// === Emotion Event (from Runtime) ===

export interface EmotionEvent {
  emotion: string
  intensity: number
}

// === App Status ===

export interface AppStatus {
  connection: ConnectionState
  activity: AiActivity
  statusMessage: string
  ttsActive: boolean
}
