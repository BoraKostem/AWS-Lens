import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'

import { LEGACY_STORAGE_NAMESPACE } from '@shared/branding'
import { FitAddon } from 'xterm-addon-fit'
import { Terminal } from 'xterm'

import type { ProviderTerminalTarget } from './api'
import {
  closeAwsTerminal,
  openProviderTerminal,
  resizeAwsTerminal,
  sendAwsTerminalInput,
  subscribeToAwsTerminal,
  updateProviderTerminalContext,
  type TerminalEvent
} from './api'

type TerminalBundle = {
  term: Terminal
  fit: FitAddon
}

type TerminalTab = {
  id: string
  target: ProviderTerminalTarget
  title: string
  status: 'starting' | 'running' | 'exited'
  exitCode: number | null
}

const DEFAULT_PANEL_HEIGHT = 320
const MIN_PANEL_HEIGHT = 220
const MAX_PANEL_HEIGHT = 640
const HEIGHT_STORAGE_KEY = `${LEGACY_STORAGE_NAMESPACE}:provider-terminal-height`

function makeTerminalId(): string {
  return `terminal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function makeTabLabel(target: ProviderTerminalTarget, duplicateCount: number): string {
  const suffix = duplicateCount > 0 ? ` ${duplicateCount + 1}` : ''
  return `${target.label}${suffix}`
}

function clampPanelHeight(nextHeight: number): number {
  return Math.min(MAX_PANEL_HEIGHT, Math.max(MIN_PANEL_HEIGHT, Math.round(nextHeight)))
}

function matchesTarget(left: ProviderTerminalTarget, right: ProviderTerminalTarget): boolean {
  return left.providerId === right.providerId && left.modeId === right.modeId
}

function TerminalTabSurface({
  tab,
  active,
  drawerOpen,
  fontSize,
  initialCommand,
  onInitialCommandHandled,
  onExited
}: {
  tab: TerminalTab
  active: boolean
  drawerOpen: boolean
  fontSize: number
  initialCommand?: string
  onInitialCommandHandled: () => void
  onExited: (sessionId: string, code: number | null) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const bundleRef = useRef<TerminalBundle | null>(null)
  const initialCommandRef = useRef(initialCommand)
  const activeRef = useRef(active)
  const drawerOpenRef = useRef(drawerOpen)
  const onExitedRef = useRef(onExited)
  const onInitialCommandHandledRef = useRef(onInitialCommandHandled)

  useEffect(() => {
    activeRef.current = active
    drawerOpenRef.current = drawerOpen
    onExitedRef.current = onExited
    onInitialCommandHandledRef.current = onInitialCommandHandled
  }, [active, drawerOpen, onExited, onInitialCommandHandled])

  useEffect(() => {
    if (!hostRef.current || bundleRef.current) {
      return
    }

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", "Consolas", monospace',
      fontSize,
      lineHeight: 1.25,
      theme: {
        background: '#000000',
        foreground: '#f3f4f6',
        cursor: '#f3f4f6',
        selectionBackground: 'rgba(148, 163, 184, 0.28)'
      }
    })
    const fit = new FitAddon()

    term.loadAddon(fit)
    term.open(hostRef.current)
    bundleRef.current = { term, fit }

    function syncTerminalSize(): Promise<void> {
      fit.fit()
      return resizeAwsTerminal(tab.id, term.cols, term.rows)
    }

    function resizeAndSendInput(data: string): Promise<void> {
      return Promise.resolve().then(async () => {
        await syncTerminalSize()
        await sendAwsTerminalInput(tab.id, normalizeTerminalInput(data))
      })
    }

    function normalizeTerminalInput(data: string): string {
      return data.replace(/\x08/g, '\x7f')
    }

    function isBackspaceKey(event: KeyboardEvent): boolean {
      return event.code === 'Backspace'
        || event.key === 'Backspace'
        || (event.key === 'Delete' && event.location === 0 && event.code !== 'Delete')
    }

    term.attachCustomKeyEventHandler((event) => {
      if (event.type === 'keydown' && isBackspaceKey(event)) {
        void resizeAndSendInput('\x7f')
        return false
      }

      if (event.type === 'keydown' && event.code === 'Delete') {
        void resizeAndSendInput('\x1b[3~')
        return false
      }

      return true
    })

    const inputDisposable = term.onData((data) => {
      void resizeAndSendInput(data)
    })

    const unsubscribe = subscribeToAwsTerminal((event: TerminalEvent) => {
      if (event.sessionId !== tab.id) {
        return
      }

      if (event.type === 'output') {
        term.write(event.text)
        return
      }

      onExitedRef.current(tab.id, event.code)
    })

    const observer = new ResizeObserver(() => {
      if (activeRef.current && drawerOpenRef.current) {
        void syncTerminalSize()
      }
    })
    observer.observe(hostRef.current)

    void openProviderTerminal(tab.id, tab.target, initialCommandRef.current).then(async (result) => {
      if (result.history) {
        term.write(result.history)
      }

      onInitialCommandHandledRef.current()
      if (activeRef.current && drawerOpenRef.current) {
        await syncTerminalSize()
        term.focus()
      }
    })

    return () => {
      observer.disconnect()
      unsubscribe()
      inputDisposable.dispose()
      term.dispose()
      bundleRef.current = null
    }
  }, [fontSize, tab.id, tab.target])

  useEffect(() => {
    if (!active || !drawerOpen || !bundleRef.current) {
      return
    }

    bundleRef.current.fit.fit()
    void resizeAwsTerminal(tab.id, bundleRef.current.term.cols, bundleRef.current.term.rows)
    bundleRef.current.term.focus()
  }, [active, drawerOpen, tab.id])

  return <div ref={hostRef} className={`terminal-surface ${active ? 'is-active' : 'is-hidden'}`} />
}

export function ProviderTerminalPanel({
  target,
  open,
  onClose,
  defaultCommand,
  fontSize = 13
}: {
  target: ProviderTerminalTarget
  open: boolean
  onClose: () => void
  defaultCommand?: string
  fontSize?: number
}) {
  const tabsRef = useRef<TerminalTab[]>([])
  const resizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [panelHeight, setPanelHeight] = useState<number>(() => {
    if (typeof window === 'undefined') {
      return DEFAULT_PANEL_HEIGHT
    }

    const saved = window.localStorage.getItem(HEIGHT_STORAGE_KEY)
    return saved ? clampPanelHeight(Number(saved)) : DEFAULT_PANEL_HEIGHT
  })
  const [initialCommandByTab, setInitialCommandByTab] = useState<Record<string, string | undefined>>({})

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  useEffect(() => {
    window.localStorage.setItem(HEIGHT_STORAGE_KEY, String(panelHeight))
  }, [panelHeight])

  useEffect(() => {
    if (!open || tabsRef.current.length > 0) {
      return
    }

    const tabId = createTab(target, defaultCommand)
    setActiveTabId(tabId)
  }, [defaultCommand, open, target])

  useEffect(() => {
    const existing = tabsRef.current.find((tab) => tab.id === activeTabId)
    if (!open || !existing || matchesTarget(existing.target, target)) {
      return
    }

    void updateProviderTerminalContext(existing.id, target)
    setTabs((current) =>
      current.map((tab) =>
        tab.id === existing.id
          ? {
              ...tab,
              target,
              title: target.label
            }
          : tab
      )
    )
  }, [activeTabId, open, target])

  useEffect(() => {
    return () => {
      void closeAwsTerminal()
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [])

  function createTab(nextTarget: ProviderTerminalTarget, initialCommand?: string): string {
    const id = makeTerminalId()
    const duplicateCount = tabsRef.current.filter((tab) => tab.target.label === nextTarget.label).length
    const nextTab: TerminalTab = {
      id,
      target: nextTarget,
      title: makeTabLabel(nextTarget, duplicateCount),
      status: 'starting',
      exitCode: null
    }

    tabsRef.current = [...tabsRef.current, nextTab]
    setTabs(tabsRef.current)
    if (initialCommand) {
      setInitialCommandByTab((current) => ({ ...current, [id]: initialCommand }))
    }

    return id
  }

  function handlePointerMove(event: PointerEvent): void {
    const state = resizeStateRef.current
    if (!state) {
      return
    }

    setPanelHeight(clampPanelHeight(state.startHeight + (state.startY - event.clientY)))
  }

  function handlePointerUp(): void {
    resizeStateRef.current = null
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
  }

  function startResize(event: ReactPointerEvent<HTMLDivElement>): void {
    resizeStateRef.current = {
      startY: event.clientY,
      startHeight: panelHeight
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }

  function handleCreateTab(): void {
    const tabId = createTab(target)
    setActiveTabId(tabId)
  }

  async function handleCloseTab(sessionId: string): Promise<void> {
    await closeAwsTerminal(sessionId)
    setInitialCommandByTab((current) => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
    setTabs((current) => {
      const nextTabs = current.filter((tab) => tab.id !== sessionId)
      if (activeTabId === sessionId) {
        setActiveTabId(nextTabs.at(-1)?.id ?? null)
      }
      tabsRef.current = nextTabs
      return nextTabs
    })
  }

  function handleInitialCommandHandled(sessionId: string): void {
    setInitialCommandByTab((current) => {
      if (!(sessionId in current)) {
        return current
      }

      const next = { ...current }
      delete next[sessionId]
      return next
    })
    setTabs((current) =>
      current.map((tab) =>
        tab.id === sessionId
          ? {
              ...tab,
              status: tab.status === 'starting' ? 'running' : tab.status
            }
          : tab
      )
    )
  }

  function handleExited(sessionId: string, code: number | null): void {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === sessionId
          ? {
              ...tab,
              status: 'exited',
              exitCode: code
            }
          : tab
      )
    )
  }

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const activeStatusLabel =
    activeTab?.status === 'exited'
      ? `Exited${activeTab.exitCode === null ? '' : ` (${activeTab.exitCode})`}`
      : activeTab?.status === 'starting'
        ? 'Starting'
        : ''

  return (
    <section
      className={`terminal-drawer panel ${open ? 'is-open' : 'is-hidden'}`}
      style={{ height: `${panelHeight}px` }}
      aria-hidden={!open}
    >
      <div className="terminal-resize-handle" onPointerDown={startResize} />
      <div className="terminal-toolbar">
        <div className="terminal-tabs" role="tablist" aria-label="Terminal tabs">
          {tabs.map((tab) => {
            const isActive = tab.id === activeTabId

            return (
              <div key={tab.id} className={`terminal-tab ${isActive ? 'is-active' : ''}`}>
                <button
                  type="button"
                  className="terminal-tab-button"
                  role="tab"
                  aria-selected={isActive}
                  onClick={() => setActiveTabId(tab.id)}
                >
                  <span>{tab.title}</span>
                </button>
                <button
                  type="button"
                  className="terminal-tab-close"
                  aria-label={`Close ${tab.title}`}
                  onClick={() => void handleCloseTab(tab.id)}
                >
                  x
                </button>
              </div>
            )
          })}
          <button
            type="button"
            className="terminal-toolbar-button is-add"
            onClick={handleCreateTab}
            aria-label="Open new terminal tab"
            title="New tab"
          >
            +
          </button>
        </div>
        <div className="terminal-toolbar-actions">
          {activeStatusLabel ? <span className="terminal-status-badge">{activeStatusLabel}</span> : null}
          <button type="button" className="terminal-toolbar-button" onClick={onClose} aria-label="Hide terminal" title="Hide terminal">
            v
          </button>
        </div>
      </div>

      {tabs.length === 0 ? (
        <div className="terminal-empty-state">
          <p>Open a terminal tab.</p>
          <button type="button" className="terminal-toolbar-button" onClick={handleCreateTab}>
            +
          </button>
        </div>
      ) : (
        <div className="terminal-stack">
          {tabs.map((tab) => (
            <TerminalTabSurface
              key={tab.id}
              tab={tab}
              active={tab.id === activeTabId}
              drawerOpen={open}
              fontSize={fontSize}
              initialCommand={initialCommandByTab[tab.id]}
              onInitialCommandHandled={() => handleInitialCommandHandled(tab.id)}
              onExited={handleExited}
            />
          ))}
        </div>
      )}
    </section>
  )
}
