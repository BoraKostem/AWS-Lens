/**
 * Terraform event bus for web mode.
 *
 * In Electron mode, terraform command events are pushed via
 * `window.webContents.send('terraform:event', payload)`.
 * In web mode there is no BrowserWindow, so this module provides:
 *
 *   1. broadcastTerraformEvent() — called by a mock BrowserWindow returned
 *      from makeMockWindow(), which is passed as getWindow() to registerIpcHandlers()
 *   2. onTerraformEvent() / offTerraformEvent() — used by the WebSocket handler
 *      in index.ts to push events to connected clients
 */

import { EventEmitter } from 'node:events'

const bus = new EventEmitter()
bus.setMaxListeners(200)

export function broadcastTerraformEvent(channel: string, payload: unknown): void {
  bus.emit(channel, payload)
}

export function onTerraformEvent(channel: string, handler: (payload: unknown) => void): void {
  bus.on(channel, handler)
}

export function offTerraformEvent(channel: string, handler: (payload: unknown) => void): void {
  bus.off(channel, handler)
}

/**
 * Returns a mock BrowserWindow whose webContents.send() publishes
 * to the internal event bus instead of Electron's IPC.
 */
export function makeMockWindow() {
  return {
    webContents: {
      send(channel: string, payload: unknown): void {
        broadcastTerraformEvent(channel, payload)
      }
    }
  }
}
