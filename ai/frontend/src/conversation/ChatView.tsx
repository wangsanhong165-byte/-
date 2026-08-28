import { useEffect, useRef } from 'react'
import { useSelector, selectMessages } from '../core/store'
import type { ChatMessage } from '../core/types'

function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  return (
    <article className={`chat-message ${isUser ? 'is-user' : ''} ${isSystem ? 'is-system' : ''}`}>
      <div className="message-meta">
        <strong>{isUser ? '你' : isSystem ? '系统' : 'Aurora'}</strong>
        <time>{new Date(message.timestamp).toLocaleTimeString('zh-CN', {
          hour: '2-digit',
          minute: '2-digit',
        })}</time>
      </div>
      {message.imageCount ? <span className="message-attachment">已附加 {message.imageCount} 张图片</span> : null}
      <p>{message.text || (!isUser && !isSystem ? '正在组织语言…' : '')}</p>
    </article>
  )
}

export function ChatView() {
  const messages = useSelector(selectMessages)
  const listRef = useRef<HTMLDivElement>(null)
  const visible = messages
  const lastText = visible.at(-1)?.text ?? ''

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [visible.length, lastText])

  return (
    <div className="chat-view" ref={listRef}>
      {visible.map(message => <Message key={message.id} message={message} />)}
    </div>
  )
}
