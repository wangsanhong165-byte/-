import { Database, FilePenLine, History, MessageSquareText, Settings, SlidersHorizontal, Sparkles, UsersRound, Wrench } from 'lucide-react'

import type { RecorderState } from '../audio/recorder'
import { CharacterView } from '../character/CharacterView'
import { ChatView } from '../conversation/ChatView'
import { HistoryPanel, type HistoryEntry } from '../conversation/HistoryPanel'
import type { AppSettings } from '../core/store'
import { DeveloperWorkspace } from './DeveloperWorkspace'
import { DrawerPanel } from './DrawerPanel'
import { InputBar } from './InputBar'
import { Layout, type DrawerItem } from './Layout'
import { Live2DWorkbench, SettingsPanel } from './SettingsPanel'
import { PromptPanel } from './PromptPanel'
import { StageSubtitle } from './StageSubtitle'
import {
  CapabilityPanel,
  CharacterSelfPanel,
  MemoryPanel,
} from './UserViewPanels'
import type { DrawerSection } from './workspace-state'
import { CharacterManagerPanel } from './CharacterManagerPanel'
import { StageBackground } from './StageBackground'
import type { CharacterDescriptor } from './character-catalog'

const DRAWER_ITEMS: DrawerItem[] = [
  { id: 'history', label: '聊天记录', icon: <History /> },
  { id: 'prompt', label: '提示词', icon: <FilePenLine /> },
  { id: 'character', label: '角色', icon: <MessageSquareText /> },
  { id: 'memory', label: '记忆', icon: <Database /> },
  { id: 'capabilities', label: '能力', icon: <Sparkles /> },
  { id: 'characters', label: '角色库', icon: <UsersRound /> },
  { id: 'live2d', label: 'Live2D', icon: <SlidersHorizontal /> },
  { id: 'settings', label: '设置', icon: <Settings /> },
  { id: 'developer', label: '开发者', icon: <Wrench />, placement: 'bottom' },
]

export interface CompanionWorkspaceProps {
  settings: AppSettings
  requestCommand: (action: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>
  recorderState: RecorderState
  recordingSupported: boolean
  onToggleRecording: () => void | Promise<void>
  histories: HistoryEntry[]
  historyUid: string
  historyLoading: boolean
  historyRevision: number
  subtitleText: string
  subtitleSpeaking: boolean
  accessoryParts: Record<string, string>
  accessoryState: Record<string, boolean>
  onSend: (text: string) => void
  onInterrupt: () => void
  onLoadHistory: (uid: string) => void
  onDeleteHistory: (uid: string) => void
  onCreateHistory: () => void
  onSettingChange: (key: string, value: unknown) => void
  onCharacterActivate: (
    character: CharacterDescriptor,
    runtimeAlreadySwitched?: boolean,
  ) => Promise<void>
  onAccessoryToggle: (label: string, enabled: boolean) => void
}

export function CompanionWorkspace(props: CompanionWorkspaceProps) {
  const renderDrawer = (section: DrawerSection) => {
    if (section === 'history') {
      return (
        <DrawerPanel title="聊天记录">
          <HistoryPanel
            histories={props.histories}
            activeUid={props.historyUid}
            loading={props.historyLoading}
            onLoad={props.onLoadHistory}
            onDelete={props.onDeleteHistory}
            onCreate={props.onCreateHistory}
          />
        </DrawerPanel>
      )
    }
    if (section === 'prompt') {
      return (
        <PromptPanel
          requestCommand={props.requestCommand}
          activeCharacterId={props.settings.activeCharacterId}
        />
      )
    }
    if (section === 'settings') {
      return (
        <SettingsPanel
          open
          embedded
          onClose={() => {}}
          settings={props.settings}
          onSettingChange={props.onSettingChange}
        />
      )
    }
    if (section === 'live2d') {
      return (
        <DrawerPanel title="Live2D">
          <Live2DWorkbench
            settings={props.settings}
            onSettingChange={props.onSettingChange}
            accessoryParts={props.accessoryParts}
            accessoryState={props.accessoryState}
            onAccessoryToggle={props.onAccessoryToggle}
          />
        </DrawerPanel>
      )
    }
    if (section === 'developer') {
      return <DeveloperWorkspace requestCommand={props.requestCommand} />
    }
    if (section === 'characters') return (
      <CharacterManagerPanel
        requestCommand={props.requestCommand}
        onActivate={props.onCharacterActivate}
      />
    )
    if (section === 'character') return <CharacterSelfPanel requestCommand={props.requestCommand} />
    if (section === 'memory') return <MemoryPanel requestCommand={props.requestCommand} />
    return <CapabilityPanel requestCommand={props.requestCommand} />
  }

  return (
    <Layout
      characterArea={<CharacterView />}
      background={props.settings.windowMode === 'pet' ? null : <StageBackground settings={props.settings} />}
      subtitle={props.settings.windowMode === 'pet' ? null : (
        <StageSubtitle text={props.subtitleText} speaking={props.subtitleSpeaking} />
      )}
      conversationArea={(
        <div className="conversation-dock">
          <ChatView />
          <InputBar
            onSend={props.onSend}
            onInterrupt={props.onInterrupt}
            recorderState={props.recorderState}
            recordingSupported={props.recordingSupported}
            onToggleRecording={props.onToggleRecording}
          />
        </div>
      )}
      drawerItems={DRAWER_ITEMS}
      renderDrawer={renderDrawer}
      petMode={props.settings.windowMode === 'pet'}
      onExitPetMode={() => props.onSettingChange('windowMode', 'window')}
    />
  )
}
