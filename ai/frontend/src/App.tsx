import { StoreProvider } from './core/store'
import { ErrorBoundary } from './ui/ErrorBoundary'
import { DesktopSessionWorkspace } from './session/DesktopSessionProvider'
import { PetConversationSurface } from './ui/PetSurfaces'
import './styles/index.css'

export default function App() {
  const surface = new URLSearchParams(window.location.search).get('surface')
  return (
    <ErrorBoundary>
      <StoreProvider>
        {surface === 'pet-conversation'
          ? <PetConversationSurface />
          : <DesktopSessionWorkspace />}
      </StoreProvider>
    </ErrorBoundary>
  )
}
