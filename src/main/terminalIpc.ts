import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { spawn, type IPty } from 'node-pty'

import type { AwsConnection } from '@shared/types'
import { buildAwsContextCommand, getShellConfig, getTerminalCwd } from './shell'
import { getConnectionEnv } from './sessionHub'

type TerminalEvent =
  | { type: 'output'; text: string }
  | { type: 'exit'; code: number | null }

type TerminalSession = {
  pty: IPty
  ownerId: number
  contextKey: string
}

let session: TerminalSession | null = null

function emitToOwner(ownerId: number, payload: TerminalEvent): void {
  const window = BrowserWindow.getAllWindows().find((entry) => entry.webContents.id === ownerId)
  window?.webContents.send('terminal:event', payload)
}

function getContextKey(connection: AwsConnection): string {
  return `${connection.sessionId}:${connection.region}`
}

function buildContextCommand(connection: AwsConnection): string {
  return buildAwsContextCommand(connection)
}

function updateContext(connection: AwsConnection): void {
  if (!session) {
    return
  }

  const nextKey = getContextKey(connection)
  if (session.contextKey === nextKey) {
    return
  }

  session.contextKey = nextKey
  session.pty.write(`${buildContextCommand(connection)}\r`)
}

function runCommandInSession(targetSession: TerminalSession, command: string, delayMs = 0): void {
  const normalized = command.trim()
  if (!normalized) {
    return
  }

  const write = () => {
    if (session?.pty !== targetSession.pty) {
      return
    }
    targetSession.pty.write(`${normalized}\r`)
  }

  if (delayMs > 0) {
    setTimeout(write, delayMs)
    return
  }

  write()
}

function createSession(sender: WebContents, connection: AwsConnection): TerminalSession {
  const shell = getShellConfig()
  const pty = spawn(shell.command, shell.args, {
    name: 'xterm-color',
    cols: 120,
    rows: 24,
    cwd: getTerminalCwd(),
    env: {
      ...process.env,
      ...getConnectionEnv(connection),
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      PYTHONIOENCODING: 'utf-8'
    }
  })

  const nextSession: TerminalSession = {
    pty,
    ownerId: sender.id,
    contextKey: getContextKey(connection)
  }

  pty.onData((text) => {
    emitToOwner(nextSession.ownerId, { type: 'output', text })
  })

  pty.onExit(({ exitCode }) => {
    if (session?.pty === pty) {
      session = null
    }
    emitToOwner(nextSession.ownerId, { type: 'exit', code: exitCode })
  })

  pty.write(`${buildContextCommand(connection)}\r`)
  return nextSession
}

function ensureSession(sender: WebContents, connection: AwsConnection): TerminalSession {
  if (!session) {
    session = createSession(sender, connection)
    return session
  }

  session.ownerId = sender.id
  updateContext(connection)
  return session
}

export function registerTerminalIpcHandlers(): void {
  ipcMain.handle('terminal:open-aws', async (event, connection: AwsConnection, initialCommand?: string) => {
    const currentSession = ensureSession(event.sender, connection)
    runCommandInSession(currentSession, initialCommand ?? '', 120)
  })

  ipcMain.handle('terminal:update-aws-context', async (_event, connection: AwsConnection) => {
    updateContext(connection)
  })

  ipcMain.handle('terminal:input', async (_event, input: string) => {
    if (!session) {
      throw new Error('Terminal is not running.')
    }

    session.pty.write(input)
  })

  ipcMain.handle('terminal:run-command', async (_event, command: string) => {
    if (!session) {
      throw new Error('Terminal is not running.')
    }

    runCommandInSession(session, command)
  })

  ipcMain.handle('terminal:resize', async (_event, cols: number, rows: number) => {
    if (!session) {
      return
    }

    session.pty.resize(Math.max(20, cols), Math.max(8, rows))
  })

  ipcMain.handle('terminal:close', async () => {
    if (!session) {
      return
    }

    const current = session
    session = null
    current.pty.kill()
  })
}
