import { useEffect, useRef, useState } from 'react'

import { FitAddon } from 'xterm-addon-fit'
import { Terminal } from 'xterm'

import type { AwsConnection } from '@shared/types'
import {
  closeAwsTerminal,
  openAwsTerminal,
  resizeAwsTerminal,
  runAwsTerminalCommand,
  sendAwsTerminalInput,
  subscribeToAwsTerminal,
  updateAwsTerminalContext,
  type TerminalEvent
} from './api'

type TerminalBundle = {
  term: Terminal
  fit: FitAddon
}

export function AwsTerminalPanel({
  connection,
  open,
  onClose,
  commandToRun,
  onCommandHandled
}: {
  connection: AwsConnection | null
  open: boolean
  onClose: () => void
  commandToRun: { id: number; command: string } | null
  onCommandHandled: (id: number) => void
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const bundleRef = useRef<TerminalBundle | null>(null)
  const sessionKeyRef = useRef('')
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (!open || !hostRef.current || bundleRef.current) {
      return
    }

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", "Consolas", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      theme: {
        background: '#071015',
        foreground: '#dfeff7',
        cursor: '#f58540',
        selectionBackground: 'rgba(223, 105, 42, 0.18)'
      }
    })
    const fit = new FitAddon()

    term.loadAddon(fit)
    term.open(hostRef.current)
    fit.fit()
    term.focus()
    bundleRef.current = { term, fit }

    const writeEvent = (event: TerminalEvent) => {
      if (event.type === 'output') {
        term.write(event.text)
        return
      }

      term.writeln(`\r\n[terminal exited with code ${event.code ?? 'null'}]`)
      setRunning(false)
      sessionKeyRef.current = ''
    }

    const unsubscribe = subscribeToAwsTerminal(writeEvent)
    const disposable = term.onData((data) => {
      void resizeAndSendInput(data)
    })

    const observer = new ResizeObserver(() => {
      void syncTerminalSize()
    })
    observer.observe(hostRef.current)

    function syncTerminalSize(): Promise<void> {
      fit.fit()
      return resizeAwsTerminal(term.cols, term.rows)
    }

    function resizeAndSendInput(data: string): Promise<void> {
      return Promise.resolve().then(async () => {
        await syncTerminalSize()
        await sendAwsTerminalInput(data)
      })
    }

    void syncTerminalSize()

    return () => {
      observer.disconnect()
      disposable.dispose()
      unsubscribe()
      term.dispose()
      bundleRef.current = null
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    bundleRef.current?.term.focus()
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }

    if (!connection) {
      sessionKeyRef.current = ''
      setRunning(false)
      return
    }

    const nextKey = `${connection.sessionId}:${connection.region}`
    if (!running) {
      sessionKeyRef.current = nextKey
      const initialCommand = commandToRun?.command
      void openAwsTerminal(connection, initialCommand).then(async () => {
        if (commandToRun) {
          onCommandHandled(commandToRun.id)
        }
        setRunning(true)
        bundleRef.current?.fit.fit()
        if (bundleRef.current) {
          await resizeAwsTerminal(bundleRef.current.term.cols, bundleRef.current.term.rows)
          bundleRef.current.term.focus()
        }
      })
      return
    }

    if (sessionKeyRef.current !== nextKey) {
      sessionKeyRef.current = nextKey
      void updateAwsTerminalContext(connection)
    }
  }, [commandToRun, connection, onCommandHandled, open, running])

  useEffect(() => {
    if (!open || !running || !connection || !commandToRun) {
      return
    }

    const nextKey = `${connection.sessionId}:${connection.region}`
    if (sessionKeyRef.current !== nextKey) {
      return
    }

    void runAwsTerminalCommand(commandToRun.command).then(() => {
      onCommandHandled(commandToRun.id)
      bundleRef.current?.term.focus()
    })
  }, [commandToRun, connection, onCommandHandled, open, running])

  async function handleClose(): Promise<void> {
    setRunning(false)
    sessionKeyRef.current = ''
    await closeAwsTerminal()
    onClose()
  }

  if (!open) {
    return null
  }

  return (
    <section className="terminal-drawer panel">
      <div className="terminal-header">
        <div>
          <div className="eyebrow">Terminal</div>
          <h3>AWS CLI Shell</h3>
          <p className="terminal-meta">
            {connection ? `${connection.label} · ${connection.region}` : 'Select a profile and region to start the terminal.'}
          </p>
        </div>
        <div className="button-row terminal-actions">
          <button type="button" className="terminal-button" onClick={() => bundleRef.current?.term.focus()}>
            Focus
          </button>
          <button type="button" className="terminal-button" onClick={() => void handleClose()}>
            Close
          </button>
        </div>
      </div>
      <div ref={hostRef} className="terminal-surface" />
    </section>
  )
}
