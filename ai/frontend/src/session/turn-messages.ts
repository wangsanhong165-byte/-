import type { ChatMessage } from '../core/types.ts'

export function assistantPlaceholderForTurn(
  origin: string,
  turnId: string,
  timestamp = Date.now(),
): ChatMessage | null {
  if (origin !== 'initiative') return null
  return {
    id: `assistant_${turnId}`,
    role: 'assistant',
    text: '',
    timestamp,
  }
}
