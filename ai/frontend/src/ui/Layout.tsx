import { ChevronRight } from 'lucide-react'
import {
  useEffect,
  useReducer,
  useRef,
  type PointerEvent,
  type ReactNode,
} from 'react'

import {
  DEFAULT_DRAWER_WIDTH,
  createInitialDrawerState,
  reduceDrawerState,
  type DrawerSection,
} from './workspace-state'
import { createFrameCoalescer, type FrameCoalescer } from './frame-coalescer'

export interface DrawerItem {
  id: DrawerSection
  label: string
  icon: ReactNode
  placement?: 'main' | 'bottom'
}

export interface LayoutProps {
  characterArea: ReactNode
  background?: ReactNode
  subtitle: ReactNode
  conversationArea: ReactNode
  drawerItems: DrawerItem[]
  renderDrawer: (section: DrawerSection) => ReactNode
}

const ACTIVE_KEY = 'ui.stage.drawer.active'
const WIDTH_KEY = 'ui.stage.drawer.width'

function initialDrawerState() {
  const storedActive = localStorage.getItem(ACTIVE_KEY)
  const storedWidth = Number(localStorage.getItem(WIDTH_KEY))
  return createInitialDrawerState(storedActive, storedWidth || DEFAULT_DRAWER_WIDTH)
}

export function Layout({
  characterArea,
  background,
  subtitle,
  conversationArea,
  drawerItems,
  renderDrawer,
}: LayoutProps) {
  const [drawer, dispatch] = useReducer(reduceDrawerState, undefined, initialDrawerState)
  const stopResizeRef = useRef<(() => void) | null>(null)
  const resizeCoalescerRef = useRef<FrameCoalescer<number> | null>(null)

  if (!resizeCoalescerRef.current) {
    resizeCoalescerRef.current = createFrameCoalescer(
      width => dispatch({ type: 'resize', width }),
    )
  }

  useEffect(() => {
    localStorage.setItem(ACTIVE_KEY, drawer.expanded ? drawer.section : 'closed')
    localStorage.setItem(WIDTH_KEY, String(drawer.width))
  }, [drawer])

  useEffect(() => () => {
    stopResizeRef.current?.()
    resizeCoalescerRef.current?.cancel()
  }, [])

  const beginResize = (event: PointerEvent<HTMLDivElement>) => {
    stopResizeRef.current?.()
    event.currentTarget.setPointerCapture(event.pointerId)
    const startX = event.clientX
    const startWidth = drawer.width
    const onMove = (moveEvent: globalThis.PointerEvent) => {
      resizeCoalescerRef.current?.schedule(startWidth + startX - moveEvent.clientX)
    }
    const onEnd = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      stopResizeRef.current = null
    }
    stopResizeRef.current = onEnd
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
  }

  const renderNavButton = (item: DrawerItem) => (
    <button
      key={item.id}
      type="button"
      className={drawer.section === item.id ? 'is-active' : ''}
      onClick={() => dispatch({ type: 'select', section: item.id })}
      title={item.label}
      aria-label={item.label}
      aria-pressed={drawer.section === item.id}
    >
      <span aria-hidden="true">{item.icon}</span>
    </button>
  )

  return (
    <div className="workspace-shell">
      <aside className="stage-rail" aria-label="功能导航">
        <nav aria-label="主要功能">
          {drawerItems.filter(item => item.placement !== 'bottom').map(renderNavButton)}
        </nav>
        <nav className="rail-bottom" aria-label="开发功能">
          {drawerItems.filter(item => item.placement === 'bottom').map(renderNavButton)}
        </nav>
      </aside>

      <main className="companion-stage">
        {background}
        <div className="character-stage">
          {characterArea}
        </div>
        {subtitle}
        <div className="stage-conversation">{conversationArea}</div>
      </main>

      {drawer.expanded && (
        <aside
          className="stage-drawer"
          style={{ width: drawer.width, flexBasis: drawer.width }}
          aria-label={`${drawerItems.find(item => item.id === drawer.section)?.label ?? ''}面板`}
        >
          <button
            type="button"
            className="drawer-edge-toggle is-expanded"
            onClick={() => dispatch({ type: 'toggle' })}
            aria-label="收起侧栏"
            title="收起侧栏"
          >
            <ChevronRight size={16} strokeWidth={1.75} aria-hidden="true" />
          </button>
          <div
            className="drawer-resize-handle"
            onPointerDown={beginResize}
            role="separator"
            aria-orientation="vertical"
            aria-label="调整面板宽度"
          />
          {renderDrawer(drawer.section)}
        </aside>
      )}
    </div>
  )
}
