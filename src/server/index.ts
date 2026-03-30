/**
 * AWS Lens web server — wraps all Electron IPC handlers as an HTTP RPC endpoint.
 *
 * Architecture:
 *   POST /api/rpc          { channel, args[] }  → handler result
 *   GET  /api/health       → { ok: true }
 *   WS   /api/terminal     → node-pty session (proxied via ws)
 *   GET  /*                → React SPA (served from /public)
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
registerIpcHandlers(() => null)

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
    res.status(500).json({ ok: false, error: message, channel })
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

const wss = new WebSocketServer({ server, path: '/api/terminal' })

wss.on('connection', (ws) => {
  let pty: ReturnType<typeof spawn> | null = null

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        type: 'open' | 'input' | 'resize' | 'close'
        cols?: number
        rows?: number
        data?: string
      }

      if (msg.type === 'open') {
        const shell = process.env.SHELL ?? '/bin/bash'
        pty = spawn(shell, [], {
          name: 'xterm-color',
          cols: msg.cols ?? 120,
          rows: msg.rows ?? 24,
          cwd: process.env.HOME ?? '/',
          env: { ...process.env } as Record<string, string>
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
