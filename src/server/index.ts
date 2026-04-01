/**
 * AWS Lens web server — wraps all Electron IPC handlers as an HTTP RPC endpoint.
 *
 * Architecture:
 *   POST /api/rpc               { channel, args[] }  → handler result
 *   GET  /api/health            → { ok: true }
 *   WS   /api/terminal          → node-pty session (proxied via ws)
 *   WS   /api/events             → streaming push events (terraform, ec2, ...)
 *   GET  /*                     → React SPA (served from /public)
 */

import http from 'node:http'
import path from 'node:path'
import url from 'node:url'

// -- Bootstrap AWS profiles from env vars before anything else
import { bootstrapProfiles } from './bootstrapProfiles'
bootstrapProfiles()

// -- Import shim FIRST so webRegistry is populated before any ipcMain.handle calls
import { webRegistry } from './electronShim'

// -- Import all ipc registration functions (they call ipcMain.handle → webRegistry.set)
import { registerAwsIpcHandlers } from '../main/awsIpc'
import { registerEc2IpcHandlers } from '../main/ec2Ipc'
import { registerEcrIpcHandlers } from '../main/ecrIpc'
import { registerEksIpcHandlers } from '../main/eksIpc'
import { registerOverviewIpcHandlers } from '../main/overviewIpc'
import { registerSecurityIpcHandlers } from '../main/securityIpc'
import { registerServiceIpcHandlers } from '../main/serviceIpc'
import { registerSgIpcHandlers } from '../main/sgIpc'
import { registerVpcIpcHandlers } from '../main/vpcIpc'
import { registerCompareIpcHandlers } from '../main/compareIpc'
import { registerComplianceIpcHandlers } from '../main/complianceIpc'
import { registerIpcHandlers } from '../main/ipc'
import { registerTerminalIpcHandlers } from '../main/terminalIpc'
import { makeMockWindow, onEvent, offEvent } from './terraformEvents'
import { githubAuthRouter } from './githubAuth'
import { buildAwsContextCommand, getShellConfig } from '../main/shell'
import { getConnectionEnv } from '../main/sessionHub'
import type { AwsConnection } from '@shared/types'

// Register all handlers into webRegistry
registerAwsIpcHandlers()
registerEc2IpcHandlers()
registerEcrIpcHandlers()
registerEksIpcHandlers()
registerOverviewIpcHandlers()
registerSecurityIpcHandlers()
registerServiceIpcHandlers()
registerSgIpcHandlers()
registerVpcIpcHandlers()
registerCompareIpcHandlers()
registerComplianceIpcHandlers()

// Pass a mock BrowserWindow so terraform emit() calls reach the event bus
const mockWindow = makeMockWindow()
registerIpcHandlers(() => mockWindow as never)

// Terminal IPC uses Electron events — skip in web mode (WebSocket handles it directly)
// registerTerminalIpcHandlers()

import express from 'express'
import { WebSocketServer } from 'ws'
import { spawn } from 'node-pty'

const PORT = parseInt(process.env.PORT ?? '3000', 10)
const __dirname = path.dirname(url.fileURLToPath(import.meta.url))
// Renderer builds to out/renderer/public/renderer/ (electron-vite outDir structure)
// In Docker: out/public/renderer/ (copied from builder)
const PUBLIC_DIR = path.join(
  __dirname,
  process.env.NODE_ENV === 'production' ? '../public/renderer' : '../../renderer/public/renderer'
)

const app = express()
app.use(express.json({ limit: '4mb' }))

// ── GitHub Device OAuth ──────────────────────────────────────────────────────
app.use('/api/github/auth', githubAuthRouter())

// ── Health ──────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, channels: webRegistry.size })
})

// ── RPC ─────────────────────────────────────────────────────────────────────
app.post('/api/rpc', async (req, res) => {
  const { channel, args } = req.body as { channel: string; args: unknown[] }

  if (!channel) {
    res.status(400).json({ ok: false, error: 'Missing channel' })
    return
  }

  const handler = webRegistry.get(channel)
  if (!handler) {
    res.status(404).json({ ok: false, error: `Unknown channel: ${channel}` })
    return
  }

  try {
    const result = await handler(...(args ?? []))
    res.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[rpc] ${channel} failed:`, message)
    // Return the AWS/app error message (needed by UI) but not the channel name
    res.status(500).json({ ok: false, error: message })
  }
})

// ── Static SPA ──────────────────────────────────────────────────────────────
app.use(express.static(PUBLIC_DIR))
// Express 5: use wildcard pattern instead of '*'
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'))
})

// ── HTTP + WebSocket server ──────────────────────────────────────────────────
const server = http.createServer(app)

// ── Push event stream WebSocket ─────────────────────────────────────────────
// Multiplexes all server-side push events (terraform, ec2, etc.) to clients.
// Messages: { channel: string, payload: unknown }
const eventsWss = new WebSocketServer({ server, path: '/api/events' })

const PUSH_CHANNELS = [
  'terraform:event',
  'ec2:temp-volume-progress',
]

eventsWss.on('connection', (ws) => {
  const handlers: Array<{ channel: string; fn: (payload: unknown) => void }> = []

  for (const channel of PUSH_CHANNELS) {
    const fn = (payload: unknown) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ channel, payload }))
      }
    }
    onEvent(channel, fn)
    handlers.push({ channel, fn })
  }

  ws.on('close', () => {
    for (const { channel, fn } of handlers) offEvent(channel, fn)
  })
})

// ── Terminal WebSocket ───────────────────────────────────────────────────────
// Protocol mirrors the Electron terminal IPC handlers in terminalIpc.ts:
//   { type: 'open', connection?, initialCommand?, cols?, rows? }
//     → spawns a pty using the same shell config and AWS context injection as
//       the desktop app (buildAwsContextCommand / getConnectionEnv)
//   { type: 'update-context', connection }
//     → writes a new AWS context command into the running pty
//   { type: 'run-command', command }
//     → writes a command into the running pty (equivalent to terminal:run-command)
//   { type: 'input', data }  → raw keystrokes
//   { type: 'resize', cols, rows }
//   { type: 'close' }
//
// Server → client: { type: 'output', text } | { type: 'exit', code }
const wss = new WebSocketServer({ server, path: '/api/terminal' })

wss.on('connection', (ws) => {
  let pty: ReturnType<typeof spawn> | null = null

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type: 'open' | 'input' | 'resize' | 'close' | 'update-context' | 'run-command'
        cols?: number
        rows?: number
        data?: string
        command?: string
        connection?: AwsConnection
        initialCommand?: string
      }

      if (msg.type === 'open') {
        const shellCfg = getShellConfig()
        // Merge AWS connection env vars if a connection was provided, matching
        // the behaviour of createSession() in terminalIpc.ts
        const connectionEnv = msg.connection ? getConnectionEnv(msg.connection) : {}
        pty = spawn(shellCfg.command, shellCfg.args, {
          name: 'xterm-color',
          cols: msg.cols ?? 120,
          rows: msg.rows ?? 24,
          cwd: process.env.HOME ?? '/',
          env: {
            ...process.env,
            ...connectionEnv,
            LANG: 'en_US.UTF-8',
            LC_ALL: 'en_US.UTF-8',
            PYTHONIOENCODING: 'utf-8'
          } as Record<string, string>
        })

        pty.onData((text) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'output', text }))
          }
        })

        pty.onExit(({ exitCode }) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', code: exitCode }))
          }
        })

        // Inject AWS context and optional initial command after the shell starts,
        // replicating createSession()'s pty.write(buildAwsContextCommand()) call
        if (msg.connection) {
          const contextCmd = buildAwsContextCommand(msg.connection)
          setTimeout(() => {
            pty?.write(`${contextCmd}\r`)
            if (msg.initialCommand) {
              setTimeout(() => pty?.write(`${msg.initialCommand}\r`), 120)
            }
          }, 120)
        } else if (msg.initialCommand) {
          setTimeout(() => pty?.write(`${msg.initialCommand}\r`), 200)
        }
      } else if (msg.type === 'update-context' && pty && msg.connection) {
        // Mirror terminalIpc.ts updateContext(): write new AWS env vars into the running shell
        const contextCmd = buildAwsContextCommand(msg.connection)
        pty.write(`${contextCmd}\r`)
      } else if (msg.type === 'run-command' && pty && msg.command) {
        const normalized = msg.command.trim()
        if (normalized) pty.write(`${normalized}\r`)
      } else if (msg.type === 'input' && pty && msg.data) {
        pty.write(msg.data)
      } else if (msg.type === 'resize' && pty) {
        pty.resize(Math.max(20, msg.cols ?? 120), Math.max(8, msg.rows ?? 24))
      } else if (msg.type === 'close' && pty) {
        pty.kill()
        pty = null
      }
    } catch {
      // ignore malformed messages
    }
  })

  ws.on('close', () => {
    pty?.kill()
    pty = null
  })
})

server.listen(PORT, () => {
  console.log(`[aws-lens] web server listening on :${PORT}`)
  console.log(`[aws-lens] ${webRegistry.size} RPC channels registered`)
})
